import {
    getChannelProtocolDescriptor,
    getRouteProtocol,
    hasDirectProvider,
    isAudioChannelType,
} from "./protocol-registry"

export type RouteId = "chat-completions" | "messages" | "responses" | "audio-speech"

export const resolveRouteId = (pathname: string): RouteId | null => {
    if (pathname.endsWith("/chat/completions")) return "chat-completions"
    if (pathname.endsWith("/messages")) return "messages"
    if (pathname.endsWith("/responses")) return "responses"
    if (pathname.endsWith("/audio/speech")) return "audio-speech"
    return null
}

/**
 * A channel is usable for a route when its upstream protocol can serve the route,
 * either directly or through protocol conversion.
 * Endpoints ending in "#" bypass path construction, so they require a direct proxy.
 */
export const isChannelAllowedForRoute = (
    routeId: RouteId,
    config: Pick<ChannelConfig, "type" | "endpoint">,
): boolean => {
    if (routeId === "audio-speech") {
        return isAudioChannelType(config.type)
    }

    const descriptor = getChannelProtocolDescriptor(config.type)
    if (!descriptor) {
        return false
    }

    if (config.endpoint?.endsWith("#")) {
        return descriptor.protocol === getRouteProtocol(routeId) && hasDirectProvider(config.type)
    }

    return true
}
