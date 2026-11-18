import { afterEach, expect, test } from "bun:test"

import { installUpstream, runProvider, type InstalledUpstream } from "./helpers/provider-harness"

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

const sseResponse = (text: string): Response => {
    return new Response(text, {
        headers: { "content-type": "text/event-stream" },
    })
}

const chatCompletion = (content: string) => ({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})

test("openai chat passthrough keeps the native body and replaces client credentials", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("hi")))
    const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }

    const { response, saved, trackingState } = await runProvider({
        routeId: "chat-completions",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "channel-key" },
        requestBody: {
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [{ type: "text", text: "describe" }, imagePart],
            }],
        },
        requestHeaders: {
            Authorization: "Bearer client-token",
            "x-api-key": "client-leak",
            Cookie: "session=leak",
            "X-Forwarded-For": "203.0.113.9",
        },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://upstream.example/v1/chat/completions")
    expect(call.request.headers.get("authorization")).toBe("Bearer channel-key")
    expect(call.request.headers.get("x-api-key")).toBeNull()
    expect(call.request.headers.get("cookie")).toBeNull()
    expect(call.request.headers.get("x-forwarded-for")).toBeNull()
    expect(call.body.messages[0].content[1]).toEqual(imagePart)
    expect(await response.json()).toEqual(chatCompletion("hi"))
    expect(saved).toEqual([{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }])
    expect(trackingState.upstreamStatus).toBe(200)
})

test("azure chat passthrough targets the v1 path with api-key auth", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("hi")))

    const { response } = await runProvider({
        routeId: "chat-completions",
        type: "azure-openai",
        config: { endpoint: "https://resource.openai.azure.com/", api_key: "azure-key" },
        requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://resource.openai.azure.com/openai/v1/chat/completions")
    expect(call.request.headers.get("api-key")).toBe("azure-key")
    expect(call.request.headers.get("authorization")).toBeNull()
    expect((await response.json() as Record<string, any>).choices[0].message.content).toBe("hi")
})

test("claude passthrough forwards beta headers and keeps image blocks", async () => {
    const upstream = install(() => jsonResponse({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "claude-3-opus",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 6 },
    }))
    const imageBlock = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
    }

    const { response, saved } = await runProvider({
        routeId: "messages",
        type: "claude",
        config: { endpoint: "https://api.anthropic.com", api_key: "claude-key" },
        requestBody: {
            model: "claude-3-opus",
            max_tokens: 64,
            messages: [{ role: "user", content: [imageBlock] }],
        },
        requestHeaders: {
            "x-api-key": "client-token",
            "anthropic-beta": "prompt-caching-2024-07-31",
        },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://api.anthropic.com/v1/messages")
    expect(call.request.headers.get("x-api-key")).toBe("claude-key")
    expect(call.request.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(call.request.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31")
    expect(call.body.messages[0].content[0]).toEqual(imageBlock)
    expect((await response.json() as Record<string, any>).type).toBe("message")
    expect(saved).toEqual([{ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }])
})

test("responses passthrough keeps previous_response_id and native tools", async () => {
    const upstream = install(() => jsonResponse({
        id: "resp_upstream",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    }))

    const { response, saved } = await runProvider({
        routeId: "responses",
        type: "openai-responses",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        requestBody: {
            model: "gpt-4o",
            input: "hi",
            previous_response_id: "resp_previous",
            tools: [{ type: "web_search_preview" }],
        },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://upstream.example/v1/responses")
    expect(call.body.previous_response_id).toBe("resp_previous")
    expect(call.body.tools).toEqual([{ type: "web_search_preview" }])
    expect((await response.json() as Record<string, any>).object).toBe("response")
    expect(saved).toEqual([{ prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, cached_tokens: undefined }])
})

test("azure responses passthrough targets the v1 responses path", async () => {
    const upstream = install(() => jsonResponse({
        id: "resp_upstream",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }))

    await runProvider({
        routeId: "responses",
        type: "azure-openai-responses",
        config: { endpoint: "https://resource.openai.azure.com", api_key: "azure-key" },
        requestBody: { model: "gpt-4o", input: "hi" },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://resource.openai.azure.com/openai/v1/responses")
    expect(call.request.headers.get("api-key")).toBe("azure-key")
})

test("gemini native passthrough maps the path model and strips gateway markers", async () => {
    const upstream = install(() => jsonResponse({
        responseId: "gemini_upstream",
        modelVersion: "gemini-2.0-flash",
        candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
    }))

    const { response, saved } = await runProvider({
        routeId: "gemini-generate-content",
        type: "gemini-native",
        config: { endpoint: "https://generativelanguage.googleapis.com", api_key: "gemini-key" },
        requestBody: {
            model: "gemini-2.0-flash",
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
        requestHeaders: { "x-goog-api-key": "client-token" },
    })

    const call = upstream.last()
    expect(call.url.toString())
        .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent")
    expect(call.request.headers.get("x-goog-api-key")).toBe("gemini-key")
    expect(call.body.model).toBeUndefined()
    expect(call.body.stream).toBeUndefined()
    expect(call.body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }])
    expect((await response.json() as Record<string, any>).candidates[0].content.parts[0].text).toBe("hi")
    expect(saved).toEqual([{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }])
})

test("audio passthrough forwards to the speech endpoint and estimates usage", async () => {
    const upstream = install(() => new Response("ID3-audio", {
        headers: { "content-type": "audio/mpeg" },
    }))

    const { response, saved } = await runProvider({
        routeId: "audio-speech",
        type: "openai-audio",
        config: { endpoint: "https://api.openai.com", api_key: "audio-key" },
        requestBody: { model: "tts-1", input: "hello world", voice: "alloy" },
    })

    const call = upstream.last()
    expect(call.url.toString()).toBe("https://api.openai.com/v1/audio/speech")
    expect(call.request.headers.get("authorization")).toBe("Bearer audio-key")
    expect(await response.text()).toBe("ID3-audio")
    expect(saved).toHaveLength(1)
    expect(saved[0]?.prompt_tokens).toBeGreaterThan(0)
    expect(saved[0]?.total_tokens).toBe(
        (saved[0]?.prompt_tokens ?? 0) + (saved[0]?.completion_tokens ?? 0),
    )
})

test("openai chat stream forwards raw bytes and saves upstream usage", async () => {
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`
        + "data: [DONE]\n\n"
    const upstream = install(() => sseResponse(text))

    const { response, saved, tasks } = await runProvider({
        routeId: "chat-completions",
        type: "openai",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        requestBody: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
    })

    expect(await response.text()).toBe(text)
    await Promise.all(tasks)
    expect(saved).toEqual([{ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }])
    expect(upstream.last().body.stream_options).toEqual({ include_usage: true })
})

test("responses stream usage comes from response.completed", async () => {
    const text = `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } },
    })}\n\n`
    const upstream = install(() => sseResponse(text))

    const { response, saved, tasks } = await runProvider({
        routeId: "responses",
        type: "openai-responses",
        config: { endpoint: "https://upstream.example", api_key: "k" },
        requestBody: { model: "gpt-4o", stream: true, input: "hi" },
    })

    expect(await response.text()).toBe(text)
    await Promise.all(tasks)
    expect(saved).toEqual([{ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cached_tokens: undefined }])
    expect(upstream.last().body.stream).toBe(true)
})

test("claude stream accumulates message_start and message_delta usage", async () => {
    const text = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("")
    const upstream = install(() => sseResponse(text))

    const { response, saved, tasks } = await runProvider({
        routeId: "messages",
        type: "claude",
        config: { endpoint: "https://api.anthropic.com", api_key: "k" },
        requestBody: {
            model: "claude-3-opus",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        },
    })

    expect(await response.text()).toBe(text)
    await Promise.all(tasks)
    expect(saved).toEqual([{ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }])
    expect(upstream.last().body.stream).toBe(true)
})

test("claude stream without usage falls back to an estimate", async () => {
    const text = `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "estimated output" },
    })}\n\n`
    install(() => sseResponse(text))

    const { response, saved, tasks } = await runProvider({
        routeId: "messages",
        type: "claude",
        config: { endpoint: "https://api.anthropic.com", api_key: "k" },
        requestBody: {
            model: "claude-3-opus",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        },
    })

    await response.text()
    await Promise.all(tasks)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.completion_tokens).toBeGreaterThan(0)
})

test("gemini native stream requests sse and saves usageMetadata", async () => {
    const text = [
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "he" }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "llo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })}\n\n`,
    ].join("")
    const upstream = install(() => sseResponse(text))

    const { response, saved, tasks } = await runProvider({
        routeId: "gemini-generate-content",
        type: "gemini-native",
        config: { endpoint: "https://generativelanguage.googleapis.com", api_key: "k" },
        path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        requestBody: { model: "gemini-2.0-flash", contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    })

    expect(await response.text()).toBe(text)
    await Promise.all(tasks)
    expect(saved).toEqual([{ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }])

    const call = upstream.last()
    expect(call.url.pathname).toBe("/v1beta/models/gemini-2.0-flash:streamGenerateContent")
    expect(call.url.searchParams.get("alt")).toBe("sse")
    // The client's `?key=` credential must never reach upstream.
    expect(call.url.searchParams.get("key")).toBeNull()
    expect(call.body.stream).toBeUndefined()
})

test("exact endpoint (trailing #) is used verbatim for raw passthrough", async () => {
    const upstream = install(() => jsonResponse(chatCompletion("exact")))

    await runProvider({
        routeId: "chat-completions",
        type: "openai",
        config: { endpoint: "https://upstream.example/custom/chat#", api_key: "k" },
        requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    })

    expect(upstream.last().url.toString()).toBe("https://upstream.example/custom/chat")
})

test("exact endpoint (trailing #) applies to converted channels too", async () => {
    const upstream = install(() => jsonResponse({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "claude-3-opus",
        content: [{ type: "text", text: "converted" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 },
    }))

    const { response } = await runProvider({
        routeId: "chat-completions",
        type: "claude",
        config: { endpoint: "https://upstream.example/exact/anthropic#", api_key: "k" },
        requestBody: { model: "claude-3-opus", messages: [{ role: "user", content: "hi" }] },
    })

    expect(upstream.last().url.toString()).toBe("https://upstream.example/exact/anthropic")
    expect((await response.json() as Record<string, any>).choices[0].message.content).toBe("converted")
})

test("gemini native exact base keeps the models path and adds alt=sse when converting", async () => {
    const upstream = install(() => sseResponse(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] })}\n\n`,
    ))

    const { response, tasks } = await runProvider({
        routeId: "chat-completions",
        type: "gemini-native",
        config: { endpoint: "https://upstream.example/custom/v1beta#", api_key: "k" },
        requestBody: { model: "gemini-2.0-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    })

    await response.text()
    await Promise.all(tasks)

    const call = upstream.last()
    expect(call.url.origin).toBe("https://upstream.example")
    expect(call.url.pathname).toBe("/custom/v1beta/models/gemini-2.0-flash:streamGenerateContent")
    expect(call.url.searchParams.get("alt")).toBe("sse")
})
