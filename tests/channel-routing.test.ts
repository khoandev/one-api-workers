import { beforeEach, expect, test } from "bun:test";
import { Context } from "hono";

import db from "../src/db";
import { normalizeChannelConfig } from "../src/channel-config";
import {
    DEFAULT_CHANNEL_ROUTING_CONFIG,
    DEFAULT_SYSTEM_CONFIG,
    getSystemConfig,
    normalizeChannelRoutingConfig,
    normalizeSystemConfig,
    saveSystemConfig,
} from "../src/system-config";
import { createTestDatabase } from "./helpers/sqlite-d1";
import {
    markChannelFailure,
    markChannelSuccess,
    resetChannelSelectionState,
    selectChannel,
} from "../src/providers/shared/channel-selection";
import {
    executeChannelWithRetries,
    executeWithFallbackChannels,
} from "../src/providers/shared/upstream-retry";
import type { ResolvedChannelCandidate } from "../src/providers/shared/channel-resolver";
import type { ProviderFetch } from "../src/providers/shared/provider-registry";

beforeEach(() => {
    resetChannelSelectionState();
});

const routing = (overrides: Partial<ChannelRoutingConfig> = {}): ChannelRoutingConfig => ({
    ...DEFAULT_CHANNEL_ROUTING_CONFIG,
    retryBackoffMs: 0,
    cooldownMs: 0,
    ...overrides,
});

const candidate = (
    key: string,
    weight = 0,
    configOverrides: Partial<ChannelConfig> = {},
): ResolvedChannelCandidate => ({
    key,
    config: normalizeChannelConfig({
        name: key,
        type: "openai",
        endpoint: "https://upstream.test/v1",
        weight,
        api_keys: ["key-1"],
        models: [{ id: `${key}-upstream`, name: `${key}-model` }],
        ...configOverrides,
    }),
    mapping: { id: `${key}-upstream`, name: `${key}-model` },
});

const newContext = () =>
    new Context<HonoCustomType>(new Request("http://localhost/v1/chat/completions", { method: "POST" }));

test("system config carries default routing and spreads legacy configs", () => {
    expect(normalizeSystemConfig({}).routing).toEqual(DEFAULT_CHANNEL_ROUTING_CONFIG);
    expect(normalizeSystemConfig({ routing: DEFAULT_CHANNEL_ROUTING_CONFIG }).routing).toEqual(
        DEFAULT_CHANNEL_ROUTING_CONFIG,
    );
});

test("routing values are clamped to their documented bounds", () => {
    const clamped = normalizeChannelRoutingConfig({
        strategy: "weighted",
        maxRetries: 99,
        maxFallbacks: -4,
        retryBackoffMs: 99_999,
        cooldownMs: -1,
    });

    expect(clamped.strategy).toBe("weighted");
    expect(clamped.maxRetries).toBe(10);
    expect(clamped.maxFallbacks).toBe(0);
    expect(clamped.retryBackoffMs).toBe(5000);
    expect(clamped.cooldownMs).toBe(0);
});

test("retry status codes are deduped and sorted, empty list stays empty", () => {
    expect(normalizeChannelRoutingConfig({ retryStatusCodes: [503, 429, 429, 500] }).retryStatusCodes)
        .toEqual([429, 500, 503]);
    expect(normalizeChannelRoutingConfig({ retryStatusCodes: [] }).retryStatusCodes).toEqual([]);
    expect(normalizeChannelRoutingConfig({ retryStatusCodes: [99, 600, 200] }).retryStatusCodes)
        .toEqual([200]);
    expect(normalizeChannelRoutingConfig({}).retryStatusCodes)
        .toEqual(DEFAULT_CHANNEL_ROUTING_CONFIG.retryStatusCodes);
});

test("routing settings persist and reload unchanged, including an empty status list", async () => {
    const fixture = createTestDatabase();
    try {
        await db.migrate(fixture.context);

        const stored: ChannelRoutingConfig = {
            strategy: "weighted",
            maxRetries: 5,
            maxFallbacks: 2,
            retryBackoffMs: 400,
            cooldownMs: 60_000,
            retryStatusCodes: [429, 500, 503],
        };
        await saveSystemConfig(fixture.context, { ...DEFAULT_SYSTEM_CONFIG, routing: stored });
        expect((await getSystemConfig(fixture.context)).routing).toEqual(stored);

        await saveSystemConfig(fixture.context, {
            ...DEFAULT_SYSTEM_CONFIG,
            routing: { ...stored, retryStatusCodes: [] },
        });
        expect((await getSystemConfig(fixture.context)).routing.retryStatusCodes).toEqual([]);
    } finally {
        fixture.close();
    }
});

test("unknown strategy falls back to priority", () => {
    const normalized = normalizeChannelRoutingConfig({
        strategy: "chaos" as unknown as ChannelRoutingStrategy,
    });

    expect(normalized.strategy).toBe("priority");
});

test("priority strategy picks inside the highest weight tier", () => {
    const channels = [candidate("a", 0), candidate("b", 3), candidate("c", 3)];

    expect(selectChannel(channels, "priority", { random: () => 0 }).key).toBe("b");
    expect(selectChannel(channels, "priority", { random: () => 0.99 }).key).toBe("c");
});

test("weighted strategy scales selection chance by weight plus one", () => {
    const channels = [candidate("a", 0), candidate("b", 5)];

    expect(selectChannel(channels, "weighted", { random: () => 0 }).key).toBe("a");
    expect(selectChannel(channels, "weighted", { random: () => 0.99 }).key).toBe("b");
});

test("round-robin strategy rotates through every channel in key order", () => {
    const channels = [candidate("c"), candidate("a"), candidate("b")];

    expect(selectChannel(channels, "round-robin").key).toBe("a");
    expect(selectChannel(channels, "round-robin").key).toBe("b");
    expect(selectChannel(channels, "round-robin").key).toBe("c");
    expect(selectChannel(channels, "round-robin").key).toBe("a");
});

test("failing channels cool down and recover after the cooldown window", () => {
    const channels = [candidate("a"), candidate("b")];

    markChannelFailure("a", 1000, 1000);
    expect(selectChannel(channels, "priority", { now: 1500, random: () => 0 }).key).toBe("b");
    expect(selectChannel(channels, "priority", { now: 2001, random: () => 0 }).key).toBe("a");

    markChannelFailure("a", 1000, 3000);
    markChannelSuccess("a");
    expect(selectChannel(channels, "priority", { now: 3100, random: () => 0 }).key).toBe("a");
});

test("selecting ignores cooldown when every channel is cooling down", () => {
    const channels = [candidate("a"), candidate("b")];

    markChannelFailure("a", 1000, 1000);
    markChannelFailure("b", 1000, 1000);

    expect(selectChannel(channels, "priority", { now: 1100, random: () => 0 }).key).toBe("a");
});

test("retries retryable statuses until the upstream succeeds", async () => {
    const channel = candidate("a");
    const statuses = [500, 500, 200];
    let calls = 0;
    const provider: ProviderFetch = async () => {
        const status = statuses[calls];
        calls += 1;
        return new Response(status === 200 ? "ok" : "boom", { status });
    };
    const trackingState: RequestTrackingState = { retryCount: 0 };

    const result = await executeChannelWithRetries(
        newContext(),
        channel,
        { model: "a-model" },
        async () => {},
        trackingState,
        provider,
        "chat-completions",
        routing({ retryStatusCodes: [500] }),
    );

    expect(calls).toBe(3);
    expect(result.response.ok).toBe(true);
    expect(result.shouldFallback).toBe(false);
    expect(trackingState.retryCount).toBe(2);
});

test("non retryable statuses fail fast without failover", async () => {
    let calls = 0;
    const provider: ProviderFetch = async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
    };

    const result = await executeChannelWithRetries(
        newContext(),
        candidate("a"),
        { model: "a-model" },
        async () => {},
        { retryCount: 0 },
        provider,
        "chat-completions",
        routing({ retryStatusCodes: [500] }),
    );

    expect(calls).toBe(1);
    expect(result.shouldFallback).toBe(false);
    expect(result.errorCode).toBe("http_400");
});

test("channels without auto retry are attempted once", async () => {
    let calls = 0;
    const provider: ProviderFetch = async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
    };

    const result = await executeChannelWithRetries(
        newContext(),
        candidate("a", 0, { auto_retry: false }),
        { model: "a-model" },
        async () => {},
        { retryCount: 0 },
        provider,
        "chat-completions",
        routing({ retryStatusCodes: [500] }),
    );

    expect(calls).toBe(1);
    expect(result.shouldFallback).toBe(true);
});

const runFallbacks = async (maxFallbacks: number) => {
    const visited: string[] = [];

    const response = await executeWithFallbackChannels(
        newContext(),
        [candidate("a", 0, { type: null }), candidate("b", 0, { type: null })],
        candidate("a", 0, { type: null }),
        { model: "a-model" },
        async () => {},
        () => {},
        { retryCount: 0 },
        (channel) => {
            visited.push(channel.key);
        },
        "chat-completions",
        routing({ maxFallbacks }),
    );

    return { visited, status: response.status };
};

test("fallback channels respect the configured fallback limit", async () => {
    expect(await runFallbacks(0)).toEqual({ visited: ["a"], status: 400 });
    resetChannelSelectionState();
    expect(await runFallbacks(1)).toEqual({ visited: ["a", "b"], status: 400 });
});
