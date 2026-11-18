# Performance, request-count, and Cloudflare quota optimization

## Context

The user wants lower latency, fewer Cloudflare Worker requests/subrequests, and lower D1/Analytics Engine usage, plus a faster admin UI. A dashboard load currently costs ~11 admin API requests (auth check via the full channel-list endpoint, 4 analytics sections as 6 separate requests, billing config), and every admin request performs a D1 session `UPDATE last_used_at`. Every proxied API request performs 2–3 D1 reads (token, all channel configs, global pricing on the billing path). Production serves every static asset through the Worker because `run_worker_first: true`. End state: one analytics dashboard request per range, one minimal session check, cached channel/pricing/system config per isolate with 30 s TTL, throttled session touches, Analytics SQL probe cached per dataset, and static assets served directly by the Assets layer in production.

## Approach

### 1. Add an isolate-scoped single-flight cache primitive

New file `src/cache.ts`. No equivalent utility exists (`src/analytics/query.ts` has a bespoke one-off map; `src/utils.ts` has no cache).

```ts
type CacheEntry = { expiresAt: number; promise: Promise<unknown> }
const stores = new WeakMap<object, Map<string, CacheEntry>>()

export const cachedValue = <T>(
    scope: object,
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
): Promise<T>

export const invalidateCached = (scope: object, key: string): void
```

- `cachedValue`: reuse `entry.promise` when `entry.expiresAt > Date.now()`; otherwise call `loader()` once, store `{ expiresAt: now + ttlMs, promise }` before awaiting, return the same promise to concurrent callers.
- On rejection, delete the entry only if it is still the same entry (`store.get(key) === entry`), then rethrow. Never cache failures.
- `invalidateCached` uses `stores.get(scope)?.delete(key)` (must not create a map).
- Scope is always `c.env.DB` (D1 binding object). In production it is stable per isolate; in tests `createTestDatabase()` returns a fresh DB object per fixture, so caches cannot leak across tests.

### 2. Cache settings and channel configs on the proxy path

`src/utils.ts`:

- `const SETTING_CACHE_TTL_MS = 30_000` and `const settingCacheKey = (key: string) => \`setting:json:${key}\``.
- Change only `getJsonSetting`: replace its `getSetting(c, key)` call with
  `cachedValue(c.env.DB, settingCacheKey(key), SETTING_CACHE_TTL_MS, () => getSetting(c, key))`.
- `saveSetting`: after the successful `run()`, call `invalidateCached(c.env.DB, settingCacheKey(key))`.
- Leave raw `getSetting` uncached (migration lock and DB version reads need fresh values).

`src/providers/shared/auth.ts`:

- `const CHANNEL_CACHE_KEY = "channel_config:all"`, `const CHANNEL_CACHE_TTL_MS = 30_000`.
- Add `export const invalidateChannelCache = (c: Context<HonoCustomType>): void => invalidateCached(c.env.DB, CHANNEL_CACHE_KEY)`.
- Extract `loadAllChannels(c)` with the current `SELECT key, value FROM channel_config` query.
- `fetchChannelsForToken` becomes: load all channels through `cachedValue(c.env.DB, CHANNEL_CACHE_KEY, CHANNEL_CACHE_TTL_MS, () => loadAllChannels(c))`, then return the cached result unchanged when `tokenData.channel_keys` is absent/empty, else `{ ...result, results: (result.results ?? []).filter((row) => new Set(tokenData.channel_keys).has(row.key)) }` (build the `Set` once).
- Delete `fetchAllChannels`; it has no callers (verified by grep).

Invalidation: `src/admin/channel_api.ts` `ChannelUpsertEndpoint` and `ChannelDeleteEndpoint` call `invalidateChannelCache(c)` after a successful write. `TokenUtils.getPricing` and `ModelsEndpoint` keep using `getJsonSetting`, so the pricing cache applies to them without changes.

Handling: rejected loaders propagate after deleting the cache entry; a token whose `channel_keys` match nothing yields an empty `results` array, and the existing resolver 401 path is unchanged.

### 3. Cut admin-session D1 writes and shrink the auth-check request

`src/admin/auth_shared.ts`:

- Add `const ADMIN_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000`.
- Change `ARTIFACT_CLEANUP_INTERVAL_MS` from `60_000` to `15 * 60_000` (three DELETE statements per isolate per cleanup).
- `validateAdminSession`: `SELECT token_hash, expires_at, last_used_at` and type it as `Pick<AdminSessionRow, "token_hash" | "expires_at" | "last_used_at">`.
- Add a module helper that parses SQLite UTC timestamps: if the value lacks `T`, replace the space with `T`; append `Z` when no timezone suffix is present; feed that to `Date.parse`.
- Run the `UPDATE admin_session SET last_used_at = ...` only when the parsed `last_used_at` is not finite or `Date.now() - lastUsedAtMs >= ADMIN_SESSION_TOUCH_INTERVAL_MS`. Keep the expired-session DELETE path unchanged.

`src/admin/auth_api.ts` + `src/admin/index.ts`:

- Add `AdminSessionEndpoint` (`GET /api/admin/auth/session`, not in `PUBLIC_AUTH_ROUTES`) returning `{ success: true, data: { authenticated: true } }`; schema data is `z.object({ authenticated: z.boolean() })`.
- Register with `api.get("/api/admin/auth/session", AdminSessionEndpoint)` beside the other auth routes.

Frontend: change `apiClient.checkAuth` to request `/api/admin/auth/session` (see step 7). This removes the channel-list query and response payload from app startup.

### 4. Reduce analytics Engine SQL calls

`src/analytics/query.ts`:

- `getDatasetColumnSupport(c, dataset)` drops the `whereClause` parameter and the bespoke `DATASET_COLUMN_SUPPORT_CACHE`. Use
  `cachedValue(c.env.DB, \`analytics:columns:${dataset}\`, 5 * 60_000, loader)`, where `loader` runs `SELECT * FROM ${dataset} LIMIT 1` (no WHERE, so a cached probe can never be poisoned by an empty time window). Delete the old TTL constant/map. Update all five callers (`queryUsageOverview`, `queryUsageTrend`, `queryUsageBreakdown`, `queryUsageEvents`, `queryUsageLogRecords`) to `getDatasetColumnSupport(c, dataset)`.
- `queryUsageLogRecords`: keep the existing base `count()` (needed for the empty-window early return). After schema checks, set `const hasFilters = Boolean(keyword) || result !== "all"`; when `hasFilters` is false use `baseTotal` as `total` and skip the second count query; when true run the existing filtered count. Data query and pagination are unchanged.

`src/admin/analytics_api.ts`:

- Add `AnalyticsDashboardEndpoint` at `GET /api/admin/analytics/dashboard`, query schema `range: rangeSchema`, response `CommonSuccessfulResponse(z.any())`.
- Handler runs in parallel:
  `Promise.all([queryUsageOverview, queryUsageTrend, queryUsageBreakdown(..., "token"), (..., "channel"), (..., "model"), (..., "provider"), getSystemConfig(c)])`.
- Return exactly:
  `{ success: true, data: { range: overview.range, displayDecimals: systemConfig.displayDecimals, overview, trend, breakdowns: { token, channel, model, provider } } }`.
- Errors use the existing `toErrorResponse(c, error, "Failed to query analytics dashboard")` (one failed query fails the bundle with the existing status mapping).
- Register `api.get("/api/admin/analytics/dashboard", AnalyticsDashboardEndpoint)` in `src/admin/index.ts`. Keep the four existing analytics endpoints and `queryUsageEvents` unchanged (documented admin API).

### 5. D1 cold-start fast path

`src/db/index.ts`:

- Add `const readDbVersion = async (c) => { try { return await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(CONSTANTS.DB_VERSION_KEY).first<string>("value") } catch { return null } }` so a missing `settings` table does not log an error.
- In `ensureReady`'s promise body: `const version = await readDbVersion(c); if (version !== CONSTANTS.DB_VERSION) await dbOperations.migrate(c);`.
- Add a comment above the fast path: `// DB_VERSION guards this fast path: bump CONSTANTS.DB_VERSION whenever DB_INIT_QUERIES changes.`
- `db.migrate` and `db.getVersion` keep their current behavior.

### 6. Serve static assets without invoking the Worker in production

`wrangler.jsonc` only (leave `wrangler.local.jsonc` at `run_worker_first: true` so the Vite proxy/HMR dev flow keeps working):

```jsonc
"run_worker_first": ["/api", "/api/*", "/v1", "/v1/*", "/v1beta", "/v1beta/*"]
```

Matches API paths go to the Worker; HTML/JS/CSS and the SPA fallback are served by the Assets layer and no longer consume Worker requests. `/api`, `/v1`, `/v1beta` exact patterns preserve the current 404 behavior (without them the SPA fallback would return `index.html`).

### 7. Frontend: one analytics request, fewer refetches, code splitting

`frontend/src/types/index.ts`:

```ts
export interface AnalyticsDashboardData {
  range: AnalyticsRange
  displayDecimals: number
  overview: AnalyticsOverviewData
  trend: AnalyticsTrendData
  breakdowns: Record<AnalyticsBreakdownDimension, AnalyticsBreakdownData>
}
```

Delete `AnalyticsEventsData` (its only consumer is removed below); keep `AnalyticsEventItem`.

`frontend/src/api/client.ts`:

- Remove `getAnalyticsOverview`, `getAnalyticsTrend`, `getAnalyticsBreakdown`, `getAnalyticsEvents` and their now-unused type imports.
- Add `getAnalyticsDashboard: (range: AnalyticsRange) => request<ApiResponse<AnalyticsDashboardData>>(\`/api/admin/analytics/dashboard?range=${encodeURIComponent(range)}\`, { method: 'GET' })`.
- `checkAuth` requests `/api/admin/auth/session`.

`frontend/src/pages/Analytics.tsx`:

- Delete the six `useQuery` calls and the per-section cache keys/readers/writers.
- One cache key: `const getAnalyticsDashboardCacheKey = (range: AnalyticsRange) => \`analytics:dashboard:${range}\``.
- One query: key `["analytics", "dashboard", range]`, `queryFn` calls `apiClient.getAnalyticsDashboard(range)`, writes the scoped cache, returns `data as AnalyticsDashboardData`, `initialData`/`initialDataUpdatedAt` from `readScopedCache`, `staleTime: 60_000`.
- `const dashboard = dashboardQuery.data`; `overview = dashboard?.overview`; `trend = dashboard?.trend`; `breakdownDataMap` reads `dashboard?.breakdowns[dimension]`; all four `BreakdownChartCard`s use `isLoading={dashboardQuery.isPending}` and `isError={dashboardQuery.isError}`.
- `displayDecimals = dashboard?.displayDecimals ?? DEFAULT_BILLING_DISPLAY_DECIMALS` (import the constant from `@/lib/billing`); remove `useBillingConfig` from this page.
- `isFetching = dashboardQuery.isFetching`; refresh calls `dashboardQuery.refetch()`.

`frontend/src/App.tsx`:

- QueryClient defaults add `staleTime: 30_000` (keep `retry: 1`, `refetchOnWindowFocus: false`), so navigating between Channels/Tokens/Pricing reuses cached lists.
- Route-level code splitting with `lazy` + `Suspense` for `Analytics`, `UsageLogs`, `Channels`, `Tokens`, `Pricing`, `ApiTest`, `SystemSettings`; keep `Dashboard` eager. Each import maps the named export to `default`, e.g. `lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })))`. Wrap `<Routes>` in `<Suspense fallback={<div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>` (import `Loader2` from `lucide-react`).

### 8. Remove per-request success logging

`src/admin/token_utils.ts` `processUsage`: delete `console.log("Usage data:", usage)` and the successful-charge `console.log(...)`. Keep the quota-exceeded warning, the no-pricing warning, and all billing behavior.

## Critical files & anchors

- `src/utils.ts` — `getJsonSetting` / `saveSetting`: settings cache and invalidation.
- `src/providers/shared/auth.ts` — `fetchChannelsForToken`: cached all-channel load plus token filtering.
- `src/analytics/query.ts` — `getDatasetColumnSupport` (probe cache) and `queryUsageLogRecords` (count reuse).
- `frontend/src/pages/Analytics.tsx` — replace six queries with the dashboard bundle query.
- `wrangler.jsonc` — `assets.run_worker_first` array.

## Verification

Run from repo root unless noted.

1. `bun test tests/cache.test.ts tests/channel-cache.test.ts tests/settings-cache.test.ts tests/session-touch.test.ts tests/analytics-dashboard.test.ts` — new tests:
   - `cache.test.ts`: concurrent calls share one loader invocation; `invalidateCached` forces a reload; scope A/B do not share entries; a rejected loader is not cached; `ttlMs: 0` reloads on the next call.
   - `channel-cache.test.ts` (uses `tests/helpers/sqlite-d1.ts`): seed two channels; wrap `database.prepare` to count `FROM channel_config`; two `fetchChannelsForToken` calls → one SELECT; raw-insert a third channel → still cached (not returned); `invalidateChannelCache(context)` → next call returns the third channel; `channel_keys: ["a"]` returns only `a`.
   - `settings-cache.test.ts`: `saveSetting` then two `getJsonSetting` reads → one `SELECT value FROM settings`; raw-SQL update → cached value unchanged; `saveSetting` again → new value returned.
   - `session-touch.test.ts`: create session; set `last_used_at = '2020-01-01 00:00:00'`; `validateAdminSession` updates it; set `last_used_at = '2999-01-01 00:00:00'`; validate again → value stays `'2999-01-01 00:00:00'`.
   - `analytics-dashboard.test.ts`: fresh `createTestDatabase()` + env `{ CF_API_TOKEN: "test", CF_ACCOUNT_ID: "acct", USAGE_ANALYTICS_DATASET: "usage_events_by_token" }`; spy `globalThis.fetch` to answer the probe SQL (`SELECT * ... LIMIT 1`) with `meta: [{ name: "double1" }]` and every other SQL with `{ data: [] }`. Call `new AnalyticsDashboardEndpoint().handle(context)` twice; first call makes 7 upstream fetches (1 probe + 6 queries), second makes 6 (probe cached); result contains `range`, `displayDecimals` (6), `overview`, `trend`, `breakdowns.token/channel/model/provider`.
2. `bun run typecheck` — Worker + frontend TypeScript.
3. `bun test tests` — existing suite (migration, routing, auth, pricing sync, protocol conversion).
4. `cd frontend && bun run lint`.
5. `bun run build` — check `ls public/assets/*.js | wc -l` is greater than 1 and the entry `index-*.js` is below 500 KB (previous single bundle: 705.7 KB).
6. Local Worker smoke (`.dev.vars` has `ADMIN_TOKEN=test-admin-token`):
   - `bun run dev:worker`, then `curl -s -H 'x-admin-token: test-admin-token' http://127.0.0.1:8787/api/admin/auth/session` → `{"success":true,"data":{"authenticated":true}}`.
   - Restart with `bunx wrangler dev --config wrangler.local.jsonc --local --var DISABLE_ANALYTICS_QUERIES:1`, then `curl -s -H 'x-admin-token: test-admin-token' 'http://127.0.0.1:8787/api/admin/analytics/dashboard?range=24h'` → `data` keys are exactly `range`, `displayDecimals`, `overview`, `trend`, `breakdowns`.
   - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/` → `200`.
7. Production config validation: `bunx wrangler deploy --dry-run --config wrangler.jsonc --outdir /tmp/oaw-dry-run` exits 0. After a real deploy, `wrangler tail` while loading the admin UI must show no requests for `/assets/*`, `/favicon*`, or `/` (only `/api/*`), which is the static-asset quota win.

## Assumptions & contingencies

- Accepted tradeoff: channel, pricing, and system-config reads may be up to 30 s stale per isolate. Admin writes made through the same isolate are immediately visible because their handlers invalidate the same scoped key. If zero staleness is required, do not cache `getJsonSetting`/channels; the other steps still stand.
- Existing admin analytics endpoints stay available; the frontend switches to the new bundle endpoint. Pricing cache staleness can misprice at most the requests handled by an isolate during the 30 s window.
- If the `run_worker_first` array causes SPA or API routing problems in a local production-config smoke test, revert `wrangler.jsonc` to `run_worker_first: true`; keep every other optimization. Do not change `wrangler.local.jsonc`.
- If the analytics dashboard bundle fails because one Analytics Engine query fails, keep the single-request design and return the existing error mapping (no per-section partial responses).
