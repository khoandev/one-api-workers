import { expect, test } from "bun:test";
import { Context } from "hono";
import { AnalyticsDashboardEndpoint } from "../src/admin/analytics_api";
import { createTestDatabase } from "./helpers/sqlite-d1";

const buildFixture = () => {
    const fixture = createTestDatabase();
    fixture.sqlite.exec(`CREATE TABLE settings (
        key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT
    )`);
    fixture.sqlite
        .query("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("SYSTEM_CONFIG", JSON.stringify({ displayDecimals: 4 }));

    const env = fixture.context.env as unknown as Record<string, unknown>;
    env.CF_API_TOKEN = "test-token";
    env.CF_ACCOUNT_ID = "acct";
    env.USAGE_ANALYTICS_DATASET = "usage_events_by_token";

    const context = new Context<HonoCustomType>(
        new Request("http://localhost/api/admin/analytics/dashboard?range=24h"),
        { env: fixture.context.env }
    );

    return { fixture, context };
};

test("dashboard bundle probes the dataset once per cache window", async () => {
    const { fixture, context } = buildFixture();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1;
        const query = typeof init?.body === "string" ? init.body : "";
        const isColumnProbe = /SELECT\s+\*\s+FROM/i.test(query);
        const payload = isColumnProbe
            ? { data: [], meta: [{ name: "double1" }] }
            : { data: [] };

        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;

    try {
        const first = await new AnalyticsDashboardEndpoint().handle(context) as {
            success: boolean;
            data: Record<string, unknown>;
        };
        expect(fetchCount).toBe(7);
        expect(first.success).toBe(true);
        expect(Object.keys(first.data).sort()).toEqual(
            ["breakdowns", "displayDecimals", "overview", "range", "trend"]
        );
        expect(first.data.range).toBe("24h");
        expect(first.data.displayDecimals).toBe(4);
        expect(Object.keys(first.data.breakdowns as Record<string, unknown>).sort()).toEqual(
            ["channel", "model", "provider", "token"]
        );

        const second = await new AnalyticsDashboardEndpoint().handle(context);
        expect(fetchCount).toBe(13);
        expect(second).toMatchObject({ success: true });
    } finally {
        globalThis.fetch = originalFetch;
        fixture.close();
    }
});
