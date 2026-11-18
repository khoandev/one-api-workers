import { Context } from "hono"

import type {
    CanonicalRequest,
    CanonicalResponse,
    CanonicalStreamEvent,
    CanonicalUsage,
} from "../airlock/canonical/index"
import {
    createStreamReassemblyIterable,
    encodeCanonicalToAnthropicMessagesResponse,
    encodeCanonicalToAnthropicMessagesStreamEvents,
    encodeCanonicalToGeminiGenerateContentResponse,
    encodeCanonicalToGeminiGenerateContentStreamEvents,
    encodeCanonicalToOpenAIChatResponse,
    encodeCanonicalToOpenAIChatStreamChunk,
    encodeCanonicalToOpenAIResponsesResponse,
    encodeCanonicalToOpenAIResponsesStreamEvent,
    encodeAnthropicMessagesStreamError,
    encodeOpenAIChatStreamError,
    encodeOpenAIResponsesStreamError,
    normalizeAnthropicMessagesRequest,
    normalizeGeminiGenerateContentRequest,
    normalizeOpenAIChatRequest,
    normalizeOpenAIResponsesRequest,
} from "../airlock/canonical/index"
import {
    anthropicMessagesRequestSchema,
    geminiGenerateContentRequestSchema,
    openAIChatCompletionRequestSchema,
    openAIResponsesRequestSchema,
} from "../airlock/protocols/index"
import {
    AnthropicProviderAdapter,
    GeminiProviderAdapter,
    OpenAIProviderAdapter,
} from "../airlock/providers/index"
import type { ProviderAdapter, ProviderRequestContext } from "../airlock/providers/index"
import { GatewayError } from "../airlock/shared/errors"
import { buildGeminiErrorPayload, buildGeminiErrorResponse } from "./shared/gemini-errors"
import {
    getUpstreamHeaderAllowlist,
    resolveChannelProtocols,
    resolvePrimaryProtocol,
    resolveProtocolDescriptor,
    resolveUpstreamBase,
    type ChannelProtocolDescriptor,
    type UpstreamProtocol,
} from "./shared/protocol-registry"
import { parseGeminiRouteTarget, type RouteId } from "./shared/route-policy"
import { buildUpstreamRequestHeaders } from "./shared/upstream-request-headers"
import { estimateUsageFromBodies } from "./shared/usage-utils"

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096

const REQUEST_SCHEMAS = {
    "chat-completions": openAIChatCompletionRequestSchema,
    "messages": anthropicMessagesRequestSchema,
    "responses": openAIResponsesRequestSchema,
} as const

const ROUTE_PAYLOAD_LABELS: Record<Exclude<RouteId, "audio-speech">, string> = {
    "chat-completions": "openai-chat",
    "messages": "anthropic-messages",
    "responses": "openai-responses",
    "gemini-generate-content": "gemini-generate-content",
}

const mapErrorType = (status: number, routeId: RouteId): string => {
    switch (status) {
        case 400:
            return "invalid_request_error"
        case 401:
            return "authentication_error"
        case 403:
            return "permission_error"
        case 404:
            return "not_found_error"
        case 429:
            return "rate_limit_error"
        default:
            return routeId === "messages" ? "api_error" : "server_error"
    }
}

const getErrorStatus = (error: unknown): number => {
    if (error instanceof GatewayError) {
        return error.httpStatus
    }
    return 502
}

const getErrorCode = (error: unknown): string => {
    if (error instanceof GatewayError) {
        return error.code
    }
    return "provider_upstream_error"
}

const buildErrorPayload = (
    routeId: RouteId,
    error: unknown,
    message: string,
): Record<string, unknown> => {
    const status = getErrorStatus(error)
    const mappedType = mapErrorType(status, routeId)
    const upstreamErrorCode = error instanceof GatewayError
        ? error.upstreamErrorCode
        : undefined
    const code = getErrorCode(error)
    const param = error instanceof GatewayError ? error.param : undefined

    if (routeId === "gemini-generate-content") {
        return buildGeminiErrorPayload(status, message)
    }

    if (routeId === "messages") {
        return {
            type: "error",
            error: {
                type: upstreamErrorCode ?? mappedType,
                message,
            },
        }
    }

    if (routeId === "responses") {
        return {
            error: {
                message,
                type: mappedType,
                code,
                ...(param ? { param } : {}),
            },
        }
    }

    return {
        error: {
            message,
            type: upstreamErrorCode ?? mappedType,
            code,
            ...(param ? { param } : {}),
        },
    }
}

const buildErrorResponse = (routeId: RouteId, error: unknown): Response => {
    const message = error instanceof Error ? error.message : "Upstream request failed"

    if (routeId === "gemini-generate-content") {
        return buildGeminiErrorResponse(getErrorStatus(error), message)
    }

    return new Response(
        JSON.stringify(buildErrorPayload(routeId, error, message)),
        {
            status: getErrorStatus(error),
            headers: { "content-type": "application/json; charset=utf-8" },
        }
    )
}

const createConversionNotRequiredError = (): GatewayError => {
    return new GatewayError("Channel has no upstream protocol available for conversion", {
        code: "protocol_conversion_not_required",
        category: "configuration",
        httpStatus: 500,
        retryable: false,
    })
}

const renderStreamError = (routeId: RouteId, error: unknown): string => {
    if (routeId === "gemini-generate-content") {
        const message = error instanceof Error ? error.message : "Upstream request failed"
        return `data: ${JSON.stringify(buildGeminiErrorPayload(getErrorStatus(error), message))}\n\n`
    }

    if (routeId === "messages") {
        return encodeAnthropicMessagesStreamError(error)
    }

    if (routeId === "responses") {
        return encodeOpenAIResponsesStreamError(error)
    }

    return encodeOpenAIChatStreamError(error)
}

const parseClientRequest = (
    routeId: RouteId,
    requestBody: any,
    isStream: boolean,
): CanonicalRequest => {
    if (routeId === "chat-completions") {
        return normalizeOpenAIChatRequest(
            openAIChatCompletionRequestSchema.parse(requestBody)
        )
    }

    if (routeId === "messages") {
        return normalizeAnthropicMessagesRequest(
            anthropicMessagesRequestSchema.parse(requestBody)
        )
    }

    if (routeId === "gemini-generate-content") {
        return normalizeGeminiGenerateContentRequest({
            ...geminiGenerateContentRequestSchema.parse(requestBody),
            model: String(requestBody?.model ?? ""),
            stream: isStream,
        })
    }

    return normalizeOpenAIResponsesRequest(
        openAIResponsesRequestSchema.parse(requestBody)
    )
}

const createInvalidPayloadError = (routeId: RouteId): GatewayError => {
    return new GatewayError(
        `Invalid ${ROUTE_PAYLOAD_LABELS[routeId as Exclude<RouteId, "audio-speech">]} request payload`,
        {
            code: "request_invalid_payload",
            category: "request",
            httpStatus: 400,
            retryable: false,
        }
    )
}

const createUnsupportedSemanticsError = (
    message: string,
    code: string,
    param: string | undefined,
): GatewayError => {
    return new GatewayError(message, {
        code,
        category: "request",
        httpStatus: 400,
        retryable: false,
        ...(param ? { param } : {}),
    })
}

const OPENAI_RESPONSES_ONLY_FIELDS: Array<[string, (request: CanonicalRequest) => unknown]> = [
    ["previous_response_id", (request) => request.previousResponseId],
    ["conversation", (request) => request.conversationId],
    ["prompt", (request) => request.prompt],
    ["reasoning.summary", (request) => request.reasoningSummary],
    ["truncation", (request) => request.responseTruncation],
    ["text.verbosity", (request) => request.responseTextVerbosity],
    ["include", (request) => request.providerMetadata?.openai?.responsesOutputTextLogprobs],
    ["top_logprobs", (request) => request.providerMetadata?.openai?.responsesTopLogprobs],
]

type NativeResponsesRequest = NonNullable<NonNullable<CanonicalRequest["nativeRequest"]>["openaiResponses"]>

const collectNativeResponsesReasons = (native: NativeResponsesRequest): string[] => {
    const reasons: string[] = []
    const toolTypes = new Set<string>()

    for (const tool of native.tools ?? []) {
        if (tool && typeof tool === "object" && "type" in tool && typeof tool.type === "string") {
            toolTypes.add(tool.type)
        }
    }

    if (toolTypes.size > 0) {
        reasons.push(`tools: ${[...toolTypes].join(", ")}`)
    }

    const inputTypes = new Set<string>()
    const input = native.input

    if (Array.isArray(input)) {
        for (const item of input) {
            if (!item || typeof item !== "object") {
                continue
            }

            const itemType = "type" in item && typeof item.type === "string"
                ? item.type
                : undefined
            if (itemType && itemType !== "message") {
                inputTypes.add(itemType)
            }

            if (!("content" in item) || !Array.isArray(item.content)) {
                continue
            }

            for (const block of item.content) {
                if (
                    block
                    && typeof block === "object"
                    && "type" in block
                    && typeof block.type === "string"
                    && block.type !== "input_text"
                    && block.type !== "output_text"
                ) {
                    inputTypes.add(block.type)
                }
            }
        }
    }

    if (inputTypes.size > 0) {
        reasons.push(`input: ${[...inputTypes].slice(0, 6).join(", ")}`)
    }

    if (native.include?.includes("reasoning.encrypted_content")) {
        reasons.push("include: reasoning.encrypted_content")
    }

    if (reasons.length === 0) {
        reasons.push("native Responses payload")
    }

    return reasons
}

const describeChannelForError = (config: Partial<ChannelConfig>): string => {
    const name = config.name || "unnamed"
    const type = config.type || "unknown"

    return config.channel_key
        ? `Channel "${name}" (key: ${config.channel_key}, type: ${type})`
        : `Channel "${name}" (type: ${type})`
}

/**
 * Rejects requests carrying semantics the conversion target cannot express, naming the
 * offending features, the channel, and its protocols so the operator can fix routing.
 */
const assertConversionSupported = (
    canonical: CanonicalRequest,
    targetProtocol: UpstreamProtocol,
    config: Partial<ChannelConfig>,
    supportedProtocols: UpstreamProtocol[],
): void => {
    if (targetProtocol === "openai-responses") {
        return
    }

    const fieldReasons = OPENAI_RESPONSES_ONLY_FIELDS
        .filter(([, getValue]) => getValue(canonical) !== undefined)
        .map(([field]) => field)
    const param = fieldReasons[0]
    const reasons: string[] = []
    let semantics = "OpenAI Responses"
    let code = "request_unsupported_openai_semantics"

    const nativeResponses = canonical.nativeRequest?.openaiResponses
    if (nativeResponses !== undefined) {
        reasons.push(...collectNativeResponsesReasons(nativeResponses))
    }

    if (
        targetProtocol !== "anthropic-messages"
        && canonical.nativeRequest?.anthropicMessages !== undefined
    ) {
        semantics = "Anthropic Messages"
        code = "request_unsupported_anthropic_semantics"
        reasons.push("native Anthropic Messages content blocks")
    }

    reasons.push(...fieldReasons)

    if (reasons.length === 0) {
        return
    }

    throw createUnsupportedSemanticsError(
        `This request uses ${semantics} semantics that cannot be converted to "${targetProtocol}". `
        + `Unsupported features: ${reasons.join(", ")}. `
        + `${describeChannelForError(config)} supports: ${supportedProtocols.join(", ")}; `
        + `conversion target: "${targetProtocol}". `
        + `Enable ${semantics} for this channel, or route this model to a channel that supports it.`,
        code,
        param,
    )
}

/**
 * Adapters build `{baseUrl}{path}` themselves. An endpoint ending in "#" must be used
 * verbatim, so the fetcher rewrites origin and path while keeping the query parameters
 * the adapter added (`alt=sse`, forwarded query).
 */
const createExactUrlFetcher = (endpoint: string): typeof fetch => {
    const exactUrl = new URL(endpoint.replace(/#$/, ""))

    return ((input: RequestInfo | URL, init?: RequestInit) => {
        const requestedUrl = new URL(
            input instanceof Request
                ? input.url
                : input instanceof URL
                    ? input.toString()
                    : String(input)
        )
        const targetUrl = new URL(exactUrl.toString())

        requestedUrl.searchParams.forEach((value, key) => {
            targetUrl.searchParams.set(key, value)
        })

        return fetch(targetUrl, init)
    }) as typeof fetch
}

const createAdapter = (
    descriptor: ChannelProtocolDescriptor,
    config: ChannelConfig,
    baseUrl: string,
    apiKey: string,
): ProviderAdapter => {
    // Gemini native endpoints are bases for `/models/{model}:{action}`, so "#" only pins
    // the base path and the adapter still appends the model route.
    const fetcher = config.endpoint?.endsWith("#") && descriptor.provider !== "gemini"
        ? createExactUrlFetcher(config.endpoint)
        : undefined

    if (descriptor.provider === "anthropic") {
        return new AnthropicProviderAdapter({
            apiKey,
            baseUrl,
            defaultMaxTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
            ...(fetcher ? { fetcher } : {}),
        })
    }

    if (descriptor.provider === "gemini") {
        return new GeminiProviderAdapter({
            apiKey,
            baseUrl,
        })
    }

    return new OpenAIProviderAdapter({
        apiKey,
        baseUrl,
        auth: descriptor.auth,
        ...(fetcher ? { fetcher } : {}),
    })
}

const toRepoUsage = (upstreamProtocol: UpstreamProtocol, usage: CanonicalUsage): Usage => {
    return {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        ...(upstreamProtocol !== "anthropic-messages" && usage.cachedInputTokens !== undefined
            ? { cached_tokens: usage.cachedInputTokens }
            : {}),
    }
}

const buildForwardedHeaders = (
    request: Request,
    upstreamProtocol: UpstreamProtocol,
): Record<string, string> => {
    const headers = buildUpstreamRequestHeaders(request, {
        allowHeaders: getUpstreamHeaderAllowlist(upstreamProtocol),
    })

    const forwarded: Record<string, string> = {}
    headers.forEach((value, name) => {
        forwarded[name] = value
    })
    return forwarded
}

const encodeNonStreamResponse = (
    c: Context<HonoCustomType>,
    routeId: RouteId,
    response: CanonicalResponse,
): Response => {
    if (routeId === "gemini-generate-content") {
        return c.json(encodeCanonicalToGeminiGenerateContentResponse(response))
    }

    if (routeId === "messages") {
        return c.json(encodeCanonicalToAnthropicMessagesResponse(response))
    }

    if (routeId === "responses") {
        // The encoder overloads discriminate on nativeResponse.openaiResponses; the
        // compatibility guard already rejected native Responses payloads when the
        // upstream protocol differs, so this response carries no native payload.
        const encodedResponse = encodeCanonicalToOpenAIResponsesResponse(
            response as CanonicalResponse & {
                nativeResponse?: CanonicalResponse["nativeResponse"] & {
                    openaiResponses?: undefined
                }
            }
        )
        return c.json(encodedResponse)
    }

    return c.json(encodeCanonicalToOpenAIChatResponse(response))
}

const saveUsageSafely = async (
    saveUsage: (usage: Usage) => Promise<void>,
    usage: Usage,
): Promise<void> => {
    try {
        await saveUsage(usage)
    } catch (error) {
        console.warn("Failed to save converted usage:", error)
    }
}

export default {
    async fetch(
        c: Context<HonoCustomType>,
        config: ChannelConfig,
        requestBody: any,
        saveUsage: (usage: Usage) => Promise<void>,
        trackingState: RequestTrackingState,
        routeId: RouteId,
    ): Promise<Response> {
        const targetProtocol = resolvePrimaryProtocol(config)

        if (!targetProtocol) {
            trackingState.upstreamStatus = 500
            trackingState.errorSummary = "Channel has no upstream protocol available for conversion"
            return buildErrorResponse(routeId, createConversionNotRequiredError())
        }

        const descriptor = resolveProtocolDescriptor(config, targetProtocol)
        const upstreamProtocol = targetProtocol

        const geminiTarget = routeId === "gemini-generate-content"
            ? parseGeminiRouteTarget(new URL(c.req.url).pathname)
            : null
        const isStream = geminiTarget ? geminiTarget.stream : requestBody?.stream === true

        let canonical: CanonicalRequest
        try {
            canonical = parseClientRequest(routeId, requestBody, isStream)
            assertConversionSupported(
                canonical,
                targetProtocol,
                config,
                resolveChannelProtocols(config),
            )
        } catch (error) {
            const payloadError = error instanceof GatewayError
                ? error
                : createInvalidPayloadError(routeId)

            trackingState.upstreamStatus = payloadError.httpStatus
            trackingState.errorSummary = payloadError.message
            trackingState.lastErrorCode = payloadError.code
            return buildErrorResponse(routeId, payloadError)
        }

        const base = resolveUpstreamBase(config, targetProtocol)
        const adapter = createAdapter(descriptor, config, base.baseUrl, config.api_key || "")
        const requestId = crypto.randomUUID()
        const providerContext: ProviderRequestContext = {
            requestId,
            signal: c.req.raw.signal,
            ...(descriptor.requestMode ? { requestMode: descriptor.requestMode } : {}),
            forwardedHeaders: buildForwardedHeaders(c.req.raw, upstreamProtocol),
            forwardedQuery: base.query,
        }

        if (!canonical.stream) {
            let response: CanonicalResponse
            try {
                response = await adapter.complete(canonical, providerContext)
            } catch (error) {
                trackingState.upstreamStatus = getErrorStatus(error)
                trackingState.errorSummary = error instanceof Error ? error.message : "Upstream request failed"
                return buildErrorResponse(routeId, error)
            }

            trackingState.upstreamStatus = 200
            if (response.usage) {
                await saveUsageSafely(saveUsage, toRepoUsage(upstreamProtocol, response.usage))
            }

            return encodeNonStreamResponse(c, routeId, response)
        }

        if (!adapter.stream) {
            return buildErrorResponse(routeId, createConversionNotRequiredError())
        }

        const streamId = routeId === "messages"
            ? `msg_${requestId}`
            : routeId === "responses"
                ? `resp_${requestId}`
                : `chatcmpl_${requestId}`
        const iterator = createStreamReassemblyIterable(
            adapter.stream(canonical, providerContext),
            streamId,
            canonical.model,
        )[Symbol.asyncIterator]()

        let firstEvent: CanonicalStreamEvent
        try {
            const first = await iterator.next()
            if (first.done) {
                const error = new GatewayError("Upstream provider returned an empty stream", {
                    code: "provider_upstream_error",
                    category: "provider",
                    httpStatus: 502,
                    retryable: true,
                })
                trackingState.upstreamStatus = 502
                trackingState.errorSummary = error.message
                return buildErrorResponse(routeId, error)
            }
            firstEvent = first.value
        } catch (error) {
            trackingState.upstreamStatus = getErrorStatus(error)
            trackingState.errorSummary = error instanceof Error ? error.message : "Upstream request failed"
            return buildErrorResponse(routeId, error)
        }

        trackingState.upstreamStatus = 200

        const includeUsage = canonical.providerMetadata?.openai?.chatIncludeUsage === true
        const anthropicState = {
            startedTextBlock: false,
            startedToolBlocks: [] as number[],
            pendingToolStops: [] as number[],
        }
        const responsesState = {
            sequenceNumber: 0,
            accumulatedOutputText: "",
            accumulatedReasoningSummary: "",
            accumulatedReasoningRawContent: "",
            startedTextOutput: false,
            startedReasoningOutput: false,
            parallelToolCalls: undefined as boolean | undefined,
            startedToolCallIds: new Set<string>(),
            streamedToolCalls: new Map<string, {
                toolCallId: string
                toolCallName?: string
                toolCallArguments: string
                outputIndex: number
                toolType?: "function_call" | "custom_tool_call"
            }>(),
        }
        const geminiState: Parameters<typeof encodeCanonicalToGeminiGenerateContentStreamEvents>[1] = {
            toolCalls: new Map(),
        }

        let usageSaved = false
        let sawOutput = false
        let accumulatedOutput = ""
        const maybeSaveUsage = async (usage: Usage | null) => {
            if (!usage || usageSaved) {
                return
            }

            usageSaved = true
            await saveUsageSafely(saveUsage, usage)
        }

        const writeEvent = async (
            event: CanonicalStreamEvent,
            controller: ReadableStreamDefaultController<Uint8Array>,
            encoder: TextEncoder,
        ) => {
            if (event.type === "output_text_delta") {
                accumulatedOutput += event.delta
                sawOutput = true
            }

            if (event.type === "tool_call_delta") {
                accumulatedOutput += event.argumentsDelta
                sawOutput = true
            }

            if (event.type === "response_completed" && event.usage) {
                await maybeSaveUsage(toRepoUsage(upstreamProtocol, event.usage))
            }

            if (routeId === "gemini-generate-content") {
                for (const payload of encodeCanonicalToGeminiGenerateContentStreamEvents(event, geminiState)) {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
                    )
                }
                return
            }

            if (routeId === "messages") {
                for (const anthropicEvent of encodeCanonicalToAnthropicMessagesStreamEvents(event, anthropicState)) {
                    controller.enqueue(
                        encoder.encode(
                            `event: ${anthropicEvent.type}\ndata: ${JSON.stringify(anthropicEvent)}\n\n`
                        )
                    )
                }
                return
            }

            if (routeId === "responses") {
                await writeResponsesEvent(event, controller, encoder, responsesState)
                return
            }

            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify(
                        encodeCanonicalToOpenAIChatStreamChunk(event, streamId, includeUsage)
                    )}\n\n`
                )
            )
        }

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const encoder = new TextEncoder()

                try {
                    await writeEvent(firstEvent, controller, encoder)

                    while (true) {
                        const next = await iterator.next()
                        if (next.done) {
                            break
                        }
                        await writeEvent(next.value, controller, encoder)
                    }

                    if (routeId === "chat-completions" || routeId === "responses") {
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                    }
                    controller.close()
                } catch (error) {
                    console.warn("Protocol conversion stream failed:", error)
                    try {
                        controller.enqueue(encoder.encode(renderStreamError(routeId, error)))
                        controller.close()
                    } catch {
                        // Stream already closed by the client.
                    }
                } finally {
                    if (!usageSaved && sawOutput) {
                        await maybeSaveUsage(
                            estimateUsageFromBodies(requestBody, undefined, accumulatedOutput)
                        )
                    }
                }
            },
            async cancel() {
                await iterator.return?.()
            },
        })

        return new Response(stream, {
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                "connection": "keep-alive",
            },
        })
    },
}

type ResponsesStreamState = {
    sequenceNumber: number
    accumulatedOutputText: string
    accumulatedReasoningSummary: string
    accumulatedReasoningRawContent: string
    startedTextOutput: boolean
    startedReasoningOutput: boolean
    parallelToolCalls: boolean | undefined
    startedToolCallIds: Set<string>
    streamedToolCalls: Map<string, {
        toolCallId: string
        toolCallName?: string
        toolCallArguments: string
        outputIndex: number
        toolType?: "function_call" | "custom_tool_call"
    }>
}

const writeResponsesEvent = async (
    event: CanonicalStreamEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    state: ResponsesStreamState,
): Promise<void> => {
    if (event.type === "output_text_delta") {
        state.accumulatedOutputText += event.delta
    }

    if (event.type === "reasoning_summary_delta") {
        state.accumulatedReasoningSummary += event.delta
    }

    if (event.type === "reasoning_raw_content_delta") {
        state.accumulatedReasoningRawContent += event.delta
    }

    if (event.type === "tool_call_delta") {
        const currentToolCall = state.streamedToolCalls.get(event.toolCallId) ?? {
            toolCallId: event.toolCallId,
            toolCallArguments: "",
            outputIndex: event.toolIndex,
        }
        if (event.toolName !== undefined) {
            currentToolCall.toolCallName = event.toolName
        }
        currentToolCall.toolType =
            event.nativeEvent?.openaiResponses
            && typeof event.nativeEvent.openaiResponses === "object"
            && event.nativeEvent.openaiResponses !== null
            && (event.nativeEvent.openaiResponses as Record<string, unknown>).type === "response.custom_tool_call_input.delta"
                ? "custom_tool_call"
                : (currentToolCall.toolType ?? "function_call")
        currentToolCall.toolCallArguments += event.argumentsDelta
        currentToolCall.outputIndex =
            event.toolIndex
            + (state.startedReasoningOutput ? 1 : 0)
            + (state.startedTextOutput ? 1 : 0)
        state.streamedToolCalls.set(event.toolCallId, currentToolCall)
    }

    if (
        (event.type === "response_started" || event.type === "response_completed")
        && event.parallelToolCalls !== undefined
    ) {
        state.parallelToolCalls = event.parallelToolCalls
    }

    const toolCallState = event.type === "tool_call_delta"
        ? state.streamedToolCalls.get(event.toolCallId)
        : undefined
    const encodedBatch = encodeCanonicalToOpenAIResponsesStreamEvent(event, {
        sequenceNumber: state.sequenceNumber,
        outputIndex: event.type === "tool_call_delta"
            ? (toolCallState?.outputIndex ?? event.toolIndex)
            : 0,
        contentIndex: 0,
        ...(state.startedTextOutput ? { startedTextOutput: true } : {}),
        ...(state.startedReasoningOutput ? { startedReasoningOutput: true } : {}),
        ...(state.startedToolCallIds.size > 0
            ? { startedToolCallIds: Array.from(state.startedToolCallIds) }
            : {}),
        ...(event.type === "tool_call_delta"
            ? {
                toolCallId: event.toolCallId,
                ...(event.toolName !== undefined ? { toolCallName: event.toolName } : {}),
                ...(toolCallState?.toolType !== undefined
                    ? { toolCallType: toolCallState.toolType }
                    : {}),
                ...(state.startedToolCallIds.has(event.toolCallId) && toolCallState !== undefined
                    ? { toolCallArguments: toolCallState.toolCallArguments }
                    : {}),
            }
            : {}),
        ...(state.streamedToolCalls.size > 0
            ? {
                toolCalls: Array.from(state.streamedToolCalls.values()).sort(
                    (left, right) => left.outputIndex - right.outputIndex
                ),
            }
            : {}),
        ...(state.parallelToolCalls !== undefined
            ? { parallelToolCalls: state.parallelToolCalls }
            : {}),
        ...(state.accumulatedReasoningSummary.length > 0
            ? { reasoningSummary: state.accumulatedReasoningSummary }
            : {}),
        ...(state.accumulatedReasoningRawContent.length > 0
            ? { reasoningRawContent: state.accumulatedReasoningRawContent }
            : {}),
        ...(event.type === "response_completed"
            ? { outputText: state.accumulatedOutputText }
            : {}),
    })

    if (event.type === "output_text_delta") {
        state.startedTextOutput = true
    }

    if (event.type === "reasoning_summary_delta") {
        state.startedReasoningOutput = true
    }

    if (event.type === "tool_call_delta") {
        state.startedToolCallIds.add(event.toolCallId)
    }

    state.sequenceNumber = encodedBatch.nextSequenceNumber

    for (const encodedEvent of encodedBatch.events) {
        const typedEvent = encodedEvent as { type: string }
        controller.enqueue(
            encoder.encode(`event: ${typedEvent.type}\ndata: ${JSON.stringify(encodedEvent)}\n\n`)
        )
    }
}
