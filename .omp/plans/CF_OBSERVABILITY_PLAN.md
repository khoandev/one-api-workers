# Cloudflare ecosystem: enable observability, add no other service

## Context

The user asked which of ten Cloudflare services can optimize this API proxy, and explicitly wants only the worthwhile items, with the rest reported as unnecessary.

Production measurements taken before choosing (2026-11-18):

- 400 Analytics Engine usage events in 7 days: 307 success stream, 64 success sync, 26 failure stream, 3 failure sync.
- All 29 failures are `http_400` from client payloads or upstream model errors, not gateway timeouts.
- p50 stream duration 7.1 s; averages are 8–19 s. Generation time dominates.
- Colos: PHX 374, LAX 23, ATL 2, SIN 1.
- D1 primary is EWR (ENAM); 3,500 reads and 984 writes per 24 h; read replication disabled.
- The Worker already has D1, KV, Analytics Engine, Workers Static Assets, and three Workers Secrets; it has no observability and no placement (`observability` and `placement_mode` are null).

End state: Workers Logs, Traces, and source maps are enabled with query-string redaction, so the next optimization decision is based on production spans. No service from the table is added.

### Service verdicts

| Service | Decision for this repo |
| --- | --- |
| Cache API | Not needed. The channel catalog and JSON settings are already cached in isolate memory (L1) then KV (L2). `/v1/models` must still read the token from D1 so revocation stays immediate; caching its response would trade correctness for CPU savings. |
| Durable Objects | Not needed. Quota is already synchronized atomically by the conditional `UPDATE api_token` in `TokenUtils.updateUsage`; the only rate limiter is admin login, and total D1 writes are 984 per day. Per-token RPM/concurrency would be a new feature, not an optimization of current traffic. |
| Hyperdrive | Not applicable. There is no external PostgreSQL or MySQL; D1 is the only database. |
| Queues | Not needed. Analytics Engine writes already use the binding and are non-blocking. Billing is one D1 `UPDATE` per request and must stay inline so the next request sees updated quota. |
| Analytics Engine | Already used. `USAGE_ANALYTICS` records route, token, channel, provider, model, tokens, cost, duration, retries, status family, and colo, indexed by token hash; the admin dashboard bundle is cached. |
| Service Bindings | Not needed. This is a single Worker; adding an internal hop adds latency without isolating any backend. |
| R2 | Not needed. There is no large-log, backup, or export requirement; Analytics Engine retains queryable history for the dashboard. |
| Workers Static Assets | Already used. `assets.binding` is `ASSETS`, `run_worker_first` covers only `/api`, `/v1`, and `/v1beta`, and `public/_headers` sets immutable caching for `/assets/*`. |
| Smart Placement | Not now. D1 primary is EWR while traffic is PHX/LAX; two D1 round trips per proxied request cost tens of milliseconds each, roughly 1% of a 7.1 s p50 stream. Placement also needs multi-location traffic to analyze (374 of 400 events came from one colo). Revisit only if traces show D1 spans above 5% of request duration. |
| Workers Secrets | Already used for `ADMIN_TOKEN`, `CF_API_TOKEN`, and `CF_ACCOUNT_ID`. Per-channel upstream keys are tenant data edited at runtime in D1 and cannot be deploy-time secrets. |

The only missing platform capability is observability. Enable it; add nothing else.

## Approach

### 1. Add observability and source maps to the production config

Edit `wrangler.jsonc` only. Insert these keys after `"compatibility_date": "2025-04-28",` and before `"workers_dev": true,`:

```jsonc
  "upload_source_maps": true,
  "observability": {
    "enabled": true,
    "redact_query_string": true,
    "head_sampling_rate": 1,
    "traces": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  },
```

Rules and rationale:

- `redact_query_string: true` is required. `getApiKeyFromQuery` in `src/providers/shared/auth.ts` accepts `?key=<api token>` on `/v1beta/models/*`; without redaction, invocation logs would persist live API tokens.
- Logs and traces use `head_sampling_rate: 1`. At 400 events per 7 days (under 100 Worker invocations per day) sampling everything is negligible; lower it only when traffic grows.
- Keep invocation logs enabled (default); do not set `invocation_logs: false`.
- Do not set `observability.traces.persist` or destinations; the Cloudflare dashboard is the only consumer.
- Leave `wrangler.local.jsonc` unchanged. `wrangler dev` already prints console output locally, and the production settings are what is being changed.
- Do not change `compatibility_date`, bindings, migrations, or application code.

### 2. Deploy the config-only change

From the repository root:

```bash
bunx wrangler deploy --config wrangler.jsonc
```

Do not run `bun run build`: no source or frontend changed, and `public/` is already the deployed asset set. The deploy must use the authenticated account that owns `api.khoan.dev`; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present in the environment.

Expected: exit 0, a new version id, and the existing bindings listed unchanged.

### 3. Confirm the deployed setting

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/one-api-workers/settings" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result.observability'
```

Expected: a non-null object with `"enabled": true`. If the response shape omits the nested `traces` object, do not treat that as failure; the dashboard trace check below is authoritative for tracing.

## Critical files & anchors

- `wrangler.jsonc` — top-level config; insert the observability block next to `compatibility_date`, before `workers_dev`. `assets`, `d1_databases`, `kv_namespaces`, and `analytics_engine_datasets` are unchanged.
- `src/providers/shared/auth.ts` — `getApiKeyFromQuery` is the reason `redact_query_string` is mandatory; no code change.
- `src/index.ts` — Worker entry and API-only middleware; no code change.

## Verification

Run from the repository root.

1. Config validation before deploy:

   ```bash
   bunx wrangler deploy --dry-run --config wrangler.jsonc --outdir /tmp/oaw-observability
   ```

   Expected: exit 0 and a bundle written under `/tmp/oaw-observability`.

2. Deploy with the command from step 2. Expected: exit 0, new version id, no missing-secret errors.

3. Deployed settings check from step 3. Expected: `observability.enabled` is `true`.

4. Generate one Worker invocation and confirm the response is unchanged:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.khoan.dev/v1/models
   ```

   Expected: `200`. Before this change the same request returned `200` with `{"object":"list","data":[]}`.

5. Generate the redaction case:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     'https://api.khoan.dev/v1beta/models/gemini-2.5-flash:generateContent?key=INVALID_SMOKE'
   ```

   Expected: `401`.

6. Open the Cloudflare dashboard for the account and Worker `one-api-workers` → Observability. Within 60 seconds:
   - Logs show the two invocations above. The Gemini invocation URL has no `key=` query string (redaction works).
   - Traces show a trace for the `/v1/models` request with a D1 binding span.

   If the dashboard has no data after 5 minutes, check the time range and Worker filter, then report the empty result; the deployed setting stays enabled because it is additive and does not change behavior.

## Assumptions & contingencies

- Traces are available on this account's Workers plan. If `wrangler deploy` rejects `observability.traces`, set `"traces": { "enabled": false }`, redeploy with logs and redaction intact, and report that traces are unavailable.
- Deployment targets production `one-api-workers` in the account that owns `api.khoan.dev`; `api.khoan.dev` and the workers.dev subdomain both remain reachable.
- If the deploy fails for a reason unrelated to config validation, do not create or rotate secrets; report the exact error. Roll back with `bunx wrangler rollback --config wrangler.jsonc` only if the smoke request or admin UI regresses.
