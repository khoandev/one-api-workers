import { expect, test } from "bun:test";
import { getJsonSetting, saveSetting } from "../src/utils";
import { createTestDatabase } from "./helpers/sqlite-d1";

const seedSettings = () => {
    const fixture = createTestDatabase();
    fixture.sqlite.exec(`CREATE TABLE settings (
        key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT
    )`);

    let settingSelects = 0;
    const originalPrepare = fixture.database.prepare;
    fixture.database.prepare = ((sql: string, params?: unknown[]) => {
        if (/SELECT value FROM settings/i.test(sql)) {
            settingSelects += 1;
        }
        return originalPrepare(sql, params as never);
    }) as typeof fixture.database.prepare;

    return { fixture, settingSelects: () => settingSelects };
};

test("repeated JSON setting reads hit settings once", async () => {
    const { fixture, settingSelects } = seedSettings();
    try {
        await saveSetting(fixture.context, "fixture", JSON.stringify({ value: 1 }));

        expect(await getJsonSetting(fixture.context, "fixture")).toEqual({ value: 1 });
        expect(await getJsonSetting(fixture.context, "fixture")).toEqual({ value: 1 });
        expect(settingSelects()).toBe(1);
    } finally {
        fixture.close();
    }
});

test("raw setting updates stay invisible until saveSetting runs", async () => {
    const { fixture } = seedSettings();
    try {
        await saveSetting(fixture.context, "fixture", JSON.stringify({ value: 1 }));
        await getJsonSetting(fixture.context, "fixture");

        fixture.sqlite.query("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify({ value: 2 }), "fixture");
        expect(await getJsonSetting(fixture.context, "fixture")).toEqual({ value: 1 });

        await saveSetting(fixture.context, "fixture", JSON.stringify({ value: 3 }));
        expect(await getJsonSetting(fixture.context, "fixture")).toEqual({ value: 3 });
    } finally {
        fixture.close();
    }
});
