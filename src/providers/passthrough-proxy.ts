import { Context } from "hono"

import { DEFAULT_CLAUDE_API_VERSION } from "../channel-config"
import {
    checkoutAnthropicUsageData,
    handleAnthropicStreamResponse,
} from "./shared/anthropic-stream-utils"
import { buildAzureTargetUrlFromPath } from "./shared/azure-target-url"
import {
    checkoutGeminiUsageData,
    handleGeminiStreamResponse,
} from "./shared/gemini-stream-utils"
import { buildGeminiTargetUrl, type GeminiGenerateContentAction } from "./shared/gemini-target-url"
import {
    checkoutUsageData,
    handleStreamResponse,
} from "./shared/openai-stream-utils"
import { buildPrefixedTargetUrl } from "./shared/prefixed-target-url"
import {
    getRouteProtocol,
    getUpstreamHeaderAllowlist,
    resolveProtocolDescriptor,
    type ChannelProtocolDescriptor,
    type UpstreamProtocol,
} from "./shared/protocol-registry"
import {
    checkoutResponsesUsageData,
    handleStreamResponse as handleResponsesStreamResponse,
} from "./shared/responses-stream-utils"
import { parseGeminiRouteTarget, type RouteId } from "./shared/route-policy"
import {
    buildUpstreamRequestHeaders,
    OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST,
} from "./shared/upstream-request-headers"

const AZURE_CHANNEL_TYPES = ["azure-openai", "azure-openai-responses", "azure-openai-audio"]

const buildAuthHeaders = (
    config: ChannelConfig,
    descriptor: ChannelProtocolDescriptor | undefined,
): Record<string, string> => {
    const apiKey = config.api_key || ""

    if (descriptor?.provider === "anthropic") {
        return {
            "anthropic-version": DEFAULT_CLAUDE_API_VERSION,
            "x-api-key": apiKey,
        }
    }

    if (descriptor?.provider === "gemini") {
        return { "x-goog-api-key": apiKey }
    }

    if (descriptor?.auth) {
        return { [descriptor.auth.headerName]: apiKey }
    }

    // Audio channels have no protocol descriptor, but Azure audio still expects `api-key`.
    if (config.type === "azure-openai-audio") {
        return { "api-key": apiKey }
    }

    return { Authorization: `Bearer ${apiKey}` }
}

const resolveGeminiAction = (stream: boolean): GeminiGenerateContentAction => {
    return stream ? "streamGenerateContent" : "generateContent"
}

const buildTargetUrl = (
    request: Request,
    config: ChannelConfig,
    requestBody: any,
    descriptor: ChannelProtocolDescriptor | undefined,
    isStream: boolean,
): URL => {
    const pathname = new URL(request.url).pathname

    if (config.type && AZURE_CHANNEL_TYPES.includes(config.type)) {
        return buildAzureTargetUrlFromPath(config.endpoint, pathname)
    }

    if (descriptor?.provider === "gemini") {
        return buildGeminiTargetUrl(
            config.endpoint,
            String(requestBody?.model ?? ""),
            resolveGeminiAction(isStream),
        )
    }

    return buildPrefixedTargetUrl(config.endpoint, pathname)
}

/**
 * Gemini native endpoints take the model from the path and reject unknown body fields,
 * so the gateway-owned `model`/`stream` markers never reach upstream.
 */
const buildGeminiNativeBody = (requestBody: any): Record<string, unknown> => {
    if (!requestBody || typeof requestBody !== "object") {
        return {}
    }

    const { model: _model, stream: _stream, ...rest } = requestBody
    return rest as Record<string, unknown>
}

const buildRequestBody = (
    requestBody: any,
    descriptor: ChannelProtocolDescriptor | undefined,
    isStream: boolean,
): Record<string, unknown> => {
    if (descriptor?.provider === "gemini") {
        return buildGeminiNativeBody(requestBody)
    }

    const body: Record<string, unknown> = {
        ...(requestBody && typeof requestBody === "object" ? requestBody : {}),
    }

    if (isStream && descriptor?.protocol === "openai-chat") {
        body.stream_options = {
            ...((body.stream_options as Record<string, unknown> | undefined) ?? {}),
            include_usage: true,
        }
    }

    return body
}

const applyClientQuery = (targetUrl: URL, request: Request, isStream: boolean): void => {
    new URL(request.url).searchParams.forEach((value, key) => {
        if (key === "key" || key === "alt") {
            return
        }
        targetUrl.searchParams.set(key, value)
    })

    if (isStream) {
        targetUrl.searchParams.set("alt", "sse")
    }
}

const checkoutUsage = async (
    upstreamProtocol: UpstreamProtocol | undefined,
    saveUsage: (usage: Usage) => Promise<void>,
    response: Response,
    requestBody: any,
): Promise<void> => {
    if (upstreamProtocol === "anthropic-messages") {
        await checkoutAnthropicUsageData(saveUsage, response, requestBody)
        return
    }

    if (upstreamProtocol === "gemini-generate-content") {
        await checkoutGeminiUsageData(saveUsage, response, requestBody)
        return
    }

    if (upstreamProtocol === "openai-responses") {
        await checkoutResponsesUsageData(saveUsage, response, requestBody)
        return
    }

    await checkoutUsageData(saveUsage, response, requestBody)
}

const trackStreamUsage = async (
    upstreamProtocol: UpstreamProtocol | undefined,
    stream: ReadableStream<Uint8Array>,
    requestBody: any,
    saveUsage: (usage: Usage) => Promise<void>,
): Promise<void> => {
    if (upstreamProtocol === "anthropic-messages") {
        await handleAnthropicStreamResponse(stream, requestBody, saveUsage)
        return
    }

    if (upstreamProtocol === "gemini-generate-content") {
        await handleGeminiStreamResponse(stream, requestBody, saveUsage)
        return
    }

    if (upstreamProtocol === "openai-responses") {
        await handleResponsesStreamResponse(stream, requestBody, saveUsage)
        return
    }

    await handleStreamResponse(stream, requestBody, saveUsage)
}

/**
 * Forwards a request verbatim when the client protocol already matches the channel protocol.
 * The upstream body, headers, and SSE frames are preserved, so multimodal and native
 * provider fields survive untouched.
 */
export default {
    async fetch(
        c: Context<HonoCustomType>,
        config: ChannelConfig,
        requestBody: any,
        saveUsage: (usage: Usage) => Promise<void>,
        trackingState: RequestTrackingState,
        routeId: RouteId,
    ): Promise<Response> {
        const upstreamProtocol = getRouteProtocol(routeId) ?? undefined
        const descriptor = upstreamProtocol
            ? resolveProtocolDescriptor(config, upstreamProtocol)
            : undefined
        const geminiTarget = routeId === "gemini-generate-content"
            ? parseGeminiRouteTarget(new URL(c.req.url).pathname)
            : null
        const isStream = geminiTarget ? geminiTarget.stream : requestBody?.stream === true

        const targetUrl = buildTargetUrl(c.req.raw, config, requestBody, descriptor, isStream)

        if (descriptor?.provider === "gemini") {
            applyClientQuery(targetUrl, c.req.raw, isStream)
        }

        const headers = buildUpstreamRequestHeaders(c.req.raw, {
            allowHeaders: upstreamProtocol
                ? getUpstreamHeaderAllowlist(upstreamProtocol)
                : OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST,
            overrideHeaders: buildAuthHeaders(config, descriptor),
        })

        const proxyRequest = new Request(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(buildRequestBody(requestBody, descriptor, isStream)),
        })

        const response = await fetch(proxyRequest)
        trackingState.upstreamStatus = response.status

        if (!isStream) {
            if (response.ok) {
                await checkoutUsage(upstreamProtocol, saveUsage, response, requestBody)
            }
            return response
        }

        if (!response.ok || !response.body) {
            return response
        }

        const [streamForClient, streamForServer] = response.body.tee()
        c.executionCtx.waitUntil(
            trackStreamUsage(upstreamProtocol, streamForServer, requestBody, saveUsage).catch((error) => {
                console.warn("Failed to track usage from upstream stream:", error)
            }),
        )

        return new Response(streamForClient, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    },
}
