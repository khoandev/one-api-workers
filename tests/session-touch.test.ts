import { expect, test } from "bun:test";
import { createAdminSession, validateAdminSession } from "../src/admin/auth_shared";
import { createTestDatabase } from "./helpers/sqlite-d1";

const seedSessions = () => {
    const fixture = createTestDatabase();
    fixture.sqlite.exec(`CREATE TABLE admin_session (
        token_hash TEXT PRIMARY KEY, expires_at TEXT, last_used_at TEXT, created_at TEXT, updated_at TEXT
    )`);
    fixture.sqlite.exec(`CREATE TABLE admin_login_challenge (
        challenge_id TEXT PRIMARY KEY, code TEXT, attempts INTEGER, expires_at TEXT
    )`);
    fixture.sqlite.exec(`CREATE TABLE admin_rate_limit (
        bucket_key TEXT PRIMARY KEY, attempts INTEGER, last_event_at TEXT, blocked_until TEXT
    )`);
    return fixture;
};

test("stale last_used_at is refreshed by a validated request", async () => {
    const fixture = seedSessions();
    try {
        const session = await createAdminSession(fixture.context);
        fixture.sqlite.query("UPDATE admin_session SET last_used_at = ?").run("2020-01-01 00:00:00");

        expect(await validateAdminSession(fixture.context, session.sessionToken)).toBe(true);

        const row = fixture.sqlite.query("SELECT last_used_at FROM admin_session").get() as { last_used_at: string };
        expect(row.last_used_at).not.toBe("2020-01-01 00:00:00");
    } finally {
        fixture.close();
    }
});

test("recent last_used_at is not rewritten", async () => {
    const fixture = seedSessions();
    try {
        const session = await createAdminSession(fixture.context);
        fixture.sqlite.query("UPDATE admin_session SET last_used_at = ?").run("2999-01-01 00:00:00");

        expect(await validateAdminSession(fixture.context, session.sessionToken)).toBe(true);

        const row = fixture.sqlite.query("SELECT last_used_at FROM admin_session").get() as { last_used_at: string };
        expect(row.last_used_at).toBe("2999-01-01 00:00:00");
    } finally {
        fixture.close();
    }
});
