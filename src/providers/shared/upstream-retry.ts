import { Context } from "hono";

import type { NormalizedChannelConfig } from "../../channel-config";
import {
    summarizeErrorFromResponse,
    summarizeErrorFromUnknown,
} from "../../analytics/usage-logger";
import {
    markChannelFailure,
    markChannelSuccess,
    selectChannel,
} from "./channel-selection";
import {
    ResolvedChannelCandidate,
} from "./channel-resolver";
import {
    getProvider,
    ProviderFetch,
} from "./provider-registry";
import type { RouteId } from "./route-policy";

const MAX_BACKOFF_MS = 10_000;
const BACKOFF_JITTER_MS = 50;

type ChannelExecutionResult = {
    response: Response
    shouldFallback: boolean
    errorCode: string
    errorSummary?: string
}

const pickRandomItem = <T>(items: T[]): T => {
    return items[Math.floor(Math.random() * items.length)];
};

const cloneRequestBody = <T>(requestBody: T): T => {
    if (requestBody == null) {
        return requestBody;
    }

    return JSON.parse(JSON.stringify(requestBody)) as T;
};

const getModelDefaultParams = (
    mapping: ChannelModelMapping
): Record<string, unknown> | null => {
    const defaultParams = mapping.default_params;
    if (!defaultParams || typeof defaultParams !== "object" || Array.isArray(defaultParams)) {
        return null;
    }

    return defaultParams;
};

const buildChannelRequestBody = (
    requestBody: any,
    channel: ResolvedChannelCandidate
) => {
    const runtimeRequestBody = cloneRequestBody(requestBody);
    if (runtimeRequestBody && typeof runtimeRequestBody === "object") {
        const defaultParams = getModelDefaultParams(channel.mapping);
        const mergedRequestBody = defaultParams
            ? {
                ...cloneRequestBody(defaultParams),
                ...runtimeRequestBody,
            }
            : runtimeRequestBody;

        mergedRequestBody.model = channel.mapping.id;
        return mergedRequestBody;
    }
    return runtimeRequestBody;
};

const discardResponse = async (response: Response): Promise<void> => {
    try {
        await response.body?.cancel();
    } catch (error) {
        console.warn("Failed to cancel upstream response body:", error);
    }
};

/**
 * Exponential backoff with a little jitter so parallel requests do not retry in
 * lockstep. A zero base delay disables waiting entirely.
 */
const waitForRetry = async (backoffMs: number, attemptIndex: number): Promise<void> => {
    const delay = Math.min(backoffMs * 2 ** attemptIndex, MAX_BACKOFF_MS);
    if (delay <= 0) {
        return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delay + Math.floor(Math.random() * BACKOFF_JITTER_MS));
    await promise;
};

const pickInitialKey = (config: NormalizedChannelConfig): string | null => {
    return pickRandomItem(config.api_keys) || null;
};

const pickRetryKey = (
    config: NormalizedChannelConfig,
    currentKey: string,
    usedKeys: Set<string>
): string => {
    if (!config.auto_rotate) {
        return currentKey;
    }

    const unusedOtherKeys = config.api_keys.filter((key) => {
        return key !== currentKey && !usedKeys.has(key);
    });
    const otherKeys = config.api_keys.filter((key) => key !== currentKey);
    const nextPool = unusedOtherKeys.length > 0
        ? unusedOtherKeys
        : (otherKeys.length > 0 ? otherKeys : [currentKey]);
    const nextKey = pickRandomItem(nextPool);
    usedKeys.add(nextKey);
    return nextKey;
};

const pickNextFallbackChannel = (
    channels: ResolvedChannelCandidate[],
    attemptedChannelKeys: Set<string>,
    routing: ChannelRoutingConfig
): ResolvedChannelCandidate | null => {
    const remainingChannels = channels.filter((channel) => {
        return !attemptedChannelKeys.has(channel.key);
    });

    if (remainingChannels.length === 0) {
        return null;
    }

    return selectChannel(remainingChannels, routing.strategy);
};

export const executeChannelWithRetries = async (
    c: Context<HonoCustomType>,
    channel: ResolvedChannelCandidate,
    requestBody: any,
    saveUsage: (usage: Usage) => Promise<void>,
    trackingState: RequestTrackingState,
    provider: ProviderFetch,
    routeId: RouteId,
    routing: ChannelRoutingConfig,
): Promise<ChannelExecutionResult> => {
    const config = channel.config;
    const initialKey = pickInitialKey(config);

    if (!initialKey) {
        const errorSummary = "Channel API keys not configured";
        trackingState.upstreamStatus = 0;
        trackingState.errorSummary = errorSummary;

        return {
            response: c.text(errorSummary, 500),
            shouldFallback: true,
            errorCode: "channel_keys_missing",
            errorSummary,
        };
    }

    const channelRequestBody = buildChannelRequestBody(requestBody, channel);
    const retryStatusCodes = new Set(routing.retryStatusCodes);
    const maxAttempts = 1 + (config.auto_retry ? routing.maxRetries : 0);
    const usedKeys = new Set<string>([initialKey]);
    let currentKey = initialKey;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const hasNextAttempt = attemptIndex < maxAttempts - 1;

        try {
            const runtimeConfig: ChannelConfig = {
                ...config,
                api_key: currentKey,
                api_keys: [currentKey],
            };

            const response = await provider(
                c,
                runtimeConfig,
                channelRequestBody,
                saveUsage,
                trackingState,
                routeId,
            );

            if (response.ok) {
                markChannelSuccess(channel.key);
                return {
                    response,
                    shouldFallback: false,
                    errorCode: "",
                };
            }

            if (!retryStatusCodes.has(response.status)) {
                const errorSummary = await summarizeErrorFromResponse(response);
                trackingState.errorSummary = errorSummary;

                return {
                    response,
                    shouldFallback: false,
                    errorCode: `http_${response.status}`,
                    errorSummary,
                };
            }

            console.warn(
                `Retryable upstream failure for channel "${config.name || channel.key}", `
                + `attempt ${attemptIndex + 1}/${maxAttempts}, `
                + `status ${response.status}`
            );

            if (!hasNextAttempt) {
                markChannelFailure(channel.key, routing.cooldownMs);
                const errorSummary = await summarizeErrorFromResponse(response);
                trackingState.errorSummary = errorSummary;

                return {
                    response,
                    shouldFallback: true,
                    errorCode: `http_${response.status}`,
                    errorSummary,
                };
            }

            await discardResponse(response);
            await waitForRetry(routing.retryBackoffMs, attemptIndex);
            currentKey = pickRetryKey(config, currentKey, usedKeys);
            trackingState.retryCount += 1;
        } catch (error) {
            console.error(
                `Upstream request error for channel "${config.name || channel.key}", `
                + `attempt ${attemptIndex + 1}/${maxAttempts}`,
                error
            );

            trackingState.upstreamStatus = 0;

            if (!hasNextAttempt) {
                markChannelFailure(channel.key, routing.cooldownMs);
                trackingState.errorSummary = summarizeErrorFromUnknown(error);
                const message = error instanceof Error ? error.message : "Unknown upstream error";

                return {
                    response: c.text(`Upstream request failed: ${message}`, 502),
                    shouldFallback: true,
                    errorCode: "upstream_exception",
                    errorSummary: trackingState.errorSummary,
                };
            }

            await waitForRetry(routing.retryBackoffMs, attemptIndex);
            currentKey = pickRetryKey(config, currentKey, usedKeys);
            trackingState.retryCount += 1;
        }
    }

    const errorSummary = trackingState.errorSummary || "Upstream request failed after retries";
    return {
        response: c.text("Upstream request failed after retries", 502),
        shouldFallback: true,
        errorCode: "upstream_retries_exhausted",
        errorSummary,
    };
};

export const executeWithFallbackChannels = async (
    c: Context<HonoCustomType>,
    channels: ResolvedChannelCandidate[],
    initialChannel: ResolvedChannelCandidate,
    requestBody: any,
    saveUsage: (usage: Usage) => Promise<void>,
    logFailure: (errorCode: string, errorSummary?: string) => void,
    trackingState: RequestTrackingState,
    setActiveChannel: (channel: ResolvedChannelCandidate) => void,
    routeId: RouteId,
    routing: ChannelRoutingConfig,
): Promise<Response> => {
    const attemptedChannelKeys = new Set<string>();
    let currentChannel = initialChannel;
    let fallbackCount = 0;

    while (true) {
        attemptedChannelKeys.add(currentChannel.key);
        setActiveChannel(currentChannel);
        trackingState.errorSummary = undefined;

        const provider = getProvider(routeId, currentChannel.config.type || "");
        if (!provider) {
            const errorSummary = "Channel type not supported";
            const response = c.text(errorSummary, 400);
            const nextChannel = fallbackCount < routing.maxFallbacks
                ? pickNextFallbackChannel(channels, attemptedChannelKeys, routing)
                : null;

            trackingState.upstreamStatus = 0;
            trackingState.errorSummary = errorSummary;

            if (!nextChannel) {
                logFailure("channel_type_invalid", errorSummary);
                return response;
            }

            console.warn(
                `Fallback to channel "${nextChannel.key}" after unsupported provider `
                + `on channel "${currentChannel.key}"`
            );

            // A misconfigured channel type is not an upstream failure: no cooldown.
            await waitForRetry(routing.retryBackoffMs, fallbackCount);
            fallbackCount += 1;
            trackingState.retryCount += 1;
            currentChannel = nextChannel;
            continue;
        }

        const execution = await executeChannelWithRetries(
            c,
            currentChannel,
            requestBody,
            saveUsage,
            trackingState,
            provider,
            routeId,
            routing,
        );

        if (execution.response.ok) {
            return execution.response;
        }

        const nextChannel = execution.shouldFallback && fallbackCount < routing.maxFallbacks
            ? pickNextFallbackChannel(channels, attemptedChannelKeys, routing)
            : null;

        if (!nextChannel) {
            logFailure(execution.errorCode, execution.errorSummary);
            return execution.response;
        }

        await discardResponse(execution.response);

        console.warn(
            `Fallback to channel "${nextChannel.key}" after channel "${currentChannel.key}" `
            + `failed for model "${currentChannel.mapping.name}"`
        );

        await waitForRetry(routing.retryBackoffMs, fallbackCount);
        fallbackCount += 1;
        trackingState.retryCount += 1;
        currentChannel = nextChannel;
    }
};
