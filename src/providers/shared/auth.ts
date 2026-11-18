import { Context } from "hono"

import { cachedValue, invalidateCached } from "../../cache"
import { normalizeChannelConfig } from "../../channel-config"
import type { NormalizedChannelConfig } from "../../channel-config"
import type { RouteId } from "./route-policy"

const CHANNEL_CACHE_KEY = "channel_config:all";
const CHANNEL_CACHE_TTL_MS = 30_000;

export const getApiKeyFromHeaders = (c: Context<HonoCustomType>): string | null => {
    const authHeader = c.req.raw.headers.get('Authorization');
    const xApiKey = c.req.raw.headers.get('x-api-key');
    const xGoogApiKey = c.req.raw.headers.get('x-goog-api-key');

    if (authHeader) {
        return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
    }
    if (xApiKey) {
        return xApiKey.trim();
    }
    if (xGoogApiKey) {
        return xGoogApiKey.trim();
    }
    return null;
}

/**
 * Gemini clients may authenticate with `?key=`. Only the Gemini native routes accept it,
 * so the query parameter never becomes a fallback credential for other routes.
 */
export const getApiKeyFromQuery = (c: Context<HonoCustomType>): string | null => {
    const key = new URL(c.req.url).searchParams.get('key')?.trim();
    return key ? key : null;
}

/**
 * `?key=` is a credential only for the Gemini native routes. Every other route keeps
 * header-only authentication.
 */
export const getApiKeyForRoute = (c: Context<HonoCustomType>, routeId: RouteId): string | null => {
    const headerKey = getApiKeyFromHeaders(c);
    if (headerKey) {
        return headerKey;
    }

    return routeId === 'gemini-generate-content' ? getApiKeyFromQuery(c) : null;
}

export const fetchTokenData = async (c: Context<HonoCustomType>, apiKey: string) => {
    const tokenResult = await c.env.DB.prepare(
        `SELECT * FROM api_token WHERE key = ?`
    ).bind(apiKey).first();

    if (!tokenResult || !tokenResult.value) {
        return null;
    }

    let tokenData: ApiTokenData;
    try {
        tokenData = JSON.parse(tokenResult.value as string) as ApiTokenData;
    } catch (error) {
        console.error('Invalid token config, treating as invalid:', error);
        return null;
    }

    return {
        tokenData,
        usage: tokenResult.usage as number || 0,
    };
}

export const invalidateChannelCache = (c: Context<HonoCustomType>): void => {
    invalidateCached(c.env.DB, CHANNEL_CACHE_KEY);
}

export type ChannelCatalogEntry = {
    key: string;
    config: NormalizedChannelConfig;
}

export type ChannelCatalog = {
    results: ChannelCatalogEntry[];
}

/**
 * Channel configs are parsed and normalized once per cache window instead of
 * once per request per channel. Invalid rows are dropped here, so consumers
 * only ever see compiled configs.
 */
const loadAllChannels = async (
    c: Context<HonoCustomType>
): Promise<ChannelCatalog> => {
    const rows = await c.env.DB.prepare(
        `SELECT key, value FROM channel_config`
    ).all<ChannelConfigRow>();

    const results: ChannelCatalogEntry[] = [];
    for (const row of rows.results ?? []) {
        try {
            results.push({
                key: row.key,
                config: normalizeChannelConfig(JSON.parse(row.value) as ChannelConfig),
            });
        } catch (error) {
            console.error(`Invalid channel config for key: ${row.key}`, error);
        }
    }

    return { results };
}

export const fetchChannelsForToken = async (
    c: Context<HonoCustomType>,
    tokenData: ApiTokenData
): Promise<ChannelCatalog> => {
    const catalog = await cachedValue(
        c.env.DB,
        CHANNEL_CACHE_KEY,
        CHANNEL_CACHE_TTL_MS,
        () => loadAllChannels(c)
    );

    const channelKeys = tokenData.channel_keys;
    if (!channelKeys || channelKeys.length === 0) {
        return catalog;
    }

    const allowedKeys = new Set(channelKeys);
    return {
        results: catalog.results.filter((row) => allowedKeys.has(row.key)),
    };
}
