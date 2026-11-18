import { afterEach, expect, spyOn, test } from "bun:test";
import { Context } from "hono";

import passthroughProxy from "../src/providers/passthrough-proxy";
import protocolConversion from "../src/providers/protocol-conversion";
import { getProvider } from "../src/providers/shared/provider-registry";
import {
    getUpstreamHeaderAllowlist,
    resolveUpstreamBase,
} from "../src/providers/shared/protocol-registry";
import { isChannelAllowedForRoute } from "../src/providers/shared/route-policy";

const restoreFetchers: Array<() => void> = [];

afterEach(() => {
    while (restoreFetchers.length > 0) {
        restoreFetchers.pop()!();
    }
});

const mockUpstream = (handler: (request: Request) => Response | Promise<Response>) => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        return Promise.resolve(handler(request));
    }) as typeof fetch);
    restoreFetchers.push(() => fetchSpy.mockRestore());
    return fetchSpy;
};

const buildContext = (path: string, headers: Record<string, string> = {}) => {
    return new Context<HonoCustomType>(new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
    }));
};

const collectUsage = () => {
    const saved: Usage[] = [];
    return {
        saved,
        saveUsage: async (usage: Usage) => { saved.push(usage); },
    };
};

const runProvider = async (
    routeId: RouteId,
    type: ChannelType,
    config: Partial<ChannelConfig>,
    requestBody: unknown,
    requestHeaders: Record<string, string> = {},
) => {
    const provider = getProvider(routeId, type || "");
    if (!provider) throw new Error(`Missing provider for ${type}`);

    const context = buildContext(`/${routeId}`, requestHeaders);
    const { saved, saveUsage } = collectUsage();
    const trackingState: RequestTrackingState = { retryCount: 0 };
    const response = await provider(
        context,
        { name: "test", type, endpoint: "", ...config } as ChannelConfig,
        requestBody,
        saveUsage,
        trackingState,
        routeId,
    );

    return { response, saved, trackingState };
};

const chatCompletion = (content: string, usage?: object) => ({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
});

const anthropicMessage = (text: string) => ({
    id: "msg_upstream",
    type: "message",
    role: "assistant",
    model: "claude-3-opus",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
});

test("messages to openai chat converts request and response", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream(request => {
        upstreamRequest = request;
        return new Response(JSON.stringify(chatCompletion("hi", {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        })), { headers: { "content-type": "application/json" } });
    });

    const { response, saved, trackingState } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://upstream.example/v1/chat/completions");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer k");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(upstreamBody.max_tokens).toBe(64);

    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("hi");
    expect(body.stop_reason).toBe("end_turn");
    expect(saved).toEqual([{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }]);
    expect(trackingState.upstreamStatus).toBe(200);
});

test("messages to openai chat streams anthropic events with single usage save", async () => {
    const stream = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
    ].join("");

    mockUpstream(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));

    const { response, saved } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    expect(saved).toEqual([{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }]);
});

test("chat to claude converts request and response", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream(request => {
        upstreamRequest = request;
        return new Response(JSON.stringify(anthropicMessage("mock claude")), {
            headers: { "content-type": "application/json" },
        });
    });

    const { response } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstreamRequest?.headers.get("x-api-key")).toBe("k");

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("mock claude");
});

test("messages to azure openai uses api-key auth header", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream(request => {
        upstreamRequest = request;
        return new Response(JSON.stringify(chatCompletion("azure")), {
            headers: { "content-type": "application/json" },
        });
    });

    const { response } = await runProvider("messages", "azure-openai", {
        endpoint: "https://r.openai.azure.com/openai/v1",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://r.openai.azure.com/openai/v1/chat/completions");
    expect(upstreamRequest?.headers.get("api-key")).toBe("k");
    expect(upstreamRequest?.headers.get("authorization")).toBeNull();
    expect(response.status).toBe(200);
});

test("chat to gemini native calls generateContent and encodes the response", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream(request => {
        upstreamRequest = request;
        return new Response(JSON.stringify({
            responseId: "gemini-upstream",
            modelVersion: "gemini-2.0-flash",
            candidates: [{
                content: { role: "model", parts: [{ text: "mock gemini" }] },
                finishReason: "STOP",
                index: 0,
            }],
            usageMetadata: {
                promptTokenCount: 7,
                candidatesTokenCount: 3,
                totalTokenCount: 10,
            },
        }), { headers: { "content-type": "application/json" } });
    });

    const { response, saved } = await runProvider("chat-completions", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );
    expect(upstreamRequest?.headers.get("x-goog-api-key")).toBe("k");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(Array.isArray(upstreamBody.contents)).toBe(true);

    const body = await response.json() as Record<string, any>;
    expect(body.choices[0].message.content).toBe("mock gemini");
    expect(saved[0]?.prompt_tokens).toBe(7);
});

test("responses to openai chat converts input and encodes responses object", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream(request => {
        upstreamRequest = request;
        return new Response(JSON.stringify(chatCompletion("mock responses")), {
            headers: { "content-type": "application/json" },
        });
    });

    const { response } = await runProvider("responses", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        input: "hi",
    });

    expect(upstreamRequest?.url).toBe("https://upstream.example/v1/chat/completions");
    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.messages).toEqual([{ role: "user", content: "hi" }]);

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("mock responses");
});

test("responses stateful fields are rejected before the upstream call", async () => {
    const fetchSpy = mockUpstream(() => new Response(JSON.stringify(chatCompletion("nope"))));

    const { response } = await runProvider("responses", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        input: "hi",
        previous_response_id: "resp_previous",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("request_unsupported_openai_semantics");
});

test("responses native tools are rejected before the upstream call", async () => {
    const fetchSpy = mockUpstream(() => new Response(JSON.stringify(chatCompletion("nope"))));

    const { response } = await runProvider("responses", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        input: "hi",
        tools: [{ type: "web_search" }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
});

test("route policy keeps audio closed and allows exact endpoints everywhere", () => {
    expect(isChannelAllowedForRoute("messages", { type: "openai", endpoint: "https://api.openai.com" })).toBe(true);
    expect(isChannelAllowedForRoute("audio-speech", { type: "openai", endpoint: "https://api.openai.com" })).toBe(false);
    expect(isChannelAllowedForRoute("audio-speech", { type: "openai-audio", endpoint: "https://api.openai.com" })).toBe(true);
    expect(isChannelAllowedForRoute("messages", { type: "claude", endpoint: "https://api.anthropic.com/#" })).toBe(true);
    expect(isChannelAllowedForRoute("chat-completions", { type: "claude", endpoint: "https://api.anthropic.com/#" })).toBe(true);
    expect(isChannelAllowedForRoute("chat-completions", { type: "gemini-native", endpoint: "https://generativelanguage.googleapis.com/#" })).toBe(true);
    expect(isChannelAllowedForRoute("gemini-generate-content", { type: "gemini-native", endpoint: "https://generativelanguage.googleapis.com" })).toBe(true);
    expect(isChannelAllowedForRoute("gemini-generate-content", { type: "openai-audio", endpoint: "https://api.openai.com" })).toBe(false);
    expect(isChannelAllowedForRoute("chat-completions", { type: undefined, endpoint: "https://api.openai.com" })).toBe(false);
});

test("messages image blocks are rejected with a route-specific payload error", async () => {
    const fetchSpy = mockUpstream(() => new Response(JSON.stringify(chatCompletion("nope"))));

    const { response } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{
            role: "user",
            content: [
                { type: "text", text: "describe" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
        }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("Invalid anthropic-messages request payload");
});

const jsonResponse = (payload: unknown) => {
    return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
    });
};

const sseResponse = (body: string) => {
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
};

const responsesCompletion = (text: string, usage?: Record<string, number>) => ({
    id: "resp_upstream",
    object: "response",
    created_at: 1,
    model: "gpt-4.1-mini",
    status: "completed",
    output: [{
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    }],
    ...(usage ? { usage } : {}),
});

const responsesSse = (
    texts: string[],
    usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
) => {
    return [
        `data: ${JSON.stringify({
            type: "response.created",
            sequence_number: 0,
            response: { ...responsesCompletion(""), status: "in_progress", output: [] },
        })}\n\n`,
        `data: ${JSON.stringify({
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
                id: "msg_upstream",
                type: "message",
                role: "assistant",
                status: "in_progress",
                content: [],
            },
        })}\n\n`,
        ...texts.map((text, index) => `data: ${JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: index + 2,
            item_id: "msg_upstream",
            output_index: 0,
            content_index: 0,
            delta: text,
        })}\n\n`),
        `data: ${JSON.stringify({
            type: "response.completed",
            sequence_number: texts.length + 2,
            response: responsesCompletion(texts.join(""), usage),
        })}\n\n`,
        "data: [DONE]\n\n",
    ].join("");
};

const chatSse = (
    texts: string[],
    usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
) => {
    const chunks = texts.map((text) => `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`);
    const finalChunk = `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
    })}\n\n`;

    return [...chunks, finalChunk, "data: [DONE]\n\n"].join("");
};

const anthropicSse = (texts: string[], usage?: Record<string, number>) => {
    return [
        `event: message_start\ndata: ${JSON.stringify({
            message: {
                id: "msg_upstream",
                type: "message",
                role: "assistant",
                model: "claude-3-opus",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 1 },
            },
        })}\n\n`,
        ...texts.map((text) => `event: content_block_delta\ndata: ${JSON.stringify({
            index: 0,
            delta: { type: "text_delta", text },
        })}\n\n`),
        `event: message_delta\ndata: ${JSON.stringify({
            delta: { stop_reason: "end_turn", stop_sequence: null },
            ...(usage ? { usage } : {}),
        })}\n\n`,
        "event: message_stop\ndata: {}\n\n",
    ].join("");
};

const geminiCompletion = (text: string) => ({
    responseId: "gemini_upstream",
    modelVersion: "gemini-2.0-flash",
    candidates: [{
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
    }],
    usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 3,
        totalTokenCount: 10,
    },
});

const geminiSse = (texts: string[], withUsage = true) => {
    return [
        ...texts.map((text) => `data: ${JSON.stringify({
            responseId: "gemini_upstream",
            modelVersion: "gemini-2.0-flash",
            candidates: [{ content: { role: "model", parts: [{ text }] } }],
        })}\n\n`),
        `data: ${JSON.stringify({
            responseId: "gemini_upstream",
            modelVersion: "gemini-2.0-flash",
            candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }],
            ...(withUsage
                ? {
                    usageMetadata: {
                        promptTokenCount: 7,
                        candidatesTokenCount: 3,
                        totalTokenCount: 10,
                    },
                }
                : {}),
        })}\n\n`,
    ].join("");
};

test("messages to openai responses channel uses the responses endpoint", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(responsesCompletion("mock responses", {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
        }));
    });

    const { response, saved } = await runProvider("messages", "openai-responses", {
        endpoint: "https://api.openai.com",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer k");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.input).toEqual([{ type: "message", role: "user", content: "hello" }]);

    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("mock responses");
    expect(saved).toEqual([{ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }]);
});

test("messages to azure openai responses uses api-key auth", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(responsesCompletion("mock azure responses"));
    });

    const { response } = await runProvider("messages", "azure-openai-responses", {
        endpoint: "https://r.openai.azure.com/",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://r.openai.azure.com/openai/v1/responses");
    expect(upstreamRequest?.headers.get("api-key")).toBe("k");
    expect(upstreamRequest?.headers.get("authorization")).toBeNull();

    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("mock azure responses");
});

test("messages to gemini native converts the request and response", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(geminiCompletion("mock gemini"));
    });

    const { response, saved } = await runProvider("messages", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );
    expect(upstreamRequest?.headers.get("x-goog-api-key")).toBe("k");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(Array.isArray(upstreamBody.contents)).toBe(true);

    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("mock gemini");
    expect(saved).toEqual([{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }]);
});

test("chat to openai responses converts messages into responses input", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(responsesCompletion("hello there", {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
        }));
    });

    const { response, saved } = await runProvider("chat-completions", "openai-responses", {
        endpoint: "https://api.openai.com",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://api.openai.com/v1/responses");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.input).toEqual([{ type: "message", role: "user", content: "hello" }]);

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hello there");
    expect(saved).toEqual([{ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }]);
});

test("chat to azure openai responses uses api-key auth", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(responsesCompletion("azure responses"));
    });

    const { response } = await runProvider("chat-completions", "azure-openai-responses", {
        endpoint: "https://r.openai.azure.com/",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe("https://r.openai.azure.com/openai/v1/responses");
    expect(upstreamRequest?.headers.get("api-key")).toBe("k");
    expect(upstreamRequest?.headers.get("authorization")).toBeNull();

    const body = await response.json() as Record<string, any>;
    expect(body.choices[0].message.content).toBe("azure responses");
});

test("chat to claude maps anthropic usage without cached tokens", async () => {
    mockUpstream(() => jsonResponse(anthropicMessage("mock claude")));

    const { saved } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        messages: [{ role: "user", content: "hello" }],
    });

    expect(saved).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
    expect("cached_tokens" in (saved[0] ?? {})).toBe(false);
});

test("converted usage keeps cached tokens for openai compatible upstreams", async () => {
    mockUpstream(() => jsonResponse(chatCompletion("cached", {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
    })));

    const { saved } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(saved[0]?.cached_tokens).toBe(4);
});

test("responses to claude converts input into anthropic messages", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(anthropicMessage("mock claude responses"));
    });

    const { response, saved } = await runProvider("responses", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        input: "hi",
    });

    expect(upstreamRequest?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstreamRequest?.headers.get("x-api-key")).toBe("k");

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.messages).toEqual([{ role: "user", content: "hi" }]);

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("mock claude responses");
    expect(saved).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
});

test("responses to gemini native converts the request and response", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(geminiCompletion("mock gemini responses"));
    });

    const { response } = await runProvider("responses", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        input: "hi",
    });

    expect(upstreamRequest?.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("mock gemini responses");
});

test("chat to claude streams openai chunks ending with DONE", async () => {
    mockUpstream(() => sseResponse(anthropicSse(["hel", "lo"], {
        input_tokens: 3,
        output_tokens: 2,
    })));

    const { response, saved } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await response.text();
    expect(text).toContain('"content":"hel"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(saved).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
});

test("chat to openai responses streams openai chunks with usage", async () => {
    mockUpstream(() => sseResponse(responsesSse(["hel", "lo"])));

    const { response, saved } = await runProvider("chat-completions", "openai-responses", {
        endpoint: "https://api.openai.com",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain('"content":"hel"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(saved).toEqual([{ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }]);
});

test("chat to gemini native streams openai chunks", async () => {
    mockUpstream(() => sseResponse(geminiSse(["hel", "lo"])));

    const { response, saved } = await runProvider("chat-completions", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain('"content":"hel"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(saved).toEqual([{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }]);
});

test("messages to openai responses streams anthropic events without DONE", async () => {
    mockUpstream(() => sseResponse(responsesSse(["hel", "lo"])));

    const { response, saved } = await runProvider("messages", "openai-responses", {
        endpoint: "https://api.openai.com",
        api_key: "k",
    }, {
        model: "gpt-4.1-mini",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");
    expect(saved).toEqual([{ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }]);
});

test("messages to gemini native streams anthropic events", async () => {
    mockUpstream(() => sseResponse(geminiSse(["hel", "lo"])));

    const { response, saved } = await runProvider("messages", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    expect(saved).toEqual([{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }]);
});

test("responses to openai chat streams responses events ending with DONE", async () => {
    mockUpstream(() => sseResponse(chatSse(["hel", "lo"])));

    const { response, saved } = await runProvider("responses", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        stream: true,
        input: "hi",
    });

    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(saved).toEqual([{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }]);
});

test("responses to claude streams responses events", async () => {
    mockUpstream(() => sseResponse(anthropicSse(["hel", "lo"], {
        input_tokens: 3,
        output_tokens: 2,
    })));

    const { response } = await runProvider("responses", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        stream: true,
        input: "hi",
    });

    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
});

test("responses to gemini native streams responses events", async () => {
    mockUpstream(() => sseResponse(geminiSse(["hel", "lo"])));

    const { response } = await runProvider("responses", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        stream: true,
        input: "hi",
    });

    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
});

test("stream usage falls back to estimation when the upstream omits it", async () => {
    mockUpstream(() => sseResponse(geminiSse(["hello"], false)));

    const { response, saved } = await runProvider("chat-completions", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    await response.text();
    expect(saved.length).toBe(1);
    expect(saved[0]?.prompt_tokens ?? 0).toBeGreaterThan(0);
    expect(saved[0]?.completion_tokens).toBe(2);
    expect(saved[0]?.total_tokens).toBe(
        (saved[0]?.prompt_tokens ?? 0) + (saved[0]?.completion_tokens ?? 0),
    );
});

test("chat invalid payload returns a chat shaped 400", async () => {
    const fetchSpy = mockUpstream(() => jsonResponse(chatCompletion("nope")));

    const { response } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        messages: [],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("request_invalid_payload");
    expect(body.error.message).toBe("Invalid openai-chat request payload");
    expect(body.error.type).toBe("invalid_request_error");
});

test("upstream rate limits keep the route error shape and status", async () => {
    mockUpstream(() => new Response(JSON.stringify({
        error: { message: "rate limited", type: "rate_limit_error" },
    }), {
        status: 429,
        headers: { "content-type": "application/json" },
    }));

    const { response, trackingState } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(response.status).toBe(429);
    expect(trackingState.upstreamStatus).toBe(429);

    const body = await response.json() as Record<string, any>;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("rate limited");
});

test("empty upstream streams return a 502 before any SSE bytes", async () => {
    mockUpstream(() => sseResponse(""));

    const { response, trackingState } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(response.status).toBe(502);
    expect(trackingState.upstreamStatus).toBe(502);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("provider_upstream_error");
});

test("mid stream failures are reported in band for chat clients", async () => {
    const encoder = new TextEncoder();
    const firstChunk = `data: ${JSON.stringify({
        responseId: "gemini_upstream",
        modelVersion: "gemini-2.0-flash",
        candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
    })}\n\n`;
    let pulls = 0;

    mockUpstream(() => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls += 1;
            if (pulls === 1) {
                controller.enqueue(encoder.encode(firstChunk));
                return;
            }
            controller.error(new Error("upstream boom"));
        },
    }), { headers: { "content-type": "text/event-stream" } }));

    const { response } = await runProvider("chat-completions", "gemini-native", {
        endpoint: "https://generativelanguage.googleapis.com",
        api_key: "k",
    }, {
        model: "gemini-2.0-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"error"');
    expect(text).toContain("[DONE]");
});

test("mid stream failures are reported in band for messages clients", async () => {
    const encoder = new TextEncoder();
    const firstChunk = `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    })}\n\n`;
    let pulls = 0;

    mockUpstream(() => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls += 1;
            if (pulls === 1) {
                controller.enqueue(encoder.encode(firstChunk));
                return;
            }
            controller.error(new Error("openai boom"));
        },
    }), { headers: { "content-type": "text/event-stream" } }));

    const { response } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: error");
    expect(text).toContain("openai boom");
});

test("the conversion provider refuses channels without an upstream protocol", async () => {
    const { saved, saveUsage } = collectUsage();

    const response = await protocolConversion.fetch(
        buildContext("/v1/chat/completions"),
        {
            name: "test",
            type: "openai-audio",
            endpoint: "https://upstream.example",
            api_key: "k",
        } as ChannelConfig,
        { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
        saveUsage,
        { retryCount: 0 },
        "chat-completions",
    );

    expect(response.status).toBe(500);
    expect(saved).toEqual([]);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("protocol_conversion_not_required");
});

test("responses custom tools are rejected before the upstream call", async () => {
    const fetchSpy = mockUpstream(() => jsonResponse(chatCompletion("nope")));

    const { response } = await runProvider("responses", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        input: "hi",
        tools: [{
            type: "custom",
            name: "shell",
            description: "run a command",
            format: { type: "text" },
        }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("request_unsupported_openai_semantics");
});

test("route policy accepts every text protocol on text routes", () => {
    const endpoint = "https://upstream.example";
    const textRoutes = ["chat-completions", "messages", "responses"] as const;
    const textTypes: ChannelType[] = [
        "openai",
        "gemini-native",
        "azure-openai",
        "claude",
        "openai-responses",
        "azure-openai-responses",
    ];

    for (const routeId of textRoutes) {
        for (const type of textTypes) {
            expect(isChannelAllowedForRoute(routeId, { type, endpoint })).toBe(true);
            expect(isChannelAllowedForRoute(routeId, { type, endpoint: `${endpoint}#` })).toBe(true);
        }
    }

    expect(isChannelAllowedForRoute("audio-speech", { type: "claude", endpoint })).toBe(false);
    expect(isChannelAllowedForRoute("audio-speech", { type: "azure-openai-audio", endpoint })).toBe(true);
    expect(isChannelAllowedForRoute("audio-speech", { type: "openai-audio", endpoint: `${endpoint}#` })).toBe(true);
});

test("dispatch forwards same protocols and converts cross protocols", () => {
    expect(getProvider("chat-completions", "openai")).toBe(passthroughProxy.fetch);
    expect(getProvider("chat-completions", "azure-openai")).toBe(passthroughProxy.fetch);
    expect(getProvider("messages", "claude")).toBe(passthroughProxy.fetch);
    expect(getProvider("responses", "openai-responses")).toBe(passthroughProxy.fetch);
    expect(getProvider("responses", "azure-openai-responses")).toBe(passthroughProxy.fetch);
    expect(getProvider("gemini-generate-content", "gemini-native")).toBe(passthroughProxy.fetch);
    expect(getProvider("audio-speech", "openai-audio")).toBe(passthroughProxy.fetch);

    expect(getProvider("gemini-generate-content", "openai")).toBe(protocolConversion.fetch);
    expect(getProvider("gemini-generate-content", "claude")).toBe(protocolConversion.fetch);
    expect(getProvider("messages", "openai")).toBe(protocolConversion.fetch);
    expect(getProvider("messages", "openai-responses")).toBe(protocolConversion.fetch);
    expect(getProvider("messages", "gemini-native")).toBe(protocolConversion.fetch);
    expect(getProvider("chat-completions", "claude")).toBe(protocolConversion.fetch);
    expect(getProvider("chat-completions", "gemini-native")).toBe(protocolConversion.fetch);
    expect(getProvider("chat-completions", "openai-responses")).toBe(protocolConversion.fetch);
    expect(getProvider("responses", "claude")).toBe(protocolConversion.fetch);
    expect(getProvider("responses", "gemini-native")).toBe(protocolConversion.fetch);
    expect(getProvider("responses", "openai")).toBe(protocolConversion.fetch);

    expect(getProvider("chat-completions", "unknown")).toBeUndefined();
    expect(getProvider("chat-completions", "gemini")).toBeUndefined();
    expect(getProvider("messages", "claude-to-openai")).toBeUndefined();
    expect(isChannelAllowedForRoute("chat-completions", { type: "gemini" as ChannelType, endpoint: "https://upstream.example" })).toBe(false);
    expect(isChannelAllowedForRoute("messages", { type: "claude-to-openai" as ChannelType, endpoint: "https://upstream.example" })).toBe(false);
});

test("chat tool calls convert to anthropic tool use", async () => {
    let upstreamRequest: Request | undefined;
    const parameters = {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    };
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse({
            id: "msg_upstream",
            type: "message",
            role: "assistant",
            model: "claude-3-opus",
            content: [{
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: { city: "Paris" },
            }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
        });
    });

    const { response, saved } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{
            type: "function",
            function: {
                name: "get_weather",
                description: "Get weather",
                parameters,
            },
        }],
        tool_choice: "auto",
    });

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.tools).toEqual([{
        name: "get_weather",
        description: "Get weather",
        input_schema: parameters,
    }]);

    const body = await response.json() as Record<string, any>;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0]).toEqual({
        id: "toolu_1",
        type: "function",
        function: {
            name: "get_weather",
            arguments: '{"city":"Paris"}',
        },
    });
    expect(saved).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
});

test("anthropic tool use and tool results convert to openai chat messages", async () => {
    let upstreamRequest: Request | undefined;
    const parameters = {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    };
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse({
            id: "chatcmpl-tools",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Paris"}',
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
    });

    const { response } = await runProvider("messages", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        tools: [{
            name: "get_weather",
            description: "Get weather",
            input_schema: parameters,
        }],
        messages: [
            { role: "user", content: "weather?" },
            {
                role: "assistant",
                content: [{
                    type: "tool_use",
                    id: "toolu_1",
                    name: "get_weather",
                    input: { city: "Paris" },
                }],
            },
            {
                role: "user",
                content: [{
                    type: "tool_result",
                    tool_use_id: "toolu_1",
                    content: "sunny",
                }],
            },
        ],
    });

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.tools[0]).toMatchObject({
        type: "function",
        function: { name: "get_weather", parameters },
    });
    expect(upstreamBody.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({
            id: "toolu_1",
            function: expect.objectContaining({ name: "get_weather" }),
        })],
    }));
    expect(upstreamBody.messages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "toolu_1",
        content: "sunny",
    }));

    const body = await response.json() as Record<string, any>;
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0]).toEqual({
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
    });
});

test("responses function calls convert to openai chat tool messages", async () => {
    let upstreamRequest: Request | undefined;
    const parameters = {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    };
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse({
            id: "chatcmpl-responses-tools",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Paris"}',
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
        });
    });

    const { response } = await runProvider("responses", "openai", {
        endpoint: "https://upstream.example",
        api_key: "k",
    }, {
        model: "gpt-4o",
        input: [
            { type: "message", role: "user", content: "weather?" },
            {
                type: "function_call",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Paris"}',
            },
            {
                type: "function_call_output",
                call_id: "call_1",
                output: "sunny",
            },
        ],
        tools: [{
            type: "function",
            name: "get_weather",
            description: "Get weather",
            parameters,
        }],
    });

    const upstreamBody = JSON.parse(await upstreamRequest!.text());
    expect(upstreamBody.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({
            id: "call_1",
            function: expect.objectContaining({ name: "get_weather" }),
        })],
    }));
    expect(upstreamBody.messages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        content: "sunny",
    }));

    const body = await response.json() as Record<string, any>;
    expect(body.output).toContainEqual(expect.objectContaining({
        type: "function_call",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
        call_id: "call_1",
    }));
});

test("chat stream tool call deltas are reassembled into tool_calls chunks", async () => {
    const upstreamStream = [
        `event: message_start\ndata: ${JSON.stringify({
            message: {
                id: "msg_upstream",
                type: "message",
                role: "assistant",
                model: "claude-3-opus",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 1 },
            },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
            index: 0,
            content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: {},
            },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"Paris"}' },
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { input_tokens: 3, output_tokens: 2 },
        })}\n\n`,
        "event: message_stop\ndata: {}\n\n",
    ].join("");
    mockUpstream(() => sseResponse(upstreamStream));

    const { response, saved } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
    });

    const text = await response.text();
    const chunks = text
        .split("\n\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .filter((payload) => payload !== "[DONE]")
        .map((payload) => JSON.parse(payload) as Record<string, any>);
    const toolDeltas = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);

    expect(toolDeltas[0]).toMatchObject({
        index: 0,
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather" },
    });
    expect(toolDeltas.map((delta: any) => delta.function?.arguments ?? "").join(""))
        .toBe('{"city":"Paris"}');
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(saved).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
});

test("resolveUpstreamBase normalizes every channel endpoint form", () => {
    expect(resolveUpstreamBase({
        type: "gemini-native",
        endpoint: "https://generativelanguage.googleapis.com",
    })).toEqual({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", query: {} });
    expect(resolveUpstreamBase({
        type: "gemini-native",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/",
    }).baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolveUpstreamBase({
        type: "gemini-native",
        endpoint: "https://generativelanguage.googleapis.com/v1",
    }).baseUrl).toBe("https://generativelanguage.googleapis.com/v1");

    expect(resolveUpstreamBase({
        type: "azure-openai",
        endpoint: "https://r.openai.azure.com/",
    }).baseUrl).toBe("https://r.openai.azure.com/openai/v1");
    expect(resolveUpstreamBase({
        type: "azure-openai",
        endpoint: "https://r.openai.azure.com",
    }).baseUrl).toBe("https://r.openai.azure.com/openai/v1");
    expect(resolveUpstreamBase({
        type: "azure-openai",
        endpoint: "https://r.openai.azure.com/openai/v1/",
    }).baseUrl).toBe("https://r.openai.azure.com/openai/v1");
    expect(resolveUpstreamBase({
        type: "azure-openai-responses",
        endpoint: "https://r.openai.azure.com/",
    }).baseUrl).toBe("https://r.openai.azure.com/openai/v1");
    expect(resolveUpstreamBase({
        type: "azure-openai-responses",
        endpoint: "https://r.openai.azure.com/openai/v1",
    }).baseUrl).toBe("https://r.openai.azure.com/openai/v1");

    expect(resolveUpstreamBase({
        type: "openai-responses",
        endpoint: "https://api.openai.com",
    }).baseUrl).toBe("https://api.openai.com/v1");
    expect(resolveUpstreamBase({
        type: "openai",
        endpoint: "https://api.openai.com/v1/",
    }).baseUrl).toBe("https://api.openai.com/v1");
    expect(resolveUpstreamBase({
        type: "claude",
        endpoint: "https://api.anthropic.com",
    }).baseUrl).toBe("https://api.anthropic.com/v1");

    expect(resolveUpstreamBase({
        type: "gemini-native",
        endpoint: "https://generativelanguage.googleapis.com?key=abc",
    })).toEqual({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        query: { key: "abc" },
    });
});

test("upstream header allowlists follow the channel protocol", () => {
    expect(getUpstreamHeaderAllowlist("anthropic-messages")).toEqual([
        "accept",
        "accept-encoding",
        "anthropic-beta",
        "content-type",
        "idempotency-key",
    ]);
    expect(getUpstreamHeaderAllowlist("gemini-generate-content")).toEqual([
        "accept",
        "content-type",
    ]);
    expect(getUpstreamHeaderAllowlist("openai-chat")).toEqual([
        "accept",
        "accept-encoding",
        "content-type",
        "idempotency-key",
        "openai-beta",
    ]);
    expect(getUpstreamHeaderAllowlist("openai-responses")).toEqual(
        getUpstreamHeaderAllowlist("openai-chat"),
    );
});

test("channel endpoint query params are forwarded to the upstream", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(chatCompletion("query"));
    });

    await runProvider("messages", "azure-openai", {
        endpoint: "https://r.openai.azure.com/openai/v1?api-version=2024-10-21",
        api_key: "k",
    }, {
        model: "gpt-4o",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    });

    expect(upstreamRequest?.url).toBe(
        "https://r.openai.azure.com/openai/v1/chat/completions?api-version=2024-10-21"
    );
});

test("client headers are limited to the upstream protocol allowlist", async () => {
    let upstreamRequest: Request | undefined;
    mockUpstream((request) => {
        upstreamRequest = request;
        return jsonResponse(anthropicMessage("headers"));
    });

    await runProvider("messages", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
    }, {
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-custom-secret": "leak",
    });

    expect(upstreamRequest?.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
    expect(upstreamRequest?.headers.get("x-custom-secret")).toBeNull();
});

test("chat image parts are rejected for converted channels", async () => {
    const fetchSpy = mockUpstream(() => jsonResponse(anthropicMessage("nope")));

    const { response } = await runProvider("chat-completions", "claude", {
        endpoint: "https://api.anthropic.com",
        api_key: "k",
    }, {
        model: "claude-3-opus",
        messages: [{
            role: "user",
            content: [
                { type: "text", text: "describe" },
                { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
        }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe("request_invalid_payload");
    expect(body.error.message).toBe("Invalid openai-chat request payload");
});

const responsesOnlyFieldCases: Array<[string, Record<string, unknown>]> = [
    ["conversation", { conversation: "conv_1" }],
    ["prompt", { prompt: { id: "pmpt_1" } }],
    ["truncation", { truncation: "auto" }],
    ["text.verbosity", { text: { verbosity: "low" } }],
    ["include", { include: ["message.output_text.logprobs"], top_logprobs: 2 }],
    ["reasoning.summary", { reasoning: { summary: "auto" } }],
];

for (const [label, extra] of responsesOnlyFieldCases) {
    test(`responses field ${label} is rejected before conversion`, async () => {
        const fetchSpy = mockUpstream(() => jsonResponse(chatCompletion("nope")));

        const { response } = await runProvider("responses", "openai", {
            endpoint: "https://upstream.example",
            api_key: "k",
        }, {
            model: "gpt-4o",
            input: "hi",
            ...extra,
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(response.status).toBe(400);
        const body = await response.json() as Record<string, any>;
        expect(body.error.code).toBe("request_unsupported_openai_semantics");
        expect(body.error.message).toBe(`"${label}" requires an OpenAI Responses compatible channel`);
    });
}

const nativeToolCases = ["web_search", "image_generation", "custom"] as const;

for (const nativeTool of nativeToolCases) {
    test(`responses native tool ${nativeTool} is rejected for chat upstreams`, async () => {
        const fetchSpy = mockUpstream(() => jsonResponse(chatCompletion("nope")));
        const tool = nativeTool === "custom"
            ? { type: "custom", name: "shell", description: "run a command", format: { type: "text" } }
            : { type: nativeTool };

        const { response } = await runProvider("responses", "openai", {
            endpoint: "https://upstream.example",
            api_key: "k",
        }, {
            model: "gpt-4o",
            input: "hi",
            tools: [tool],
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(response.status).toBe(400);
        const body = await response.json() as Record<string, any>;
        expect(body.error.code).toBe("request_unsupported_openai_semantics");
    });
}

const conversionStreamCases: Array<{
    label: string;
    routeId: Exclude<RouteId, "audio-speech">;
    type: ChannelType;
    endpoint: string;
    upstream: string;
    request: Record<string, unknown>;
    assertRequest: (request: Request) => void;
}> = [
    {
        label: "messages to azure openai",
        routeId: "messages",
        type: "azure-openai",
        endpoint: "https://r.openai.azure.com/openai/v1",
        upstream: chatSse(["hel", "lo"]),
        request: {
            model: "gpt-4o",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
        },
        assertRequest: (request) => {
            expect(request.url).toBe("https://r.openai.azure.com/openai/v1/chat/completions");
            expect(request.headers.get("api-key")).toBe("k");
        },
    },
    {
        label: "messages to azure openai responses",
        routeId: "messages",
        type: "azure-openai-responses",
        endpoint: "https://r.openai.azure.com/",
        upstream: responsesSse(["hel", "lo"]),
        request: {
            model: "gpt-4.1-mini",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
        },
        assertRequest: (request) => {
            expect(request.url).toBe("https://r.openai.azure.com/openai/v1/responses");
            expect(request.headers.get("api-key")).toBe("k");
        },
    },
    {
        label: "chat to azure openai responses",
        routeId: "chat-completions",
        type: "azure-openai-responses",
        endpoint: "https://r.openai.azure.com/",
        upstream: responsesSse(["hel", "lo"]),
        request: {
            model: "gpt-4.1-mini",
            stream: true,
            messages: [{ role: "user", content: "hello" }],
        },
        assertRequest: (request) => {
            expect(request.url).toBe("https://r.openai.azure.com/openai/v1/responses");
            expect(request.headers.get("api-key")).toBe("k");
        },
    },
    {
        label: "responses to azure openai",
        routeId: "responses",
        type: "azure-openai",
        endpoint: "https://r.openai.azure.com/",
        upstream: chatSse(["hel", "lo"]),
        request: { model: "gpt-4o", stream: true, input: "hi" },
        assertRequest: (request) => {
            expect(request.url).toBe("https://r.openai.azure.com/openai/v1/chat/completions");
            expect(request.headers.get("api-key")).toBe("k");
        },
    },
];

const streamOutputExpectations: Record<
    string,
    { contains: string[]; excludes: string[] }
> = {
    "chat-completions": {
        contains: ['"content":"hel"', "data: [DONE]"],
        excludes: [],
    },
    "messages": {
        contains: ["event: message_start", "event: content_block_delta", "event: message_stop"],
        excludes: ["[DONE]"],
    },
    "responses": {
        contains: [
            "event: response.output_text.delta",
            "event: response.completed",
            "data: [DONE]",
        ],
        excludes: [],
    },
};

for (const streamCase of conversionStreamCases) {
    test(`stream conversion: ${streamCase.label}`, async () => {
        let upstreamRequest: Request | undefined;
        mockUpstream((request) => {
            upstreamRequest = request;
            return sseResponse(streamCase.upstream);
        });

        const { response, saved } = await runProvider(
            streamCase.routeId,
            streamCase.type,
            { endpoint: streamCase.endpoint, api_key: "k" },
            streamCase.request,
        );

        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("connection")).toBe("keep-alive");

        streamCase.assertRequest(upstreamRequest!);

        const text = await response.text();
        for (const marker of streamOutputExpectations[streamCase.routeId].contains) {
            expect(text).toContain(marker);
        }
        for (const marker of streamOutputExpectations[streamCase.routeId].excludes) {
            expect(text).not.toContain(marker);
        }
        expect(saved.length).toBe(1);
    });
}

test("responses to azure openai converts the response object", async () => {
    mockUpstream(() => jsonResponse(chatCompletion("azure chat")));

    const { response } = await runProvider("responses", "azure-openai", {
        endpoint: "https://r.openai.azure.com/",
        api_key: "k",
    }, {
        model: "gpt-4o",
        input: "hi",
    });

    const body = await response.json() as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("azure chat");
});

const upstreamErrorCases: Array<{
    routeId: Exclude<RouteId, "audio-speech">;
    type: ChannelType;
    endpoint: string;
    request: Record<string, unknown>;
    status: number;
    expectedType: string;
}> = [
    {
        routeId: "chat-completions",
        type: "claude",
        endpoint: "https://api.anthropic.com",
        request: { model: "claude-3-opus", messages: [{ role: "user", content: "hello" }] },
        status: 500,
        expectedType: "server_error",
    },
    {
        routeId: "messages",
        type: "openai",
        endpoint: "https://upstream.example",
        request: {
            model: "gpt-4o",
            max_tokens: 64,
            messages: [{ role: "user", content: "hello" }],
        },
        status: 401,
        expectedType: "authentication_error",
    },
    {
        routeId: "responses",
        type: "claude",
        endpoint: "https://api.anthropic.com",
        request: { model: "claude-3-opus", input: "hi" },
        status: 404,
        expectedType: "not_found_error",
    },
];

for (const errorCase of upstreamErrorCases) {
    test(`upstream ${errorCase.status} maps to a ${errorCase.expectedType}`, async () => {
        mockUpstream(() => new Response(JSON.stringify({
            error: { message: "upstream failed" },
        }), {
            status: errorCase.status,
            headers: { "content-type": "application/json" },
        }));

        const { response, trackingState } = await runProvider(
            errorCase.routeId,
            errorCase.type,
            { endpoint: errorCase.endpoint, api_key: "k" },
            errorCase.request,
        );

        expect(response.status).toBe(errorCase.status);
        expect(trackingState.upstreamStatus).toBe(errorCase.status);

        const body = await response.json() as Record<string, any>;
        if (errorCase.routeId === "messages") {
            expect(body.type).toBe("error");
            expect(body.error.type).toBe(errorCase.expectedType);
        } else {
            expect(body.error.type).toBe(errorCase.expectedType);
            expect(body.error.code).toBe("provider_upstream_error");
        }
        expect(body.error.message).toBe("upstream failed");
    });
}
