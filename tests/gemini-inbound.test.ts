import { afterEach, expect, test } from "bun:test"
import { Context } from "hono"

import { getApiKeyForRoute, getApiKeyFromQuery } from "../src/providers/shared/auth"
import { installUpstream, runProvider, type InstalledUpstream } from "./helpers/provider-harness"
import {
    isGeminiModelsPath,
    parseGeminiRouteTarget,
    resolveRouteId,
} from "../src/providers/shared/route-policy"

const installed: InstalledUpstream[] = []

const install = (handler: (request: Request) => Response | Promise<Response>): InstalledUpstream => {
    const upstream = installUpstream(handler)
    installed.push(upstream)
    return upstream
}

afterEach(() => {
    while (installed.length > 0) {
        installed.pop()!.restore()
    }
})

const jsonResponse = (payload: unknown): Response => {
    return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
    })
}

const buildContext = (path: string, headers: Record<string, string> = {}) => {
    return new Context<HonoCustomType>(new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
    }))
}

const geminiRequest = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    system_instruction: { parts: [{ text: "be brief" }] },
}

const chatCompletion = (content: string) => ({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
})

test("gemini routes parse model and action from the path", () => {
    expect(isGeminiModelsPath("/v1beta/models/gemini-2.0-flash:generateContent")).toBe(true)
    expect(resolveRouteId("/v1beta/models/gemini-2.0-flash:generateContent")).toBe("gemini-generate-content")
    expect(resolveRouteId("/v1beta/models/gemini-2.0-flash:streamGenerateContent")).toBe("gemini-generate-content")
    expect(parseGeminiRouteTarget("/v1beta/models/gemini-2.0-flash:generateContent"))
        .toEqual({ model: "gemini-2.0-flash", stream: false })
    expect(parseGeminiRouteTarget("/v1beta/models/gemini-2.0-flash:streamGenerateContent"))
        .toEqual({ model: "gemini-2.0-flash", stream: true })
    expect(parseGeminiRouteTarget("/v1beta/models/gemini%2D2.0:generateContent"))
        .toEqual({ model: "gemini-2.0", stream: false })
})

test("unsupported gemini actions and routes are rejected", () => {
    expect(parseGeminiRouteTarget("/v1beta/models/gemini-2.0-flash:predict")).toBeNull()
    expect(parseGeminiRouteTarget("/v1beta/models/gemini-2.0-flash")).toBeNull()
    expect(parseGeminiRouteTarget("/v1beta/models/:generateContent")).toBeNull()
    expect(resolveRouteId("/v1beta/models/gemini-2.0-flash:predict")).toBeNull()
    expect(resolveRouteId("/v1beta/models/gemini-2.0-flash")).toBeNull()
    expect(isGeminiModelsPath("/v1/chat/completions")).toBe(false)
    expect(resolveRouteId("/v1/chat/completions")).toBe("chat-completions")
})

test("gemini routes accept x-goog-api-key and ?key=, other routes do not accept ?key=", () => {
    const queryContext = buildContext("/v1beta/models/gemini-2.0-flash:generateContent?key=sk-gemini")
    expect(getApiKeyFromQuery(queryContext)).toBe("sk-gemini")
    expect(getApiKeyForRoute(queryContext, "gemini-generate-content")).toBe("sk-gemini")
    expect(getApiKeyForRoute(queryContext, "chat-completions")).toBeNull()

    const headerContext = buildContext("/v1beta/models/gemini-2.0-flash:generateContent", {
        "x-goog-api-key": "sk-header",
    })
    expect(getApiKeyForRoute(headerContext, "gemini-generate-content")).toBe("sk-header")

    const bearerContext = buildContext("/v1beta/models/gemini-2.0-flash:generateContent", {
        Authorization: "Bearer sk-bearer",
    })
    expect(getApiKeyForRoute(bearerContext, "gemini-generate-content")).toBe("sk-bearer")

    expect(getApiKeyForRoute(buildContext("/v1beta/models/x:generateContent"), "gemini-generate-content"))
        .toBeNull()
})

test("gemini request converts to an openai chat channel and back", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("converted")))

    const { response, saved, trackingState } = await runProvider({
        routeId: "gemini-generate-content",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "channel-key" },
        requestBody: { ...geminiRequest, model: "gpt-4o" },
        requestHeaders: { "x-goog-api-key": "client-token" },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://upstream.example/v1/chat/completions")
    expect(call.request.headers.get("authorization")).toBe("Bearer channel-key")
    expect(call.request.headers.get("x-goog-api-key")).toBeNull()
    expect(call.body.messages).toEqual([
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
    ])

    const body = await response.json() as Record<string, any>
    expect(body.candidates[0].content.parts).toEqual([{ text: "converted" }])
    expect(body.candidates[0].finishReason).toBe("STOP")
    expect(body.usageMetadata).toEqual({
        promptTokenCount: 9,
        candidateTokenCount: undefined,
        candidatesTokenCount: 4,
        totalTokenCount: 13,
    })
    expect(saved).toEqual([{ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }])
    expect(trackingState.upstreamStatus).toBe(200)
})

test("gemini request converts to a claude channel", async () => {
    const upstream = install(() => jsonResponse({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "claude-3-opus",
        content: [{ type: "text", text: "claude answer" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
    }))

    const { response } = await runProvider({
        routeId: "gemini-generate-content",
        type: "claude",
        config: { endpoint: "https://api.anthropic.com", api_key: "claude-key" },
        requestBody: { ...geminiRequest, model: "claude-3-opus" },
    })

    expect(upstream.last().url.toString()).toBe("https://api.anthropic.com/v1/messages")
    const body = await response.json() as Record<string, any>
    expect(body.candidates[0].content.parts).toEqual([{ text: "claude answer" }])
    expect(body.usageMetadata.promptTokenCount).toBe(5)
    expect(body.usageMetadata.candidatesTokenCount).toBe(3)
})

test("gemini stream converts to openai chat SSE without a DONE sentinel", async () => {
    const upstreamText = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`,
        `data: ${JSON.stringify({
            choices: [{ delta: { content: "llo" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
        })}\n\n`,
        "data: [DONE]\n\n",
    ].join("")
    const upstream = install(() => new Response(upstreamText, {
        headers: { "content-type": "text/event-stream" },
    }))

    const { response, saved, tasks } = await runProvider({
        routeId: "gemini-generate-content",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        requestBody: { ...geminiRequest, model: "gpt-4o" },
    })

    expect(upstream.last().body.stream).toBe(true)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const text = await response.text()
    await Promise.all(tasks)
    expect(text).not.toContain("[DONE]")
    expect(text).toContain('"text":"he"')
    expect(text).toContain('"text":"llo"')
    expect(text).toContain('"finishReason":"STOP"')
    expect(text).toContain("\"promptTokenCount\":6")
    expect(saved).toEqual([{ prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 }])
})

test("invalid gemini payloads return the Gemini error envelope", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("never")))

    const { response, trackingState } = await runProvider({
        routeId: "gemini-generate-content",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        requestBody: { model: "gpt-4o", contents: [] },
    })

    expect(upstream.calls).toHaveLength(0)
    expect(response.status).toBe(400)
    expect(trackingState.upstreamStatus).toBe(400)
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(400)
    expect(body.error.status).toBe("INVALID_ARGUMENT")
    expect(body.error.message).toContain("gemini-generate-content")
})

test("upstream failures return the Gemini error envelope", async () => {
    install(() => new Response(JSON.stringify({
        error: { message: "upstream exploded", code: 500 },
    }), {
        status: 500,
        headers: { "content-type": "application/json" },
    }))

    const { response } = await runProvider({
        routeId: "gemini-generate-content",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        requestBody: { ...geminiRequest, model: "gpt-4o" },
    })

    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(500)
    expect(body.error.status).toBe("INTERNAL")
    expect(body.error.message).toContain("upstream exploded")
})

test("mid-stream failures are reported as Gemini error events", async () => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "part" } }] })}\n\n`,
            ))
            controller.error(new Error("stream boom"))
        },
    })
    install(() => new Response(body, { headers: { "content-type": "text/event-stream" } }))

    const { response, tasks } = await runProvider({
        routeId: "gemini-generate-content",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        requestBody: { ...geminiRequest, model: "gpt-4o" },
    })

    const text = await response.text()
    await Promise.all(tasks)
    expect(text).toContain('"error"')
    expect(text).toContain("stream boom")
})
