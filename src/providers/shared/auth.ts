import { Context } from "hono"

import type { RouteId } from "./route-policy"

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

export const fetchChannelsForToken = async (
    c: Context<HonoCustomType>,
    tokenData: ApiTokenData
) => {
    const channelKeys = tokenData.channel_keys;

    if (!channelKeys || channelKeys.length === 0) {
        return await c.env.DB.prepare(
            `SELECT key, value FROM channel_config`
        ).all<ChannelConfigRow>();
    }

    const channelQuery = channelKeys.map(() => '?').join(',');
    return await c.env.DB.prepare(
        `SELECT key, value FROM channel_config WHERE key IN (${channelQuery})`
    ).bind(...channelKeys).all<ChannelConfigRow>();
}

export const fetchAllChannels = async (c: Context<HonoCustomType>) => {
    return await c.env.DB.prepare(
        `SELECT key, value FROM channel_config`
    ).all<ChannelConfigRow>();
}
