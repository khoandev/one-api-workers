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
    encodeCanonicalToOpenAIChatResponse,
    encodeCanonicalToOpenAIChatStreamChunk,
    encodeCanonicalToOpenAIResponsesResponse,
    encodeCanonicalToOpenAIResponsesStreamEvent,
    encodeAnthropicMessagesStreamError,
    encodeOpenAIChatStreamError,
    encodeOpenAIResponsesStreamError,
    normalizeAnthropicMessagesRequest,
    normalizeOpenAIChatRequest,
    normalizeOpenAIResponsesRequest,
} from "../airlock/canonical/index"
import {
    anthropicMessagesRequestSchema,
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
import {
    getChannelProtocolDescriptor,
    getRouteProtocol,
    getUpstreamHeaderAllowlist,
    resolveUpstreamBase,
    type ChannelProtocolDescriptor,
    type UpstreamProtocol,
} from "./shared/protocol-registry"
import type { RouteId } from "./shared/route-policy"
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
            },
        }
    }

    return {
        error: {
            message,
            type: upstreamErrorCode ?? mappedType,
            code,
        },
    }
}

const buildErrorResponse = (routeId: RouteId, error: unknown): Response => {
    const message = error instanceof Error ? error.message : "Upstream request failed"
    return new Response(
        JSON.stringify(buildErrorPayload(routeId, error, message)),
        {
            status: getErrorStatus(error),
            headers: { "content-type": "application/json; charset=utf-8" },
        }
    )
}

const createConversionNotRequiredError = (): GatewayError => {
    return new GatewayError("Protocol conversion is not required for this channel", {
        code: "protocol_conversion_not_required",
        category: "configuration",
        httpStatus: 500,
        retryable: false,
    })
}

const renderStreamError = (routeId: RouteId, error: unknown): string => {
    if (routeId === "messages") {
        return encodeAnthropicMessagesStreamError(error)
    }

    if (routeId === "responses") {
        return encodeOpenAIResponsesStreamError(error)
    }

    return encodeOpenAIChatStreamError(error)
}

const parseClientRequest = (routeId: RouteId, requestBody: any): CanonicalRequest => {
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

const createUnsupportedSemanticsError = (message: string): GatewayError => {
    return new GatewayError(message, {
        code: "request_unsupported_openai_semantics",
        category: "request",
        httpStatus: 400,
        retryable: false,
    })
}

const assertConversionSupported = (
    canonical: CanonicalRequest,
    upstreamProtocol: UpstreamProtocol,
): void => {
    if (upstreamProtocol === "openai-responses") {
        return
    }

    if (canonical.nativeRequest?.openaiResponses !== undefined) {
        throw createUnsupportedSemanticsError(
            "This request relies on OpenAI Responses semantics that cannot be converted to the selected channel protocol"
        )
    }

    if (
        upstreamProtocol !== "anthropic-messages"
        && canonical.nativeRequest?.anthropicMessages !== undefined
    ) {
        throw createUnsupportedSemanticsError(
            "This request relies on Anthropic Messages semantics that cannot be converted to the selected channel protocol"
        )
    }

    const openAIResponsesOnlyFields: Array<[string, unknown]> = [
        ["previous_response_id", canonical.previousResponseId],
        ["conversation", canonical.conversationId],
        ["prompt", canonical.prompt],
        ["reasoning.summary", canonical.reasoningSummary],
        ["truncation", canonical.responseTruncation],
        ["text.verbosity", canonical.responseTextVerbosity],
        ["include", canonical.providerMetadata?.openai?.responsesOutputTextLogprobs],
        ["top_logprobs", canonical.providerMetadata?.openai?.responsesTopLogprobs],
    ]
    const usedField = openAIResponsesOnlyFields.find(([, value]) => value !== undefined)

    if (usedField) {
        throw createUnsupportedSemanticsError(
            `"${usedField[0]}" requires an OpenAI Responses compatible channel`
        )
    }
}

const createAdapter = (
    descriptor: ChannelProtocolDescriptor,
    baseUrl: string,
    apiKey: string,
): ProviderAdapter => {
    if (descriptor.provider === "anthropic") {
        return new AnthropicProviderAdapter({
            apiKey,
            baseUrl,
            defaultMaxTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
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
        if (routeId === "audio-speech") {
            return buildErrorResponse(routeId, createConversionNotRequiredError())
        }

        const descriptor = getChannelProtocolDescriptor(config.type)
        const upstreamProtocol = descriptor?.protocol
        const clientProtocol = getRouteProtocol(routeId)

        if (!descriptor || !upstreamProtocol || !clientProtocol || clientProtocol === upstreamProtocol) {
            return buildErrorResponse(routeId, createConversionNotRequiredError())
        }

        let canonical: CanonicalRequest
        try {
            canonical = parseClientRequest(routeId, requestBody)
            assertConversionSupported(canonical, upstreamProtocol)
        } catch (error) {
            const payloadError = error instanceof GatewayError
                ? error
                : createInvalidPayloadError(routeId)

            trackingState.upstreamStatus = payloadError.httpStatus
            trackingState.errorSummary = payloadError.message
            return buildErrorResponse(routeId, payloadError)
        }

        const base = resolveUpstreamBase(config)
        const adapter = createAdapter(descriptor, base.baseUrl, config.api_key || "")
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
