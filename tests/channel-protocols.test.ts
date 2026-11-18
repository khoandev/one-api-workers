import { afterEach, expect, test } from "bun:test";
import { Context, Hono } from "hono";

import { api as adminApi } from "../src/admin";
import db from "../src/db";
import { normalizeChannelConfig } from "../src/channel-config";
import { DEFAULT_CHANNEL_ROUTING_CONFIG } from "../src/system-config";
import protocolConversion from "../src/providers/protocol-conversion";
import passthroughProxy from "../src/providers/passthrough-proxy";
import { getProvider } from "../src/providers/shared/provider-registry";
import {
    resolveChannelProtocols,
    resolvePrimaryProtocol,
} from "../src/providers/shared/protocol-registry";
import type { ResolvedChannelCandidate } from "../src/providers/shared/channel-resolver";
import { executeWithFallbackChannels } from "../src/providers/shared/upstream-retry";
import { installUpstream, runProvider, type InstalledUpstream } from "./helpers/provider-harness";
import { createTestDatabase } from "./helpers/sqlite-d1";

const installed: InstalledUpstream[] = [];

const install = (handler: (request: Request) => Response | Promise<Response>): InstalledUpstream => {
    const upstream = installUpstream(handler);
    installed.push(upstream);
    return upstream;
};

afterEach(() => {
    while (installed.length > 0) {
        installed.pop()!.restore();
    }
});

const jsonResponse = (payload: unknown): Response => {
    return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
    });
};

const chatCompletion = (content: string) => ({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const responsesPayload = (text: string) => ({
    id: "resp_upstream",
    object: "response",
    created_at: 1,
    model: "gpt-4.1",
    status: "completed",
    output: [
        {
            type: "message",
            id: "msg_upstream",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
        },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

test("channel protocol defaults and declared overrides resolve in canonical order", () => {
    expect(resolveChannelProtocols({ type: "openai" })).toEqual(["openai-chat"]);
    expect(resolvePrimaryProtocol({ type: "openai" })).toBe("openai-chat");

    expect(resolveChannelProtocols({
        type: "openai",
        protocols: ["openai-responses", "openai-chat"],
    })).toEqual(["openai-chat", "openai-responses"]);

    expect(resolvePrimaryProtocol({
        type: "openai",
        protocols: ["openai-chat", "openai-responses"],
        primary_protocol: "openai-responses",
    })).toBe("openai-responses");
    expect(resolvePrimaryProtocol({
        type: "openai",
        protocols: ["openai-chat"],
        primary_protocol: "anthropic-messages",
    })).toBe("openai-chat");

    expect(resolveChannelProtocols({
        type: "azure-openai",
        protocols: ["gemini-generate-content"],
    })).toEqual(["openai-chat"]);
    expect(resolveChannelProtocols({
        type: "azure-openai",
        protocols: ["openai-responses"],
    })).toEqual(["openai-responses"]);

    expect(resolveChannelProtocols({ type: "openai-audio" })).toEqual([]);
    expect(resolvePrimaryProtocol({ type: "openai-audio" })).toBeNull();
});

test("dispatch selects passthrough only for natively supported protocols", () => {
    expect(getProvider("responses", {
        type: "openai",
        protocols: ["openai-chat", "openai-responses"],
    })).toBe(passthroughProxy.fetch);
    expect(getProvider("responses", { type: "openai" })).toBe(protocolConversion.fetch);
    expect(getProvider("chat-completions", {
        type: "openai",
        protocols: ["openai-responses"],
    })).toBe(protocolConversion.fetch);
});

test("native responses support forwards the Responses payload verbatim", async () => {
    const upstream = install(() => jsonResponse(responsesPayload("hi")));

    const { response } = await runProvider({
        routeId: "responses",
        type: "openai",
        config: {
            endpoint: "https://api.openai.com/v1",
            api_key: "sk-test",
            protocols: ["openai-chat", "openai-responses"],
            primary_protocol: "openai-chat",
        },
        requestBody: {
            model: "gpt-4.1",
            input: "hi",
            previous_response_id: "resp_prev",
        },
    });

    expect(response.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.last().url.toString()).toBe("https://api.openai.com/v1/responses");
    expect(upstream.last().body).toEqual({
        model: "gpt-4.1",
        input: "hi",
        previous_response_id: "resp_prev",
    });
    expect(upstream.last().request.headers.get("authorization")).toBe("Bearer sk-test");
});

test("declared protocols choose the conversion target", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("converted")));

    const { response } = await runProvider({
        routeId: "responses",
        type: "openai-responses",
        config: {
            endpoint: "https://upstream.example/v1",
            api_key: "k",
            protocols: ["openai-chat"],
            primary_protocol: "openai-chat",
        },
        requestBody: { model: "gpt-4o", input: "hi" },
    });

    expect(response.status).toBe(200);
    expect(upstream.last().url.pathname.endsWith("/v1/chat/completions")).toBe(true);
});

test("unconvertible requests name the channel, features, and protocols", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("nope")));

    const { response } = await runProvider({
        routeId: "responses",
        type: "openai",
        config: {
            name: "chat-only",
            channel_key: "chat-only-key",
            endpoint: "https://api.openai.com/v1",
            api_key: "k",
        },
        requestBody: {
            model: "gpt-4.1",
            input: "hi",
            previous_response_id: "resp_prev",
            truncation: "auto",
        },
    });

    expect(upstream.calls).toHaveLength(0);
    expect(response.status).toBe(400);

    const body = await response.json() as {
        error: { code: string; param: string; message: string };
    };
    expect(body.error.code).toBe("request_unsupported_openai_semantics");
    expect(body.error.param).toBe("previous_response_id");
    expect(body.error.message).toContain("previous_response_id");
    expect(body.error.message).toContain("truncation");
    expect(body.error.message).toContain('Channel "chat-only" (key: chat-only-key, type: openai)');
    expect(body.error.message).toContain("supports: openai-chat");
    expect(body.error.message).toContain('conversion target: "openai-chat"');
});

test("fallback retries an unconvertible request on a natively capable channel", async () => {
    const upstream = install(() => jsonResponse(responsesPayload("hi")));

    const mapping: ChannelModelMapping = { id: "gpt-4.1", name: "gpt-4.1" };
    const chatChannel: ResolvedChannelCandidate = {
        key: "chat",
        config: normalizeChannelConfig({
            name: "chat",
            type: "openai",
            endpoint: "https://upstream.test/v1",
            api_keys: ["k"],
        }),
        mapping,
    };
    const responsesChannel: ResolvedChannelCandidate = {
        key: "resp",
        config: normalizeChannelConfig({
            name: "resp",
            type: "openai-responses",
            endpoint: "https://upstream.test/v1",
            api_keys: ["k"],
        }),
        mapping,
    };
    const context = new Context<HonoCustomType>(
        new Request("http://localhost/v1/responses", { method: "POST" }),
    );

    const response = await executeWithFallbackChannels(
        context,
        [chatChannel, responsesChannel],
        chatChannel,
        { model: "gpt-4.1", input: "hi", previous_response_id: "resp_prev" },
        async () => {},
        () => {},
        { retryCount: 0 },
        () => {},
        "responses",
        { ...DEFAULT_CHANNEL_ROUTING_CONFIG, retryBackoffMs: 0 },
    );

    expect(response.status).toBe(200);
    expect(upstream.calls.map((call) => call.url.pathname)).toEqual(["/v1/responses"]);
});

test("migration materializes default channel protocols once", async () => {
    const fixture = createTestDatabase();

    try {
        await db.initialize(fixture.context);
        fixture.sqlite.query(
            "INSERT INTO channel_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)"
        ).run(
            "legacy",
            JSON.stringify({
                name: "Legacy",
                type: "openai",
                endpoint: "https://api.openai.com/v1",
                api_keys: ["k"],
                models: [{ id: "gpt-4.1", name: "gpt-4.1" }],
            }),
            "2025-01-01",
            "2025-01-02",
        );

        await db.migrate(fixture.context);

        const readValue = () => {
            const row = fixture.sqlite.query("SELECT value FROM channel_config WHERE key = ?")
                .get("legacy") as { value: string };
            return JSON.parse(row.value) as ChannelConfig;
        };

        const migrated = readValue();
        expect(migrated.protocols).toEqual(["openai-chat"]);
        expect(migrated.primary_protocol).toBe("openai-chat");

        await db.migrate(fixture.context);
        expect(readValue()).toEqual(migrated);
    } finally {
        fixture.close();
    }
});

test("admin API rejects protocols the channel type cannot serve", async () => {
    const fixture = createTestDatabase();
    const app = new Hono<HonoCustomType>().route("/", adminApi);
    const env = {
        DB: fixture.database,
        ADMIN_TOKEN: "fixture-admin-token",
    } as unknown as CloudflareBindings;

    const postChannel = (body: Record<string, unknown>) => app.request(
        "/api/admin/channel/azure-gemini",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-admin-token": "fixture-admin-token",
            },
            body: JSON.stringify(body),
        },
        env,
    );

    try {
        await db.migrate(fixture.context);

        const invalid = await postChannel({
            name: "x",
            type: "azure-openai",
            endpoint: "https://r.openai.azure.com/",
            api_keys: ["k"],
            protocols: ["gemini-generate-content"],
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.text()).toContain("gemini-generate-content");

        const badPrimary = await postChannel({
            name: "x",
            type: "azure-openai",
            endpoint: "https://r.openai.azure.com/",
            api_keys: ["k"],
            protocols: ["openai-chat", "openai-responses"],
            primary_protocol: "gemini-generate-content",
        });
        expect(badPrimary.status).toBe(400);
        expect(await badPrimary.text()).toContain("primary_protocol must be included in protocols");

        const accepted = await postChannel({
            name: "x",
            type: "azure-openai",
            endpoint: "https://r.openai.azure.com/",
            api_keys: ["k"],
            protocols: ["openai-chat", "openai-responses"],
            primary_protocol: "openai-responses",
        });
        expect(accepted.status).toBe(200);

        const row = fixture.sqlite.query("SELECT value FROM channel_config WHERE key = ?")
            .get("azure-gemini") as { value: string };
        const stored = JSON.parse(row.value) as ChannelConfig;
        expect(stored.protocols).toEqual(["openai-chat", "openai-responses"]);
        expect(stored.primary_protocol).toBe("openai-responses");
    } finally {
        fixture.close();
    }
});
