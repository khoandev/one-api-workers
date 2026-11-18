import { expect, test } from "bun:test";
import {
    fetchChannelCatalog,
    filterChannelsForToken,
    invalidateChannelCache,
} from "../src/providers/shared/auth";
import { attachKv, createFakeKv } from "./helpers/fake-kv";
import { createTestDatabase } from "./helpers/sqlite-d1";

const seedChannels = () => {
    const fixture = createTestDatabase();
    fixture.sqlite.exec(`CREATE TABLE channel_config (
        key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT
    )`);
    fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("a", '{"name":"a"}');
    fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("b", '{"name":"b"}');
    fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)")
        .run("c", '{"name":"c","weight":3,"auto_retry":false}');

    let channelSelects = 0;
    const originalPrepare = fixture.database.prepare;
    fixture.database.prepare = ((sql: string, params?: unknown[]) => {
        if (/FROM channel_config/i.test(sql)) {
            channelSelects += 1;
        }
        return originalPrepare(sql, params as never);
    }) as typeof fixture.database.prepare;

    return { fixture, channelSelects: () => channelSelects };
};

const token = (channel_keys: string[] = []) => ({
    name: "fixture",
    channel_keys,
    total_quota: -1,
}) as ApiTokenData;

const keysOf = (result: { results?: { key: string }[] }) =>
    (result.results ?? []).map((row) => row.key).sort();

test("repeated catalog reads hit channel_config once", async () => {
    const { fixture, channelSelects } = seedChannels();
    try {
        expect(keysOf(await fetchChannelCatalog(fixture.context))).toEqual(["a", "b", "c"]);
        expect(keysOf(await fetchChannelCatalog(fixture.context))).toEqual(["a", "b", "c"]);
        expect(channelSelects()).toBe(1);
    } finally {
        fixture.close();
    }
});

test("channel configs are normalized once in the cache loader", async () => {
    const { fixture } = seedChannels();
    try {
        const first = await fetchChannelCatalog(fixture.context);
        const second = await fetchChannelCatalog(fixture.context);

        expect(second).toBe(first);

        const entry = first.results.find((row) => row.key === "c");
        expect(entry?.config.weight).toBe(3);
        expect(entry?.config.auto_retry).toBe(false);
        expect(entry?.config.models).toEqual([]);
    } finally {
        fixture.close();
    }
});

test("raw channel writes stay invisible until the cache is invalidated", async () => {
    const { fixture } = seedChannels();
    try {
        await fetchChannelCatalog(fixture.context);
        fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("d", '{"name":"d"}');

        expect(keysOf(await fetchChannelCatalog(fixture.context))).toEqual(["a", "b", "c"]);

        await invalidateChannelCache(fixture.context);
        expect(keysOf(await fetchChannelCatalog(fixture.context))).toEqual(["a", "b", "c", "d"]);
    } finally {
        fixture.close();
    }
});

test("token channel_keys filter the cached channel list", async () => {
    const { fixture } = seedChannels();
    try {
        const catalog = await fetchChannelCatalog(fixture.context);

        expect(keysOf(filterChannelsForToken(catalog, token(["a"])))).toEqual(["a"]);
        expect(keysOf(filterChannelsForToken(catalog, token(["missing"])))).toEqual([]);
        expect(keysOf(filterChannelsForToken(catalog, token()))).toEqual(["a", "b", "c"]);
    } finally {
        fixture.close();
    }
});

test("a second isolate serves the catalog from KV until it is invalidated", async () => {
    const kv = createFakeKv();
    const first = seedChannels();
    const second = seedChannels();
    attachKv(first.fixture, kv);
    attachKv(second.fixture, kv);

    try {
        expect(keysOf(await fetchChannelCatalog(first.fixture.context))).toEqual(["a", "b", "c"]);

        second.fixture.sqlite.query("DELETE FROM channel_config WHERE key != ?").run("a");
        expect(keysOf(await fetchChannelCatalog(second.fixture.context))).toEqual(["a", "b", "c"]);
        expect(second.channelSelects()).toBe(0);

        await invalidateChannelCache(second.fixture.context);
        expect(keysOf(await fetchChannelCatalog(second.fixture.context))).toEqual(["a"]);
        expect(second.channelSelects()).toBe(1);
    } finally {
        first.fixture.close();
        second.fixture.close();
    }
});
