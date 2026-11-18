import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import db from "../src/db"
import app from "../src/index"
import { createFakeKv } from "./helpers/fake-kv"

type Row = Record<string, any>

/**
 * Minimal D1 surface backed by in-memory SQLite: the Worker runs locally without workerd,
 * so routing, middleware, CORS, and auth can be exercised against the real Hono app.
 */
const createD1 = () => {
    const sqlite = new Database(":memory:")

    const bound = (sql: string, args: unknown[] = []) => ({
        bind: (...next: unknown[]) => bound(sql, next),
        first: async (column?: string) => {
            const row = sqlite.query(sql).get(...(args as any[])) as Row | null
            if (!row) return null
            return column ? (row[column] ?? null) : row
        },
        all: async () => ({ results: sqlite.query(sql).all(...(args as any[])), success: true, meta: {} }),
        run: async () => {
            const result = sqlite.query(sql).run(...(args as any[]))
            return {
                success: true,
                meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
            }
        },
    })

    return {
        sqlite,
        exec: async (sql: string) => { sqlite.exec(sql) },
        prepare: (sql: string) => bound(sql),
        batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
            return Promise.all(statements.map((statement) => statement.run()))
        },
    }
}

const pending: Promise<unknown>[] = []

const createEnv = (d1: ReturnType<typeof createD1>) => ({
    DB: d1,
    ADMIN_TOKEN: "admin-token",
    USAGE_ANALYTICS: { writeDataPoint: () => {} },
    USAGE_ANALYTICS_DATASET: "usage_events_by_token",
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
})

const createContext = () => ({
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    passThroughOnException: () => {},
})

const geminiResponse = (text: string) => ({
    responseId: "gemini-test",
    modelVersion: "gemini-2.0-flash",
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
})

let d1: ReturnType<typeof createD1>
let env: ReturnType<typeof createEnv>
let originalFetch: typeof fetch
let upstreamUrl: URL | null = null

beforeAll(async () => {
    d1 = createD1()
    env = createEnv(d1)

    await db.initialize({ env } as any)

    d1.sqlite.run(
        `INSERT INTO channel_config (key, value) VALUES (?, ?)`,
        [
            "test-gemini",
            JSON.stringify({
                name: "test-gemini",
                type: "gemini-native",
                endpoint: "https://generativelanguage.googleapis.com",
                api_key: "channel-key",
                deployment_mapper: { "gemini-test": "gemini-2.0-flash" },
            }),
        ],
    )
    d1.sqlite.run(
        `INSERT INTO api_token (key, value, usage) VALUES (?, ?, 0)`,
        [
            "sk-app-test",
            JSON.stringify({ name: "app-test", channel_keys: ["test-gemini"], total_quota: 999999999 }),
        ],
    )

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(String(input))
        upstreamUrl = new URL(request.url)
        return Response.json(geminiResponse("routed"))
    }) as typeof fetch
})

afterAll(() => {
    globalThis.fetch = originalFetch
    d1?.sqlite.close()
})

const dispatch = (request: Request) => app.fetch(request, env as any, createContext() as any)

test("gemini route authenticates with x-goog-api-key and proxies upstream", async () => {
    const response = await dispatch(new Request(
        "http://localhost/v1beta/models/gemini-test:generateContent",
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": "sk-app-test" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        },
    ))

    expect(response.status).toBe(200)
    const body = await response.json() as Row
    expect(body.candidates[0].content.parts[0].text).toBe("routed")
    expect(upstreamUrl?.pathname).toBe("/v1beta/models/gemini-2.0-flash:generateContent")
    expect(upstreamUrl?.searchParams.get("key")).toBeNull()
})

test("gemini route accepts ?key=", async () => {
    const response = await dispatch(new Request(
        "http://localhost/v1beta/models/gemini-test:generateContent?key=sk-app-test",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        },
    ))

    expect(response.status).toBe(200)
})

test("?key= is rejected on the OpenAI routes", async () => {
    const response = await dispatch(new Request(
        "http://localhost/v1/chat/completions?key=sk-app-test",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gemini-test", messages: [{ role: "user", content: "hi" }] }),
        },
    ))

    expect(response.status).toBe(401)
    expect(await response.text()).toContain("Authorization header")
})

test("gemini route answers CORS preflight", async () => {
    const response = await dispatch(new Request(
        "http://localhost/v1beta/models/gemini-test:generateContent",
        {
            method: "OPTIONS",
            headers: {
                Origin: "https://client.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-goog-api-key,content-type",
            },
        },
    ))

    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-goog-api-key")
})

test("unknown gemini GET returns an API 404 instead of the SPA entry", async () => {
    const response = await dispatch(new Request("http://localhost/v1beta/models"))

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html")
})

// Stands in for the manual `/v1/models` smoke check: workerd cannot start on this host.
test("/v1/models fills KV and a cold isolate serves the catalog from it", async () => {
    const kv = createFakeKv()
    // A fresh DB wrapper is a fresh isolate scope, so L1 starts cold each call.
    const kvEnv = () => ({ ...env, DB: { ...d1 }, KV: kv.namespace })
    const listModels = (scopeEnv: unknown) => app.fetch(
        new Request("http://localhost/v1/models", {
            headers: { authorization: "Bearer sk-app-test" },
        }),
        scopeEnv as any,
        createContext() as any,
    )

    const first = await listModels(kvEnv())
    expect(first.status).toBe(200)
    const firstBody = await first.json() as Row
    expect(firstBody.data.map((model: Row) => model.id)).toContain("gemini-test")
    await Promise.all(pending.splice(0))

    const cached = kv.store.get("oaw:cache:v1:channel_config:all")
    expect(cached).toBeString()
    expect(JSON.parse(cached as string)).toMatchObject({
        value: { results: [{ key: "test-gemini" }] },
    })

    d1.sqlite.run("DELETE FROM channel_config")
    const second = await listModels(kvEnv())
    expect(second.status).toBe(200)
    const secondBody = await second.json() as Row
    expect(secondBody.data.map((model: Row) => model.id)).toContain("gemini-test")
})

test("gemini route returns the gemini error envelope on auth failure", async () => {
    const response = await dispatch(new Request(
        "http://localhost/v1beta/models/gemini-test:generateContent",
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": "bad" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        },
    ))

    expect(response.status).toBe(401)
    const body = await response.json() as Row
    expect(body.error.status).toBe("UNAUTHENTICATED")
})
