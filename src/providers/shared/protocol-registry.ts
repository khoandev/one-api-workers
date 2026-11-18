import type { OpenAIProviderAdapterAuth } from "../../airlock/providers/openai-adapter"
import type { RouteId } from "./route-policy"
import { buildAzureTargetUrlFromPath } from "./azure-target-url"
import { buildPrefixedTargetUrl } from "./prefixed-target-url"
import {
    CLAUDE_UPSTREAM_HEADER_ALLOWLIST,
    GEMINI_UPSTREAM_HEADER_ALLOWLIST,
    OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST,
} from "./upstream-request-headers"

export type UpstreamProtocol =
    | "openai-chat"
    | "openai-responses"
    | "anthropic-messages"
    | "gemini-generate-content"

export type ChannelProtocolDescriptor = {
    protocol: UpstreamProtocol
    provider: "openai" | "anthropic" | "gemini"
    requestMode?: "openai_chat" | "openai_responses"
    auth?: OpenAIProviderAdapterAuth
}

const AZURE_AUTH: OpenAIProviderAdapterAuth = {
    type: "header_value",
    headerName: "api-key",
}

const CHANNEL_PROTOCOLS: Record<string, ChannelProtocolDescriptor> = {
    "openai": {
        protocol: "openai-chat",
        provider: "openai",
        requestMode: "openai_chat",
    },
    "claude-to-openai": {
        protocol: "openai-chat",
        provider: "openai",
        requestMode: "openai_chat",
    },
    "gemini": {
        protocol: "openai-chat",
        provider: "openai",
        requestMode: "openai_chat",
    },
    "azure-openai": {
        protocol: "openai-chat",
        provider: "openai",
        requestMode: "openai_chat",
        auth: AZURE_AUTH,
    },
    "openai-responses": {
        protocol: "openai-responses",
        provider: "openai",
        requestMode: "openai_responses",
    },
    "azure-openai-responses": {
        protocol: "openai-responses",
        provider: "openai",
        requestMode: "openai_responses",
        auth: AZURE_AUTH,
    },
    "claude": {
        protocol: "anthropic-messages",
        provider: "anthropic",
    },
    "gemini-native": {
        protocol: "gemini-generate-content",
        provider: "gemini",
    },
}

const AUDIO_CHANNEL_TYPES = ["openai-audio", "azure-openai-audio"]

const ROUTE_PROTOCOLS: Record<RouteId, UpstreamProtocol | null> = {
    "chat-completions": "openai-chat",
    "messages": "anthropic-messages",
    "responses": "openai-responses",
    "gemini-generate-content": "gemini-generate-content",
    "audio-speech": null,
}

export const isAudioChannelType = (type: string | undefined | null): boolean => {
    return !!type && AUDIO_CHANNEL_TYPES.includes(type)
}

export const getRouteProtocol = (routeId: RouteId): UpstreamProtocol | null => {
    return ROUTE_PROTOCOLS[routeId]
}

export const getChannelProtocolDescriptor = (
    type: string | undefined | null
): ChannelProtocolDescriptor | undefined => {
    if (!type) return undefined
    return CHANNEL_PROTOCOLS[type]
}

const stripTrailingSegment = (pathname: string, segment: string): string => {
    if (pathname.endsWith(segment)) {
        return pathname.slice(0, -segment.length)
    }
    return pathname
}

const buildBaseResult = (targetUrl: URL, trailingSegment: string) => {
    const query: Record<string, string> = {}
    targetUrl.searchParams.forEach((value, key) => {
        query[key] = value
    })

    const pathname = stripTrailingSegment(targetUrl.pathname, trailingSegment)
        .replace(/\/+$/, "")

    return {
        baseUrl: `${targetUrl.origin}${pathname}`,
        query,
    }
}

/**
 * Gemini native endpoints are bases for `/models/{model}:{action}`.
 * A trailing "#" keeps the configured path verbatim instead of appending `/v1beta`.
 */
export const normalizeGeminiNativeBaseUrl = (endpoint: string): string => {
    const targetUrl = new URL(endpoint.replace(/#$/, ""))
    const pathname = targetUrl.pathname.replace(/\/+$/, "")

    if (endpoint.endsWith("#")) {
        return `${targetUrl.origin}${pathname}`
    }

    const normalizedPath = pathname.endsWith("/v1beta") || pathname.endsWith("/v1")
        ? pathname
        : `${pathname}/v1beta`

    return `${targetUrl.origin}${normalizedPath}`
}

export const resolveUpstreamBase = (
    config: Pick<ChannelConfig, "type" | "endpoint">
): { baseUrl: string; query: Record<string, string> } => {
    const type = config.type
    const endpoint = config.endpoint

    if (type === "gemini-native") {
        const targetUrl = new URL(endpoint)
        const query: Record<string, string> = {}
        targetUrl.searchParams.forEach((value, key) => {
            query[key] = value
        })

        return { baseUrl: normalizeGeminiNativeBaseUrl(endpoint), query }
    }

    if (type === "azure-openai-responses") {
        return buildBaseResult(
            buildAzureTargetUrlFromPath(endpoint, "/v1/responses"),
            "/responses",
        )
    }

    if (type === "azure-openai") {
        return buildBaseResult(
            buildAzureTargetUrlFromPath(endpoint, "/v1/chat/completions"),
            "/chat/completions",
        )
    }

    if (type === "openai-responses") {
        return buildBaseResult(
            buildPrefixedTargetUrl(endpoint, "/v1/responses"),
            "/responses",
        )
    }

    if (type === "claude") {
        return buildBaseResult(
            buildPrefixedTargetUrl(endpoint, "/v1/messages"),
            "/messages",
        )
    }

    return buildBaseResult(
        buildPrefixedTargetUrl(endpoint, "/v1/chat/completions", "/v1", type),
        "/chat/completions",
    )
}

export const getUpstreamHeaderAllowlist = (
    protocol: UpstreamProtocol
): string[] => {
    if (protocol === "anthropic-messages") {
        return CLAUDE_UPSTREAM_HEADER_ALLOWLIST
    }

    if (protocol === "gemini-generate-content") {
        return GEMINI_UPSTREAM_HEADER_ALLOWLIST
    }

    return OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST
}
