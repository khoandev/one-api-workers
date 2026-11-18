import { Context } from "hono";

import { cachedValue, invalidateCached } from "./cache";

/** Isolate memory is always the shortest hop, so L1 never outlives this. */
const L1_MAX_TTL_MS = 30_000;

/** Bump whenever a cached payload shape changes; old entries are ignored. */
const KV_CACHE_VERSION = "v1";

const KV_MIN_TTL_SECONDS = 60;

type KvCacheEnvelope<T> = {
    cachedAt: number;
    value: T;
};

type KvLookup<T> = { hit: true; value: T } | { hit: false };

export const getKvCacheKey = (key: string): string =>
    `oaw:cache:${KV_CACHE_VERSION}:${key}`;

// `null` is a cacheable loader result (absent settings), so a miss needs its own marker.
const readEnvelope = async <T>(
    kv: KVNamespace,
    kvKey: string,
    maxAgeMs: number,
): Promise<KvLookup<T>> => {
    const raw = await kv.get(kvKey);
    if (!raw) {
        return { hit: false };
    }

    const envelope = JSON.parse(raw) as KvCacheEnvelope<T>;
    if (typeof envelope?.cachedAt !== "number") {
        return { hit: false };
    }
    if (Date.now() - envelope.cachedAt >= maxAgeMs) {
        return { hit: false };
    }

    return { hit: true, value: envelope.value };
};

const scheduleWrite = async (
    c: Context<HonoCustomType>,
    kv: KVNamespace,
    kvKey: string,
    value: unknown,
    maxAgeMs: number,
): Promise<void> => {
    const write = kv.put(
        kvKey,
        JSON.stringify({ cachedAt: Date.now(), value }),
        { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(maxAgeMs / 1000)) },
    ).catch((error) => {
        console.warn(`KvCache: Failed to write ${kvKey}`, error);
    });

    try {
        c.executionCtx.waitUntil(write);
    } catch {
        // Test contexts have no ExecutionContext; awaiting keeps them deterministic.
        await write;
    }
};

/**
 * Isolate cache in front of a Cloudflare KV entry. A missing binding, a KV read
 * error, or a corrupt payload all degrade to the loader, so caching never fails
 * a request.
 */
export const cachedKvValue = <T>(
    c: Context<HonoCustomType>,
    key: string,
    maxAgeMs: number,
    loader: () => Promise<T>,
): Promise<T> => {
    return cachedValue(
        c.env.DB,
        key,
        Math.min(L1_MAX_TTL_MS, maxAgeMs),
        async () => {
            const kv = c.env.KV;
            if (!kv) {
                return loader();
            }

            const kvKey = getKvCacheKey(key);
            try {
                const lookup = await readEnvelope<T>(kv, kvKey, maxAgeMs);
                if (lookup.hit) {
                    return lookup.value;
                }
            } catch (error) {
                console.warn(`KvCache: Failed to read ${kvKey}`, error);
            }

            const value = await loader();
            await scheduleWrite(c, kv, kvKey, value, maxAgeMs);
            return value;
        },
    );
};

export const invalidateCachedKvValue = async (
    c: Context<HonoCustomType>,
    key: string,
): Promise<void> => {
    invalidateCached(c.env.DB, key);

    const kv = c.env.KV;
    if (!kv) {
        return;
    }

    const kvKey = getKvCacheKey(key);
    try {
        await kv.delete(kvKey);
    } catch (error) {
        console.warn(`KvCache: Failed to delete ${kvKey}`, error);
    }
};
