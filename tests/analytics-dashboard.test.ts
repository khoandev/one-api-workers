import { expect, test } from "bun:test";
import { Context } from "hono";
import { AnalyticsDashboardEndpoint } from "../src/admin/analytics_api";
import { attachKv, createFakeKv } from "./helpers/fake-kv";
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

const expectDashboardPayload = (data: Record<string, unknown>) => {
    expect(Object.keys(data).sort()).toEqual(
        ["breakdowns", "displayDecimals", "overview", "range", "trend"]
    );
    expect(data.range).toBe("24h");
    expect(data.displayDecimals).toBe(4);
    expect(Object.keys(data.breakdowns as Record<string, unknown>).sort()).toEqual(
        ["channel", "model", "provider", "token"]
    );
    expect(Object.keys(data.overview as Record<string, unknown>).sort()).toEqual(["range", "totals"]);
    expect(Object.keys(data.trend as Record<string, unknown>).sort()).toEqual(["bucket", "points", "range"]);
};

test("dashboard bundle is served from cache after the first probe", async () => {
    const kv = createFakeKv();
    const first = buildFixture();
    const second = buildFixture();
    attachKv(first.fixture, kv);
    attachKv(second.fixture, kv);

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
        const firstResult = await new AnalyticsDashboardEndpoint().handle(first.context) as {
            success: boolean;
            data: Record<string, unknown>;
        };
        expect(fetchCount).toBe(7);
        expect(firstResult.success).toBe(true);
        expectDashboardPayload(firstResult.data);

        const secondResult = await new AnalyticsDashboardEndpoint().handle(first.context) as {
            success: boolean;
            data: Record<string, unknown>;
        };
        expect(fetchCount).toBe(7);
        expectDashboardPayload(secondResult.data);

        expect(kv.store.has("oaw:cache:v1:analytics:dashboard:24h")).toBe(true);

        const otherIsolate = await new AnalyticsDashboardEndpoint().handle(second.context) as {
            success: boolean;
            data: Record<string, unknown>;
        };
        expect(fetchCount).toBe(7);
        expectDashboardPayload(otherIsolate.data);
    } finally {
        globalThis.fetch = originalFetch;
        first.fixture.close();
        second.fixture.close();
    }
});
