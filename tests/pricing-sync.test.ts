import { afterAll, beforeAll, expect, test } from "bun:test";

import db from "../src/db";
import app from "../src/index";
import { createTestDatabase } from "./helpers/sqlite-d1";
import {
    MODELS_DEV_PRICING_URL,
    buildPricingSuggestions,
    collectPricingSyncTargets,
    mergePricingSuggestions,
    normalizePricingModelKey,
    type PricingSyncTarget,
} from "../src/pricing-sync";

const modelsDevPayload = {
    openai: {
        models: {
            "gpt-4o": { id: "gpt-4o", name: "GPT-4o", cost: { input: 2.5, output: 10, cache_read: 1.25 } },
        },
    },
    azure: {
        models: {
            "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } },
        },
    },
    anthropic: {
        models: {
            "claude-sonnet-4.5": {
                id: "claude-sonnet-4.5",
                name: "Claude Sonnet 4.5",
                cost: { input: 3, output: 15, cache_read: 0.3 },
            },
        },
    },
    reseller: {
        models: {
            "openai/gpt-4o": { id: "openai/gpt-4o", cost: { input: 0.5, output: 1 } },
            "gpt-4o-mini": { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
            "zero-model": { id: "zero-model", cost: { input: 0, output: 0 } },
        },
    },
};

const suggest = (targets: PricingSyncTarget[]) => buildPricingSuggestions(modelsDevPayload, targets);

test("normalizePricingModelKey collapses separators", () => {
    expect(normalizePricingModelKey("Claude Sonnet 4.5")).toBe("claude-sonnet-4-5");
});

test("collectPricingSyncTargets skips disabled channels and models", () => {
    const targets = collectPricingSyncTargets([
        {
            value: {
                type: "openai",
                endpoint: "https://api.openai.com/v1",
                api_keys: ["sk-test"],
                models: [
                    { id: "gpt-4o", name: "gpt-4o" },
                    { id: "gpt-4o-mini", name: "gpt-4o-mini", enabled: false },
                ],
            },
        },
        {
            value: {
                type: "openai",
                endpoint: "https://api.openai.com/v1",
                enabled: false,
                models: [{ id: "disabled-model", name: "disabled-model" }],
            },
        },
    ], { "stored-model": { billingMode: "volume", input: 1 } });

    expect(targets.map((target) => target.model)).toEqual(["gpt-4o", "stored-model"]);
    expect(targets[0].channelTypes).toEqual(["openai"]);
    expect(targets[1].channelTypes).toEqual([]);
});

test("official provider wins over cheaper reseller", () => {
    const preview = suggest([{ model: "gpt-4o", channelTypes: ["openai"] }]);

    expect(preview.suggestions["gpt-4o"]).toEqual({
        input: 2.5,
        output: 10,
        cache: 1.25,
        provider: "openai",
    });
    expect(preview.unmatched).toEqual([]);
    expect(preview.targetCount).toBe(1);
});

test("falls back to the cheapest positive input price", () => {
    const preview = suggest([{ model: "gpt-4o-mini", channelTypes: [] }]);

    expect(preview.suggestions["gpt-4o-mini"]).toEqual({
        input: 0.15,
        output: 0.6,
        provider: "reseller",
    });
});

test("prefix and separator variants resolve to the official provider", () => {
    const preview = suggest([{ model: "anthropic/claude-sonnet-4.5", channelTypes: ["claude"] }]);

    expect(preview.suggestions["anthropic/claude-sonnet-4.5"]).toEqual({
        input: 3,
        output: 15,
        cache: 0.3,
        provider: "anthropic",
    });
});

test("free models stay unmatched", () => {
    const preview = suggest([{ model: "zero-model", channelTypes: [] }]);

    expect(preview.suggestions["zero-model"]).toBeUndefined();
    expect(preview.unmatched).toEqual(["zero-model"]);
});

test("fill-only merge keeps existing pricing and migrates legacy request", () => {
    const { config, updated } = mergePricingSuggestions(
        {
            "gpt-4o": { billingMode: "request", input: 1 },
            "legacy": { request: 0.5 },
        },
        suggest([
            { model: "gpt-4o", channelTypes: ["openai"] },
            { model: "gpt-4o-mini", channelTypes: [] },
        ]).suggestions,
        false,
    );

    expect(updated).toEqual(["gpt-4o-mini"]);
    expect(config["gpt-4o"]).toEqual({ billingMode: "request", input: 1 });
    expect(config["legacy"]).toEqual({ billingMode: "request", input: 0.5 });
    expect(config["gpt-4o-mini"]).toEqual({ billingMode: "volume", input: 0.15, output: 0.6 });
});

test("overwrite replaces stored pricing with models.dev values", () => {
    const { config, updated } = mergePricingSuggestions(
        {
            "gpt-4o": { billingMode: "request", input: 1 },
            "legacy": { request: 0.5 },
        },
        suggest([
            { model: "gpt-4o", channelTypes: ["openai"] },
            { model: "gpt-4o-mini", channelTypes: [] },
        ]).suggestions,
        true,
    );

    expect(updated).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(config["gpt-4o"]).toEqual({ billingMode: "volume", input: 2.5, output: 10, cache: 1.25 });
    expect(config["legacy"]).toEqual({ billingMode: "request", input: 0.5 });
});

test("POST /api/admin/pricing/sync previews suggestions without writing pricing", async () => {
    const fixture = createTestDatabase();
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    try {
        await db.migrate(fixture.context);
        await fixture.database.prepare(
            `INSERT INTO channel_config (key, value) VALUES (?, ?)`,
        ).bind("openai-test", JSON.stringify({
            name: "OpenAI",
            type: "openai",
            endpoint: "https://api.openai.com/v1",
            api_keys: ["sk-test"],
            models: [{ id: "gpt-4o", name: "gpt-4o" }],
        })).run();

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            requestedUrls.push(typeof input === "string" ? input : input.toString());
            return Response.json(modelsDevPayload);
        }) as typeof fetch;

        // Test D1 shim and execution context only implement the surface the route touches.
        const env = {
            DB: fixture.database,
            ADMIN_TOKEN: "admin-token",
            USAGE_ANALYTICS: { writeDataPoint() {} },
        } as unknown as CloudflareBindings;
        const executionCtx = {
            waitUntil() {},
            passThroughOnException() {},
        } as unknown as ExecutionContext;

        const response = await app.fetch(
            new Request("http://localhost/api/admin/pricing/sync", {
                method: "POST",
                headers: { "x-admin-token": "admin-token" },
            }),
            env,
            executionCtx,
        );

        expect(response.status).toBe(200);
        const body = await response.json() as {
            data: { suggestions: Record<string, { input: number; output: number; cache?: number; provider: string }> };
        };
        expect(body.data.suggestions["gpt-4o"]).toEqual({
            input: 2.5,
            output: 10,
            cache: 1.25,
            provider: "openai",
        });
        expect(requestedUrls).toEqual([MODELS_DEV_PRICING_URL]);

        const stored = await fixture.database
            .prepare(`SELECT value FROM settings WHERE key = ?`)
            .bind("MODEL_PRICING_CONFIG")
            .first<string>("value");
        expect(stored).toBeNull();
    } finally {
        globalThis.fetch = originalFetch;
        fixture.close();
    }
});
