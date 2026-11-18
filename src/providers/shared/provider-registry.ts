import { Context } from "hono"

import passthroughProxy from "../passthrough-proxy"
import protocolConversion from "../protocol-conversion"
import { getChannelProtocolDescriptor, getRouteProtocol } from "./protocol-registry"
import type { RouteId } from "./route-policy"

export type ProviderFetch = (
    c: Context<HonoCustomType>,
    config: ChannelConfig,
    requestBody: any,
    saveUsage: (usage: Usage) => Promise<void>,
    trackingState: RequestTrackingState,
    routeId: RouteId,
) => Promise<Response>

/**
 * Audio routes and same-protocol text channels forward the request verbatim;
 * only a protocol mismatch goes through conversion.
 */
export const getProvider = (routeId: RouteId, type: string): ProviderFetch | undefined => {
    if (routeId === "audio-speech") {
        return passthroughProxy.fetch
    }

    const descriptor = getChannelProtocolDescriptor(type)
    if (!descriptor) {
        return undefined
    }

    if (descriptor.protocol === getRouteProtocol(routeId)) {
        return passthroughProxy.fetch
    }

    return protocolConversion.fetch
}
