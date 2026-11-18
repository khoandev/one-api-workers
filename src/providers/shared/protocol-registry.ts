import type { OpenAIProviderAdapterAuth } from "../../airlock/providers/openai-adapter"
import type { RouteId } from "./route-policy"
import { buildAzureTargetUrlFromPath } from "./azure-target-url"
import { buildPrefixedTargetUrl } from "./prefixed-target-url"
import {
    CLAUDE_UPSTREAM_HEADER_ALLOWLIST,
    GEMINI_UPSTREAM_HEADER_ALLOWLIST,
    OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST,
} from "./upstream-request-headers"

export type UpstreamProtocol = ChannelProtocol

export type ChannelProtocolDescriptor = {
    protocol: UpstreamProtocol
    provider: "openai" | "anthropic" | "gemini"
    requestMode?: "openai_chat" | "openai_responses"
    auth?: OpenAIProviderAdapterAuth
}

export const TEXT_UPSTREAM_PROTOCOLS: UpstreamProtocol[] = [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "gemini-generate-content",
]

export const DEFAULT_CHANNEL_PROTOCOLS: Record<string, UpstreamProtocol[]> = {
    "openai": ["openai-chat"],
    "openai-responses": ["openai-responses"],
    "claude": ["anthropic-messages"],
    "gemini-native": ["gemini-generate-content"],
    "azure-openai": ["openai-chat"],
    "azure-openai-responses": ["openai-responses"],
}

const AZURE_TEXT_PROTOCOLS: UpstreamProtocol[] = ["openai-chat", "openai-responses"]

const AZURE_CHANNEL_TYPES = ["azure-openai", "azure-openai-responses", "azure-openai-audio"]

const AZURE_AUTH: OpenAIProviderAdapterAuth = {
    type: "header_value",
    headerName: "api-key",
}

const PROTOCOL_DESCRIPTORS: Record<UpstreamProtocol, ChannelProtocolDescriptor> = {
    "openai-chat": {
        protocol: "openai-chat",
        provider: "openai",
        requestMode: "openai_chat",
    },
    "openai-responses": {
        protocol: "openai-responses",
        provider: "openai",
        requestMode: "openai_responses",
    },
    "anthropic-messages": {
        protocol: "anthropic-messages",
        provider: "anthropic",
    },
    "gemini-generate-content": {
        protocol: "gemini-generate-content",
        provider: "gemini",
    },
}

const ROUTE_PROTOCOLS: Record<RouteId, UpstreamProtocol | null> = {
    "chat-completions": "openai-chat",
    "messages": "anthropic-messages",
    "responses": "openai-responses",
    "gemini-generate-content": "gemini-generate-content",
    "audio-speech": null,
}

const ROUTE_REQUEST_PATHS: Partial<Record<UpstreamProtocol, string>> = {
    "openai-chat": "/v1/chat/completions",
    "openai-responses": "/v1/responses",
    "anthropic-messages": "/v1/messages",
}

const ROUTE_TRAILING_SEGMENTS: Partial<Record<UpstreamProtocol, string>> = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
}

const AUDIO_CHANNEL_TYPES = ["openai-audio", "azure-openai-audio"]

export const isAudioChannelType = (type: string | undefined | null): boolean => {
    return !!type && AUDIO_CHANNEL_TYPES.includes(type)
}

export const isAzureChannelType = (type: string | undefined | null): boolean => {
    return !!type && AZURE_CHANNEL_TYPES.includes(type)
}

export const getRouteProtocol = (routeId: RouteId): UpstreamProtocol | null => {
    return ROUTE_PROTOCOLS[routeId]
}

/**
 * Protocols a channel type may declare. Audio channels serve no text protocol.
 */
export const getAllowedChannelProtocols = (
    type: ChannelType | string | undefined | null
): UpstreamProtocol[] => {
    if (!type || isAudioChannelType(type) || !Object.hasOwn(DEFAULT_CHANNEL_PROTOCOLS, type)) {
        return []
    }

    if (type === "azure-openai" || type === "azure-openai-responses") {
        return AZURE_TEXT_PROTOCOLS
    }

    return TEXT_UPSTREAM_PROTOCOLS
}

/**
 * Protocols the channel serves natively (verbatim, no conversion), in canonical order.
 * Channels without a declaration keep the historical default of their type.
 */
export const resolveChannelProtocols = (
    config: Partial<ChannelConfig>
): UpstreamProtocol[] => {
    const allowed = getAllowedChannelProtocols(config.type)
    if (allowed.length === 0) {
        return []
    }

    const declared = Array.isArray(config.protocols) ? config.protocols : []
    const supported = TEXT_UPSTREAM_PROTOCOLS.filter((protocol) => {
        return allowed.includes(protocol) && declared.includes(protocol)
    })

    if (supported.length > 0) {
        return supported
    }

    return (DEFAULT_CHANNEL_PROTOCOLS[config.type ?? ""] ?? [])
        .filter((protocol) => allowed.includes(protocol))
}

/**
 * Conversion target used when the incoming route protocol is not supported natively.
 */
export const resolvePrimaryProtocol = (
    config: Partial<ChannelConfig>
): UpstreamProtocol | null => {
    const supported = resolveChannelProtocols(config)
    if (supported.length === 0) {
        return null
    }

    if (config.primary_protocol && supported.includes(config.primary_protocol)) {
        return config.primary_protocol
    }

    const typeDefault = (DEFAULT_CHANNEL_PROTOCOLS[config.type ?? ""] ?? [])
        .find((protocol) => supported.includes(protocol))

    return typeDefault ?? supported[0]
}

export const channelSupportsProtocol = (
    config: Partial<ChannelConfig>,
    protocol: UpstreamProtocol
): boolean => {
    return resolveChannelProtocols(config).includes(protocol)
}

export const resolveProtocolDescriptor = (
    config: Partial<ChannelConfig>,
    protocol: UpstreamProtocol
): ChannelProtocolDescriptor => {
    const descriptor = PROTOCOL_DESCRIPTORS[protocol]

    if (isAzureChannelType(config.type)) {
        return { ...descriptor, auth: AZURE_AUTH }
    }

    return descriptor
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
    config: Pick<ChannelConfig, "type" | "endpoint">,
    protocol: UpstreamProtocol,
): { baseUrl: string; query: Record<string, string> } => {
    const endpoint = config.endpoint

    if (protocol === "gemini-generate-content") {
        const targetUrl = new URL(endpoint)
        const query: Record<string, string> = {}
        targetUrl.searchParams.forEach((value, key) => {
            query[key] = value
        })

        return { baseUrl: normalizeGeminiNativeBaseUrl(endpoint), query }
    }

    const requestPath = ROUTE_REQUEST_PATHS[protocol] ?? "/v1/chat/completions"
    const trailingSegment = ROUTE_TRAILING_SEGMENTS[protocol] ?? "/chat/completions"

    if (isAzureChannelType(config.type)) {
        return buildBaseResult(
            buildAzureTargetUrlFromPath(endpoint, requestPath),
            trailingSegment,
        )
    }

    return buildBaseResult(
        buildPrefixedTargetUrl(endpoint, requestPath),
        trailingSegment,
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
