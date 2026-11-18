export type FakeKvPut = {
    key: string;
    value: string;
    options?: { expirationTtl?: number };
};

export type FakeKv = {
    store: Map<string, string>;
    state: { failGet: boolean; failPut: boolean; failDelete: boolean };
    getCalls: string[];
    putCalls: FakeKvPut[];
    deleteCalls: string[];
    namespace: KVNamespace;
};

/**
 * Minimal in-memory KVNamespace double: no TTL expiry simulation, but every
 * call is recorded so tests can assert read/write/delete traffic and failure
 * fallbacks.
 */
export const createFakeKv = (): FakeKv => {
    const store = new Map<string, string>();
    const getCalls: string[] = [];
    const putCalls: FakeKvPut[] = [];
    const deleteCalls: string[] = [];
    const state = { failGet: false, failPut: false, failDelete: false };

    const namespace = {
        async get(key: string) {
            getCalls.push(key);
            if (state.failGet) {
                throw new Error("fake KV get failed");
            }
            return store.get(key) ?? null;
        },
        async put(key: string, value: string, options?: { expirationTtl?: number }) {
            putCalls.push({ key, value, options });
            if (state.failPut) {
                throw new Error("fake KV put failed");
            }
            store.set(key, value);
        },
        async delete(key: string) {
            deleteCalls.push(key);
            if (state.failDelete) {
                throw new Error("fake KV delete failed");
            }
            store.delete(key);
        },
    } as unknown as KVNamespace;

    return { store, state, getCalls, putCalls, deleteCalls, namespace };
};

export const attachKv = (
    fixture: { context: { env: unknown } },
    kv: FakeKv,
): void => {
    (fixture.context.env as Record<string, unknown>).KV = kv.namespace;
};
