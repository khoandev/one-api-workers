type CacheEntry = {
    expiresAt: number;
    promise: Promise<unknown>;
};

const stores = new WeakMap<object, Map<string, CacheEntry>>();

const getStore = (scope: object): Map<string, CacheEntry> => {
    const existing = stores.get(scope);
    if (existing) {
        return existing;
    }

    const store = new Map<string, CacheEntry>();
    stores.set(scope, store);
    return store;
};

/**
 * Isolate-scoped single-flight cache. Concurrent callers share one loader
 * invocation; a rejected loader is never cached.
 */
export const cachedValue = <T>(
    scope: object,
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
): Promise<T> => {
    const store = getStore(scope);
    const cached = store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.promise as Promise<T>;
    }

    const entry: CacheEntry = {
        expiresAt: Date.now() + ttlMs,
        promise: loader(),
    };
    // Register before awaiting so concurrent callers share one loader call.
    store.set(key, entry);

    entry.promise = entry.promise.catch((error) => {
        if (store.get(key) === entry) {
            store.delete(key);
        }
        throw error;
    });

    return entry.promise as Promise<T>;
};

export const invalidateCached = (scope: object, key: string): void => {
    stores.get(scope)?.delete(key);
};
