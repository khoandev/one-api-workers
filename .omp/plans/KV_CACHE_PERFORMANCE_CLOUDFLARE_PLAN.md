# Cloudflare KV cache and request-path performance

## Context

Add a Cloudflare KV namespace as a shared L2 cache so config and analytics reads stop hitting D1/Analytics Engine on every isolate cold start. Keep API-token authentication on D1 (no KV) so revoking a token takes effect immediately. Cache the analytics dashboard for 10 seconds of freshness, and apply the related wins that do not change behavior: parallel token + channel-catalog reads, immutable caching for hashed static assets, and KV invalidation on channel/settings writes plus DB migration.

End state:

- Channel catalog, JSON settings (system/billing/pricing), analytics column support, and the analytics dashboard are served from isolate memory (L1) then KV (L2) before falling back to D1/Analytics Engine.
- Admin writes delete the matching KV key and clear the local isolate entry.
- API tokens are still read from D1 on every proxied request.
- `public/_headers` gives Vite-hashed assets `Cache-Control: public, max-age=31536000, immutable`.
- Missing KV binding or KV errors degrade to the current L1+D1 behavior; they never fail a request.

## Approach

### 1. Add a KV-backed two-level cache helper

New file `src/kv-cache.ts`. No equivalent exists (`src/cache.ts` is isolate-only).

```ts
import { Context } from "hono";
import { cachedValue, invalidateCached } from "./cache";

const L1_MAX_TTL_MS = 30_000;
const KV_CACHE_VERSION = "v1";

type KvCacheEnvelope<T> = {
    cachedAt: number;
    value: T;
};

export const getKvCacheKey = (key: string): string =>
    `oaw:cache:${KV_CACHE_VERSION}:${key}`;

export const cachedKvValue = <T>(
    c: Context<HonoCustomType>,
    key: string,
    maxAgeMs: number,
    loader: () => Promise<T>,
): Promise<T>;

export const invalidateCachedKvValue = async (
    c: Context<HonoCustomType>,
    key: string,
): Promise<void>;
```

Implementation rules:

- `cachedKvValue` wraps `cachedValue(c.env.DB, key, Math.min(L1_MAX_TTL_MS, maxAgeMs), loader)`.
- Inside the loader: if `c.env.KV` is absent, call `loader()` directly.
- Otherwise `kv.get(getKvCacheKey(key))` (raw string, not `"json"`). Parse the envelope. Return `envelope.value` only when `typeof envelope.cachedAt === "number"` and `Date.now() - envelope.cachedAt < maxAgeMs`; otherwise treat it as a miss and reload.
- On a miss, `await loader()`, then write `JSON.stringify({ cachedAt: Date.now(), value })` with `expirationTtl: Math.max(60, Math.ceil(maxAgeMs / 1000))`. KV's minimum TTL is 60 seconds; the 10-second dashboard freshness is enforced by `cachedAt`, not by the KV TTL.
- Write scheduling: try `c.executionCtx.waitUntil(writePromise)`; if the getter throws (Hono contexts in tests have no ExecutionContext), `await writePromise` instead. This keeps unit tests deterministic.
- Catch KV read errors and corrupt-JSON errors, `console.warn` once per occurrence, then fall through to `loader()`.
- Catch KV write errors inside the write promise and `console.warn`; a failed write must not reject the request.
- `invalidateCachedKvValue` always calls `invalidateCached(c.env.DB, key)` first, then `await c.env.KV?.delete(getKvCacheKey(key))` inside `try/catch` with a warning on failure.

### 2. Centralize cache keys

New file `src/cache-keys.ts`:

```ts
export const CACHE_KEYS = {
    channelCatalog: "channel_config:all",
    setting: (key: string) => `setting:json:${key}`,
    analyticsColumns: (dataset: string) => `analytics:columns:${dataset}`,
    analyticsDashboard: (range: string) => `analytics:dashboard:${range}`,
} as const;
```

Keep the logical keys identical to today’s isolate-cache keys so the existing tests’ intent is preserved. Bump `KV_CACHE_VERSION` in `src/kv-cache.ts` whenever a cached payload shape changes.

### 3. Route JSON settings through KV

`src/utils.ts`:

- Replace the `cachedValue`/`invalidateCached` imports with `cachedKvValue` / `invalidateCachedKvValue` and `CACHE_KEYS`.
- Delete `SETTING_CACHE_TTL_MS`; add `const SETTING_CACHE_MAX_AGE_MS = 5 * 60_000;`.
- `getJsonSetting` becomes:

```ts
const value = await cachedKvValue(
    c,
    CACHE_KEYS.setting(key),
    SETTING_CACHE_MAX_AGE_MS,
    () => getSetting(c, key),
);
```

- `saveSetting` keeps the D1 upsert, then `await invalidateCachedKvValue(c, CACHE_KEYS.setting(key));`.
- Leave `getSetting` uncached: DB version and migration-lock reads must stay fresh.

No change is needed in `system-config.ts`, `pricing_api.ts`, `token_utils.ts`, or `pricing-sync.ts`; they already go through `getJsonSetting`/`saveSetting`.

### 4. Route the channel catalog through KV and split load from filtering

`src/providers/shared/auth.ts`:

- Import `cachedKvValue` / `invalidateCachedKvValue`, `CACHE_KEYS`, and keep `normalizeChannelConfig`.
- Delete `CHANNEL_CACHE_TTL_MS`; add `const CHANNEL_CACHE_MAX_AGE_MS = 5 * 60_000;`.
- Keep `loadAllChannels` unchanged.
- Add:

```ts
export const fetchChannelCatalog = (
    c: Context<HonoCustomType>
): Promise<ChannelCatalog> =>
    cachedKvValue(
        c,
        CACHE_KEYS.channelCatalog,
        CHANNEL_CACHE_MAX_AGE_MS,
        () => loadAllChannels(c),
    );

export const filterChannelsForToken = (
    catalog: ChannelCatalog,
    tokenData: ApiTokenData,
): ChannelCatalog => {
    const channelKeys = tokenData.channel_keys;
    if (!channelKeys || channelKeys.length === 0) {
        return catalog;
    }

    const allowedKeys = new Set(channelKeys);
    return {
        results: catalog.results.filter((row) => allowedKeys.has(row.key)),
    };
};
```

- Delete `fetchChannelsForToken`. Every caller moves to `fetchChannelCatalog` + `filterChannelsForToken`.
- Change `invalidateChannelCache` to `async (c): Promise<void>` and `await invalidateCachedKvValue(c, CACHE_KEYS.channelCatalog)`.

Update the two proxy callers to load the token and catalog in parallel:

`src/providers/shared/channel-resolver.ts`:

```ts
const [tokenResult, catalogResult, systemConfigResult] = await Promise.allSettled([
    fetchTokenData(c, apiKey),
    fetchChannelCatalog(c),
    getSystemConfig(c),
]);

if (tokenResult.status === "rejected") throw tokenResult.reason;
if (!tokenResult.value) return c.text("Invalid API key", 401);
if (catalogResult.status === "rejected") throw catalogResult.reason;
if (systemConfigResult.status === "rejected") throw systemConfigResult.reason;

const { tokenData, usage } = tokenResult.value;
const channelsResult = filterChannelsForToken(catalogResult.value, tokenData);
```

Use `systemConfigResult.value.routing` at the existing `const routing = ...` point and delete the old `await getSystemConfig(c)` call. `Promise.allSettled` keeps the invalid-token path at 401 and avoids unhandled rejections when one loader fails.

`src/providers/models.ts`:

```ts
const [tokenResult, catalogResult] = await Promise.allSettled([
    fetchTokenData(c, apiKey),
    fetchChannelCatalog(c),
]);

if (tokenResult.status === "rejected") throw tokenResult.reason;
if (!tokenResult.value) return c.text("Invalid API key", 401);
if (catalogResult.status === "rejected") throw catalogResult.reason;

const tokenInfo = tokenResult.value;
const channelsResult = filterChannelsForToken(catalogResult.value, tokenInfo.tokenData);
```

`src/admin/channel_api.ts`: `await invalidateChannelCache(c);` in both `ChannelUpsertEndpoint` and `ChannelDeleteEndpoint` after a successful D1 write.

### 5. Invalidate the channel catalog after DB migration

`src/db/index.ts` `dbOperations.migrate` rewrites every `channel_config` row during the sanitize migration. After the final `await saveSetting(c, CONSTANTS.DB_VERSION_KEY, ...)`, add:

```ts
await invalidateCachedKvValue(c, CACHE_KEYS.channelCatalog);
```

Imports: `invalidateCachedKvValue` from `../kv-cache`, `CACHE_KEYS` from `../cache-keys`. Do not import `invalidateChannelCache` from the provider layer; it would invert the dependency direction.

### 6. Route analytics column support and the dashboard through KV

`src/analytics/query.ts`:

- Replace the `cachedValue` import with `cachedKvValue` and `CACHE_KEYS`.
- Delete `DATASET_COLUMN_SUPPORT_CACHE_TTL_MS`.
- Change `DatasetColumnSupport` to a JSON-serializable shape:

```ts
type DatasetColumnSupport = {
    availableColumns: string[];
};
```

- `getDatasetColumnSupport` calls `cachedKvValue(c, CACHE_KEYS.analyticsColumns(dataset), 60 * 60_000, async () => { ... })` and returns `{ availableColumns: [...availableColumns] }`.
- `isColumnAvailable` becomes `support.availableColumns.includes(columnName)` (column lists are ~20 entries; no Set needed).
- Export the existing range normalizer:

```ts
export const normalizeAnalyticsRange = (range?: string): AnalyticsRange =>
    getRangeConfig(range).range;
```

`src/admin/analytics_api.ts`:

- Import `cachedKvValue` and `CACHE_KEYS`, plus `normalizeAnalyticsRange`.
- Add `const DASHBOARD_CACHE_MAX_AGE_MS = 10_000;`.
- In `AnalyticsDashboardEndpoint.handle`, normalize the range first, then wrap the existing seven-call bundle in `cachedKvValue`:

```ts
const range = normalizeAnalyticsRange(c.req.query("range"));
const data = await cachedKvValue(
    c,
    CACHE_KEYS.analyticsDashboard(range),
    DASHBOARD_CACHE_MAX_AGE_MS,
    async () => {
        // existing Promise.all bundle, returns the current `data` object
    },
);
return { success: true, data } as CommonResponse;
```

- Keep the existing `toErrorResponse` wrapper. Loader errors are not cached; L1 is cleared by `cachedValue` on rejection.
- The four individual analytics endpoints are unchanged.

### 7. Add the KV binding and types

Create the namespace and write the id into the production config:

```bash
bunx wrangler kv namespace create one-api-workers-cache \
    --config wrangler.jsonc --update-config --binding KV
```

Add the same binding to `wrangler.local.jsonc` (local `--local` dev uses local persistence, not production data):

```jsonc
"kv_namespaces": [
  { "binding": "KV", "id": "<id printed by the command>" }
]
```

`type.d.ts` `CloudflareBindings`: add `KV?: KVNamespace;` (optional so tests and deployments without the binding keep compiling and degrade to L1+D1).

Do not hand-edit `worker-configuration.d.ts`; it is generated.

### 8. Immutable cache headers for hashed assets

New file `frontend/public/_headers`:

```txt
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

Vite copies `frontend/public/*` into `../public` during `bun run build`, and Workers Assets applies `_headers` to asset responses. `run_worker_first` only covers `/api`, `/v1`, `/v1beta`, so `/assets/*` is served by the Assets layer where `_headers` applies.

### 9. Keep the manual e2e fixture valid

`tests/setup-test-data.sh` writes channels/settings directly to local D1, bypassing admin APIs and therefore KV invalidation. After its existing D1 cleanup, delete the cached keys so a previously warm local worker cannot serve stale data:

```bash
for key in \
  "oaw:cache:v1:channel_config:all" \
  "oaw:cache:v1:setting:json:SYSTEM_CONFIG" \
  "oaw:cache:v1:setting:json:BILLING_CONFIG" \
  "oaw:cache:v1:setting:json:MODEL_PRICING_CONFIG" \
  "oaw:cache:v1:analytics:columns:usage_events_by_token" \
  "oaw:cache:v1:analytics:dashboard:24h" \
  "oaw:cache:v1:analytics:dashboard:7d" \
  "oaw:cache:v1:analytics:dashboard:30d" \
  "oaw:cache:v1:analytics:dashboard:90d"; do
  npx wrangler kv key delete "$key" --local --binding KV --config "$WRANGLER_CONFIG" \
    > /dev/null 2>&1 || true
done
```

## Critical files & anchors

- `src/kv-cache.ts` (new) — `cachedKvValue`, `invalidateCachedKvValue`, envelope freshness and KV error fallback.
- `src/providers/shared/auth.ts` — `fetchChannelCatalog`, `filterChannelsForToken`, async `invalidateChannelCache`; deletes `fetchChannelsForToken`.
- `src/providers/shared/channel-resolver.ts` / `src/providers/models.ts` — `Promise.allSettled` parallel token/catalog/system-config load.
- `src/admin/analytics_api.ts` — dashboard bundle wrapped in 10-second KV cache.
- `src/analytics/query.ts` — column support KV cache and array-based `DatasetColumnSupport`.

## Verification

Run from the repo root.

1. New test helper `tests/helpers/fake-kv.ts`: in-memory `get`/`put`/`delete` with call counters, captured `put` options, and failure toggles (`failGet`, `failPut`, `failDelete`). Cast it to `KVNamespace` when attaching to a test env. Existing `tests/helpers/sqlite-d1.ts` contexts have no `KV`, so all old tests exercise the L1+D1 fallback.
2. `tests/kv-cache.test.ts` (new):
   - Two `createTestDatabase()` fixtures share one fake KV and one loader; first call loads and puts, second fixture’s first call returns the KV value and the loader runs once total.
   - Envelope with `cachedAt: Date.now() - 11_000`, `maxAgeMs: 10_000` → loader runs and overwrites; `put` receives `expirationTtl: 60`.
   - `invalidateCachedKvValue` deletes the KV entry and the same fixture’s next call reloads.
   - `failGet`, corrupt JSON, and `failPut` all return the loader value; `failPut` does not reject.
   - No `KV` binding → loader runs once per L1 window.
3. `tests/settings-cache.test.ts`: add a test where fixture A writes a setting, then fixture B (same fake KV, empty D1) reads A’s value with zero `SELECT value FROM settings`; then `saveSetting` on B deletes the KV key and B reads back its own new value.
4. `tests/channel-cache.test.ts`: rewrite existing calls to `fetchChannelCatalog` + `filterChannelsForToken`; `await invalidateChannelCache`. Add the same cross-fixture KV test: fixture B serves A’s catalog from KV with zero channel SELECTs, then invalidation makes B load its own rows.
5. `tests/analytics-dashboard.test.ts`: attach fake KV. First dashboard call makes 7 upstream fetches; a second call on the same context still makes 7 (L1/hit), and a second fixture sharing the KV makes 7 (KV hit). Assert the cached response still has `range`, `displayDecimals`, `overview`, `trend`, and all four breakdown keys.
6. `bun test tests/kv-cache.test.ts tests/settings-cache.test.ts tests/channel-cache.test.ts tests/analytics-dashboard.test.ts`
7. `bun test tests`
8. `bun run typecheck`
9. `bun run build`, then `test -f public/_headers && cat public/_headers`; confirm `public/assets/*` still contains hashed bundles. `bunx wrangler deploy --dry-run --config wrangler.jsonc --outdir /tmp/oaw-dry-run` must exit 0.
10. Local smoke:
    - `bun run dev:worker`.
    - `bash tests/setup-test-data.sh`.
    - `curl -s -H 'Authorization: Bearer sk-mock-all' http://127.0.0.1:8787/v1/models` returns a non-empty model list.
    - `bunx wrangler kv key get "oaw:cache:v1:channel_config:all" --binding KV --local --config wrangler.local.jsonc` returns an envelope containing `cachedAt` and the channel results.
    - Restart the worker, call `/v1/models` again, and confirm the stored `cachedAt` is unchanged (the new isolate read KV instead of D1).
    - `bunx wrangler dev --config wrangler.local.jsonc --local --var DISABLE_ANALYTICS_QUERIES:1`, then `curl -s -H 'x-admin-token: test-admin-token' 'http://127.0.0.1:8787/api/admin/analytics/dashboard?range=24h'` returns `data.range === "24h"` and leaves `oaw:cache:v1:analytics:dashboard:24h` in local KV.
    - `curl -sI http://127.0.0.1:8787/assets/<hashed-file>.js` shows `cache-control: public, max-age=31536000, immutable`.
11. Deploy only after steps 1–10 pass: `bun run deploy`; then repeat the `/v1/models` and `curl -sI https://<worker-host>/assets/<hashed-file>.js` checks against production. Cleanup: none — KV entries are time-bounded.

## Assumptions & contingencies

- KV writes are accepted for channel/settings/pricing (5-minute max age), analytics columns (1 hour), and the dashboard (10-second freshness, 60-second KV TTL). Admin writes delete the key, but KV delete propagation is eventually consistent across locations (~60 s). Same-location visibility is immediate.
- The dashboard’s “10 seconds” is per-location freshness enforced by the envelope timestamp; a different Cloudflare location can still serve up to ~60 seconds old data because of KV propagation. If strict global 10-second freshness is required later, remove the dashboard KV cache and keep the 10-second L1 cache; the rest of the plan stands.
- API-token rows are intentionally not cached in KV: revocation must take effect on the next request. Token usage/quota writes remain D1-only and atomic.
- If `bunx wrangler kv namespace create` fails (permissions/account), stop and report the error; do not deploy with a placeholder namespace id. Local unit tests do not require a real namespace.
- If KV is unavailable, misconfigured, over the free-plan write quota, or returns corrupt data, requests fall back to L1+D1 and only log warnings.
- Channel configs in KV include upstream API keys. Cloudflare KV is private to the account; no public access is introduced.
- Direct D1 edits outside the admin APIs are not invalidated immediately; the 5-minute/1-hour max ages bound staleness. `tests/setup-test-data.sh` explicitly purges the keys it depends on.
