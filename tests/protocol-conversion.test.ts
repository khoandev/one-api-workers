import { afterEach, expect, spyOn, test } from "bun:test";
import { Context } from "hono";

import { getProvider } from "../src/providers/shared/provider-registry";
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

const buildContext = (path: string) => {
    return new Context<HonoCustomType>(new Request(`http://localhost${path}`, { method: "POST" }));
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
) => {
    const provider = getProvider(routeId, type || "");
    if (!provider) throw new Error(`Missing provider for ${type}`);

    const context = buildContext(`/${routeId}`);
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

test("route policy keeps audio closed and respects direct-only gaps", () => {
    expect(isChannelAllowedForRoute("messages", { type: "openai", endpoint: "https://api.openai.com" })).toBe(true);
    expect(isChannelAllowedForRoute("audio-speech", { type: "openai", endpoint: "https://api.openai.com" })).toBe(false);
    expect(isChannelAllowedForRoute("audio-speech", { type: "openai-audio", endpoint: "https://api.openai.com" })).toBe(true);
    expect(isChannelAllowedForRoute("messages", { type: "claude", endpoint: "https://api.anthropic.com/#" })).toBe(true);
    expect(isChannelAllowedForRoute("chat-completions", { type: "claude", endpoint: "https://api.anthropic.com/#" })).toBe(false);
    expect(isChannelAllowedForRoute("chat-completions", { type: "gemini-native", endpoint: "https://generativelanguage.googleapis.com/#" })).toBe(false);
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
