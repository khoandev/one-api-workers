import { expect, test } from "bun:test";
import { cachedKvValue, getKvCacheKey, invalidateCachedKvValue } from "../src/kv-cache";
import { attachKv, createFakeKv } from "./helpers/fake-kv";
import { createTestDatabase } from "./helpers/sqlite-d1";

const KEY = "probe";
const KV_KEY = getKvCacheKey(KEY);

test("a second isolate serves the value from KV", async () => {
    const kv = createFakeKv();
    const first = createTestDatabase();
    const second = createTestDatabase();
    attachKv(first, kv);
    attachKv(second, kv);

    let loads = 0;
    const loader = async () => {
        loads += 1;
        return { loads };
    };

    try {
        expect(await cachedKvValue(first.context, KEY, 60_000, loader)).toEqual({ loads: 1 });
        expect(await cachedKvValue(second.context, KEY, 60_000, loader)).toEqual({ loads: 1 });
        expect(loads).toBe(1);
        expect(kv.putCalls.map((call) => call.key)).toEqual([KV_KEY]);
    } finally {
        first.close();
        second.close();
    }
});

test("a KV envelope older than maxAgeMs reloads and is rewritten", async () => {
    const kv = createFakeKv();
    const fixture = createTestDatabase();
    attachKv(fixture, kv);
    kv.store.set(KV_KEY, JSON.stringify({ cachedAt: Date.now() - 11_000, value: "stale" }));

    let loads = 0;
    const loader = async () => {
        loads += 1;
        return "fresh";
    };

    try {
        expect(await cachedKvValue(fixture.context, KEY, 10_000, loader)).toBe("fresh");
        expect(loads).toBe(1);
        expect(kv.putCalls).toHaveLength(1);
        expect(kv.putCalls[0].options?.expirationTtl).toBe(60);
        expect(JSON.parse(kv.store.get(KV_KEY) as string)).toMatchObject({ value: "fresh" });
    } finally {
        fixture.close();
    }
});

test("invalidateCachedKvValue deletes the KV entry and forces a reload", async () => {
    const kv = createFakeKv();
    const fixture = createTestDatabase();
    attachKv(fixture, kv);

    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    try {
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(1);
        await invalidateCachedKvValue(fixture.context, KEY);

        expect(kv.deleteCalls).toEqual([KV_KEY]);
        expect(kv.store.has(KV_KEY)).toBe(false);
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(2);
    } finally {
        fixture.close();
    }
});

test("KV read failures, corrupt payloads, and write failures all fall back to the loader", async () => {
    const fixture = createTestDatabase();
    const kv = createFakeKv();
    attachKv(fixture, kv);

    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    try {
        kv.state.failGet = true;
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(1);
        expect(loads).toBe(1);
        kv.state.failGet = false;

        kv.store.set(KV_KEY, "{not json");
        expect(await cachedKvValue(fixture.context, "corrupt", 60_000, loader)).toBe(2);

        kv.state.failPut = true;
        expect(await cachedKvValue(fixture.context, "write-fails", 60_000, loader)).toBe(3);
        expect(await cachedKvValue(fixture.context, "write-fails-2", 60_000, loader)).toBe(4);
    } finally {
        fixture.close();
    }
});

test("a null loader value is cached instead of being mistaken for a miss", async () => {
    const kv = createFakeKv();
    const first = createTestDatabase();
    const second = createTestDatabase();
    attachKv(first, kv);
    attachKv(second, kv);

    let loads = 0;
    const loader = async () => {
        loads += 1;
        return null;
    };

    try {
        expect(await cachedKvValue(first.context, KEY, 60_000, loader)).toBeNull();
        expect(loads).toBe(1);
        expect(JSON.parse(kv.store.get(KV_KEY) as string)).toMatchObject({
            value: null,
        });

        expect(await cachedKvValue(second.context, KEY, 60_000, loader)).toBeNull();
        expect(loads).toBe(1);
    } finally {
        first.close();
        second.close();
    }
});

test("without a KV binding the isolate cache is the only layer", async () => {
    const fixture = createTestDatabase();
    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    try {
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(1);
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(1);
        expect(loads).toBe(1);

        await invalidateCachedKvValue(fixture.context, KEY);
        expect(await cachedKvValue(fixture.context, KEY, 60_000, loader)).toBe(2);
    } finally {
        fixture.close();
    }
});
