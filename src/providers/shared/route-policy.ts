import {
    isAudioChannelType,
    resolveChannelProtocols,
} from "./protocol-registry"

export type RouteId =
    | "chat-completions"
    | "messages"
    | "responses"
    | "audio-speech"
    | "gemini-generate-content"

export type GeminiRouteTarget = {
    model: string
    stream: boolean
}

const GEMINI_MODELS_PREFIX = "/v1beta/models/"

const GEMINI_ACTION_STREAMS: Record<string, boolean> = {
    generateContent: false,
    streamGenerateContent: true,
}

export const isGeminiModelsPath = (pathname: string): boolean => {
    return pathname.startsWith(GEMINI_MODELS_PREFIX)
}

/**
 * Parses `/v1beta/models/{model}:{action}` into the requested model and stream mode.
 * Returns null for unknown actions so the caller can answer with a 404.
 */
export const parseGeminiRouteTarget = (
    pathname: string
): GeminiRouteTarget | null => {
    if (!isGeminiModelsPath(pathname)) {
        return null
    }

    const modelAndAction = pathname.slice(GEMINI_MODELS_PREFIX.length)
    const separatorIndex = modelAndAction.lastIndexOf(":")
    if (separatorIndex <= 0) {
        return null
    }

    const action = modelAndAction.slice(separatorIndex + 1)
    if (!Object.hasOwn(GEMINI_ACTION_STREAMS, action)) {
        return null
    }

    const stream = GEMINI_ACTION_STREAMS[action]

    let model: string
    try {
        model = decodeURIComponent(modelAndAction.slice(0, separatorIndex))
    } catch {
        return null
    }

    return model ? { model, stream } : null
}

export const resolveRouteId = (pathname: string): RouteId | null => {
    if (isGeminiModelsPath(pathname)) {
        return parseGeminiRouteTarget(pathname) ? "gemini-generate-content" : null
    }
    if (pathname.endsWith("/chat/completions")) return "chat-completions"
    if (pathname.endsWith("/messages")) return "messages"
    if (pathname.endsWith("/responses")) return "responses"
    if (pathname.endsWith("/audio/speech")) return "audio-speech"
    return null
}

/**
 * A channel is usable for a route when its upstream protocol can serve the route,
 * either verbatim (same protocol) or through protocol conversion.
 * Audio channels only serve the audio route; text routes accept every text protocol,
 * including endpoints ending in "#".
 */
export const isChannelAllowedForRoute = (
    routeId: RouteId,
    config: Partial<ChannelConfig>,
): boolean => {
    if (routeId === "audio-speech") {
        return isAudioChannelType(config.type)
    }

    return resolveChannelProtocols(config).length > 0
}
