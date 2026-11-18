import { Context } from "hono"
import {
    getApiKeyForRoute,
    fetchTokenData,
    fetchChannelCatalog,
    filterChannelsForToken,
} from "./auth"
import { RouteId, isChannelAllowedForRoute } from "./route-policy"
import { findModelMapping, getJsonSetting } from "../../utils"
import { CONSTANTS } from "../../constants"
import { TokenUtils } from "../../admin/token_utils"
import type { NormalizedChannelConfig } from "../../channel-config"
import { getSystemConfig } from "../../system-config"
import { selectChannel } from "./channel-selection"
import {
    buildUsageRequestMetadata,
    hashTokenKey,
    writeUsageFailureEvent,
    writeUsageSuccessEvent,
} from "../../analytics/usage-logger"

export type ResolvedChannelCandidate = {
    key: string
    config: NormalizedChannelConfig
    mapping: ChannelModelMapping
}

export type ChannelResolution = {
    channels: ResolvedChannelCandidate[]
    initialChannel: ResolvedChannelCandidate
    requestBody: any
    saveUsage: (usage: Usage) => Promise<void>
    logFailure: (errorCode: string, errorSummary?: string) => void
    trackingState: RequestTrackingState
    setActiveChannel: (channel: ResolvedChannelCandidate) => void
    routing: ChannelRoutingConfig
}

/**
 * Gemini native routes carry the model in the URL, so the caller passes it as a hint
 * instead of injecting a synthetic body field.
 */
export type ChannelResolutionHint = {
    model: string
    stream: boolean
}

export const resolveChannel = async (
    c: Context<HonoCustomType>,
    routeId: RouteId,
    hint?: ChannelResolutionHint
): Promise<ChannelResolution | Response> => {
    const apiKey = getApiKeyForRoute(c, routeId);
    if (!apiKey) {
        return c.text("Authorization header or x-api-key not found", 401);
    }

    const [tokenResult, catalogResult, systemConfigResult] = await Promise.allSettled([
        fetchTokenData(c, apiKey),
        fetchChannelCatalog(c),
        getSystemConfig(c),
    ]);

    if (tokenResult.status === "rejected") throw tokenResult.reason;
    if (!tokenResult.value) {
        return c.text("Invalid API key", 401);
    }
    if (catalogResult.status === "rejected") throw catalogResult.reason;
    if (systemConfigResult.status === "rejected") throw systemConfigResult.reason;

    const { tokenData, usage } = tokenResult.value;
    const channelsResult = filterChannelsForToken(catalogResult.value, tokenData);

    if (!channelsResult.results || channelsResult.results.length === 0) {
        return c.text("No available channels for this token", 401);
    }

    let requestBody: any;
    try {
        requestBody = await c.req.json();
    } catch (error) {
        return c.text("Invalid JSON body", 400);
    }
    const requestedModel = hint?.model ?? requestBody.model;
    if (!requestedModel) {
        return c.text("Model is required", 400);
    }

    let availableChannels: ResolvedChannelCandidate[] = [];
    let hasDisabledMatchingChannel = false;

    for (const row of channelsResult.results) {
        const config = row.config;

        if (!isChannelAllowedForRoute(routeId, config)) {
            continue;
        }

        const mapping = findModelMapping(config.models, requestedModel);
        if (!mapping) {
            continue;
        }

        if (!config.enabled) {
            hasDisabledMatchingChannel = true;
            continue;
        }

        availableChannels.push({
            key: row.key,
            config: config,
            mapping,
        });
    }

    if (availableChannels.length === 0) {
        if (hasDisabledMatchingChannel) {
            return c.text(`No enabled channels available for model: ${requestedModel}. Please enable a channel first.`, 503);
        }
        return c.text(`Model not supported: ${requestedModel}. Please configure models.`, 400);
    }

    const requestedChannelKey = c.req.raw.headers.get('x-channel-key')?.trim();
    if (requestedChannelKey) {
        const hasTokenAccessToChannel = channelsResult.results.some((row) => row.key === requestedChannelKey);
        if (!hasTokenAccessToChannel) {
            return c.text(`Token is not allowed to use channel: ${requestedChannelKey}`, 403);
        }

        const selectedChannel = availableChannels.find((channel) => channel.key === requestedChannelKey);
        if (!selectedChannel) {
            return c.text(`Channel does not support this route or model: ${requestedChannelKey}`, 400);
        }

        availableChannels = [selectedChannel];
    }

    if (!TokenUtils.hasRemainingQuota(tokenData.total_quota, usage)) {
        // 一次性读取全局定价，避免对每个渠道重复查询
        const globalPricing = await getJsonSetting<Record<string, ModelPricing>>(c, CONSTANTS.MODEL_PRICING_KEY);
        const freeChannels = await Promise.all(
            availableChannels.map(async (channel) => ({
                channel,
                requiresPaidQuota: await TokenUtils.modelRequiresPaidQuota(c, requestedModel, channel.config, globalPricing),
            }))
        );

        availableChannels = freeChannels
            .filter((item) => !item.requiresPaidQuota)
            .map((item) => item.channel);

        if (availableChannels.length === 0) {
            return c.text("Quota exceeded for paid models", 402);
        }
    }

    const routing = systemConfigResult.value.routing;
    const selectedChannel = selectChannel(availableChannels, routing.strategy);
    const trackingState: RequestTrackingState = {
        retryCount: 0,
    };
    const requestStartedAt = Date.now();
    const tokenHash = await hashTokenKey(apiKey);
    const tokenName = tokenData.name?.trim() || "未命名令牌";
    const requestMetadata = buildUsageRequestMetadata(c);
    const usageContext = {
        routeId,
        tokenHash,
        tokenName,
        channelKey: selectedChannel.key,
        providerType: selectedChannel.config.type || "unknown",
        requestedModel,
        upstreamModel: selectedChannel.mapping.id,
        streamMode: (hint?.stream ?? requestBody.stream) ? "stream" as const : "sync" as const,
        requestId: requestMetadata.requestId,
        traceId: requestMetadata.traceId,
        clientIp: requestMetadata.clientIp,
        userAgent: requestMetadata.userAgent,
        country: requestMetadata.country,
        region: requestMetadata.region,
        city: requestMetadata.city,
        colo: requestMetadata.colo,
        timezone: requestMetadata.timezone,
        startedAt: requestStartedAt,
        trackingState,
    };
    let usageLogState: "idle" | "processing" | "done" = "idle";
    let activeChannel = selectedChannel;

    const setActiveChannel = (channel: ResolvedChannelCandidate) => {
        activeChannel = channel;
        usageContext.channelKey = channel.key;
        usageContext.providerType = channel.config.type || "unknown";
        usageContext.upstreamModel = channel.mapping.id;
    };

    const saveUsage = async (usage: Usage) => {
        if (usageLogState !== "idle") {
            return;
        }

        usageLogState = "processing";
        try {
            const costResult = await TokenUtils.processUsage(
                c,
                apiKey,
                requestedModel,
                activeChannel.key,
                activeChannel.config,
                usage
            );

            if (costResult.quotaExceeded) {
                writeUsageFailureEvent(c, usageContext, {
                    errorCode: "quota_exceeded",
                    errorSummary: `Usage charge rejected: token quota exceeded (cost: ${costResult.totalCost})`,
                });
            } else {
                writeUsageSuccessEvent(c, usageContext, usage, costResult);
            }
            usageLogState = "done";
        } catch (error) {
            usageLogState = "idle";
            console.error('Error processing usage:', error);
        }
    };

    const logFailure = (errorCode: string, errorSummary?: string) => {
        if (usageLogState === "done") {
            return;
        }

        writeUsageFailureEvent(c, usageContext, { errorCode, errorSummary });
    };

    return {
        channels: availableChannels,
        initialChannel: selectedChannel,
        requestBody,
        saveUsage,
        logFailure,
        trackingState,
        setActiveChannel,
        routing,
    };
}
