import { Context } from "hono"

import passthroughProxy from "../passthrough-proxy"
import protocolConversion from "../protocol-conversion"
import {
    channelSupportsProtocol,
    getRouteProtocol,
    resolveChannelProtocols,
} from "./protocol-registry"
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
 * Audio routes and text protocols the channel serves natively forward verbatim;
 * only a protocol mismatch goes through conversion.
 */
export const getProvider = (
    routeId: RouteId,
    config: Partial<ChannelConfig>,
): ProviderFetch | undefined => {
    if (routeId === "audio-speech") {
        return passthroughProxy.fetch
    }

    const routeProtocol = getRouteProtocol(routeId)
    if (!routeProtocol || resolveChannelProtocols(config).length === 0) {
        return undefined
    }

    return channelSupportsProtocol(config, routeProtocol)
        ? passthroughProxy.fetch
        : protocolConversion.fetch
}
