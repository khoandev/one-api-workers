import { Context } from "hono"

import azureOpenaiProxy from "../azure-openai-proxy"
import openaiProxy from "../openai-proxy"
import claudeProxy from "../claude-proxy"
import openaiResponsesProxy from "../openai-responses-proxy"
import azureOpenaiResponsesProxy from "../azure-openai-responses-proxy"
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

const providerMap: Record<string, ProviderFetch> = {
    "azure-openai": azureOpenaiProxy.fetch,
    "openai": openaiProxy.fetch,
    "gemini": openaiProxy.fetch,
    "azure-openai-audio": azureOpenaiProxy.fetch,
    "openai-audio": openaiProxy.fetch,
    "claude": claudeProxy.fetch,
    "claude-to-openai": openaiProxy.fetch,
    "openai-responses": openaiResponsesProxy.fetch,
    "azure-openai-responses": azureOpenaiResponsesProxy.fetch,
}

export const getProvider = (routeId: RouteId, type: string): ProviderFetch | undefined => {
    if (routeId === "audio-speech") {
        return providerMap[type]
    }

    const descriptor = getChannelProtocolDescriptor(type)
    if (descriptor && descriptor.protocol !== getRouteProtocol(routeId)) {
        return protocolConversion.fetch
    }

    return providerMap[type]
}
