import { expect, test } from "bun:test";
import { fetchChannelsForToken, invalidateChannelCache } from "../src/providers/shared/auth";
import { createTestDatabase } from "./helpers/sqlite-d1";

const seedChannels = () => {
    const fixture = createTestDatabase();
    fixture.sqlite.exec(`CREATE TABLE channel_config (
        key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT
    )`);
    fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("a", '{"name":"a"}');
    fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("b", '{"name":"b"}');

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

const keysOf = (result: { results?: ChannelConfigRow[] }) =>
    (result.results ?? []).map((row) => row.key).sort();

test("repeated token channel reads hit channel_config once", async () => {
    const { fixture, channelSelects } = seedChannels();
    try {
        expect(keysOf(await fetchChannelsForToken(fixture.context, token()))).toEqual(["a", "b"]);
        expect(keysOf(await fetchChannelsForToken(fixture.context, token()))).toEqual(["a", "b"]);
        expect(channelSelects()).toBe(1);
    } finally {
        fixture.close();
    }
});

test("raw channel writes stay invisible until the cache is invalidated", async () => {
    const { fixture } = seedChannels();
    try {
        await fetchChannelsForToken(fixture.context, token());
        fixture.sqlite.query("INSERT INTO channel_config (key, value) VALUES (?, ?)").run("c", '{"name":"c"}');

        expect(keysOf(await fetchChannelsForToken(fixture.context, token()))).toEqual(["a", "b"]);

        invalidateChannelCache(fixture.context);
        expect(keysOf(await fetchChannelsForToken(fixture.context, token()))).toEqual(["a", "b", "c"]);
    } finally {
        fixture.close();
    }
});

test("token channel_keys filter the cached channel list", async () => {
    const { fixture } = seedChannels();
    try {
        expect(keysOf(await fetchChannelsForToken(fixture.context, token(["a"])))).toEqual(["a"]);
        expect(keysOf(await fetchChannelsForToken(fixture.context, token(["missing"])))).toEqual([]);
    } finally {
        fixture.close();
    }
});
