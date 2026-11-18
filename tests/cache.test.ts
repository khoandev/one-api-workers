import { expect, test } from "bun:test";
import { cachedValue, invalidateCached } from "../src/cache";

test("concurrent callers share one loader invocation", async () => {
    const scope = {};
    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    const results = await Promise.all([
        cachedValue(scope, "k", 30_000, loader),
        cachedValue(scope, "k", 30_000, loader),
        cachedValue(scope, "k", 30_000, loader),
    ]);

    expect(results).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
});

test("invalidateCached forces a reload", async () => {
    const scope = {};
    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    expect(await cachedValue(scope, "k", 30_000, loader)).toBe(1);
    invalidateCached(scope, "k");
    expect(await cachedValue(scope, "k", 30_000, loader)).toBe(2);
});

test("different scopes do not share entries", async () => {
    const scopeA = {};
    const scopeB = {};
    const loaderA = async () => "a";
    const loaderB = async () => "b";

    expect(await cachedValue(scopeA, "k", 30_000, loaderA)).toBe("a");
    expect(await cachedValue(scopeB, "k", 30_000, loaderB)).toBe("b");
});

test("a rejected loader is not cached", async () => {
    const scope = {};
    let attempts = 0;
    const loader = async () => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("boom");
        }
        return "recovered";
    };

    await expect(cachedValue(scope, "k", 30_000, loader)).rejects.toThrow("boom");
    expect(await cachedValue(scope, "k", 30_000, loader)).toBe("recovered");
    expect(attempts).toBe(2);
});

test("ttlMs 0 reloads on the next call", async () => {
    const scope = {};
    let loads = 0;
    const loader = async () => {
        loads += 1;
        return loads;
    };

    expect(await cachedValue(scope, "k", 0, loader)).toBe(1);
    expect(await cachedValue(scope, "k", 0, loader)).toBe(2);
});
