---
title: Airlock Protocol Adapters
slug: airlock-protocol-adapters
---

## Context

**Literal ask.** Merge Airlock's Protocol Adapters into one-api-workers so a request to `/v1/chat/completions`, `/v1/messages`, or `/v1/responses` is accepted regardless of which upstream protocol the selected channel speaks. Convert automatically when client protocol and channel protocol differ. Do not depend on the upstream exposing the same protocol as the client.

**Current repo state.**
- `src/providers/index.ts` routes three text endpoints plus audio to one handler.
- `src/providers/shared/route-policy.ts` hardcodes separate channel-type allowlists per route: chat allows only OpenAI/Gemini; messages only Claude/c2o; responses only Responses. Cross-protocol models are rejected as `Model not supported`.
- `src/providers/claude-to-openai-proxy.ts` is a 606-line hand-written one-way adapter used only for `/v1/messages` to OpenAI-chat channels. It duplicates request/response/SSE conversion.
- Direct same-protocol proxies (`openai-proxy`, `claude-proxy`, Responses proxies, Azure variants) work and must remain untouched.
- Dependencies are already `hono`, `zod`, `chanfana`; no new package is needed.

**Airlock state (source of truth, local path `/Users/huynhduckhoan/Project/airlock`, commit `1f55991394cdd08fd5cb56405c753104d43b414c`).**
- `packages/canonical`: canonical request/response IR, normalizers for OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini, client encoders for all four protocols, SSE stream reassembly, stream error encoders.
- `packages/protocols`: strict inbound Zod schemas.
- `packages/providers`: OpenAI (chat + Responses modes), Anthropic Messages, Gemini native transport adapters over the canonical IR.
- `packages/request-shaping`: header/auth application plus `buildRequestUrl`.
- MIT licensed; designed to be vendored.

**End state.**
- Vendored Airlock code under `src/airlock/`.
- A thin `src/providers/protocol-conversion.ts` glue provider used only when conversion is required.
- Route selection accepts any text-capable channel type for any text route, subject to model mapping and endpoint validity.
- New `gemini-native` channel type for real Gemini `generateContent` upstreams.
- The manual `claude-to-openai-proxy.ts` is deleted; `claude-to-openai` becomes an OpenAI-chat channel alias.
- Audio route unchanged.

## Approach

### 1. Vendor Airlock modules verbatim

Create `src/airlock/` and copy only the runtime modules needed by the conversion path:

- `src/airlock/protocols/`: `index.ts`, `openai-chat.ts`, `anthropic-messages.ts`, `gemini.ts`, `responses.ts`, `airlock-extensions.ts`
- `src/airlock/canonical/`: `index.ts`, `models.ts`, `openai-chat.ts`, `stream-reassembly.ts`, `stream-error.ts`
- `src/airlock/providers/`: `types.ts`, `sse-buffer.ts`, `openai-adapter.ts`, `anthropic-adapter.ts`, `gemini-adapter.ts`
- `src/airlock/request-shaping/`: `index.ts`, `shaping.ts`
- `src/airlock/shared/`: `errors.ts`, `providers.ts`

Do NOT copy `capabilities.ts`, `adapter-registry.ts`, governance/telemetry/env code, or Airlock gateway routes. Rewrite `src/airlock/canonical/index.ts` to export only the four copied modules (drop `./capabilities.js`).

**Import rewrite (mechanical, no logic edits):**
- `@airlock/protocols` -> `../protocols/index` (from `canonical/`), or `../../protocols/index` as required by depth
- `@airlock/canonical` -> `../canonical/index` (from `providers/`)
- `@airlock/request-shaping` -> `../request-shaping/index`
- `@airlock/shared` -> `../shared/errors` for `GatewayError`; `../shared/providers` for `ProviderId`
- strip every `.js` suffix from relative imports

Keep Airlock naming, formatting, and behavior otherwise unchanged. This code is the conversion engine; do not reimplement it.

### 2. Add provider auth override to vendored OpenAI adapter

Azure needs `api-key`, Gemini-compatible and OpenAI need `Authorization: Bearer`. Airlock hardcodes bearer auth in four places in `src/airlock/providers/openai-adapter.ts` (search `const authStrategy: OutboundAuthStrategy`, currently at lines 945, 1179, 1610, 1933).

Add:
```ts
export interface OpenAIProviderAdapterAuth {
  type: "header_bearer" | "header_value";
  headerName: string;
}
```
to `OpenAIProviderAdapterOptions` (`auth?: OpenAIProviderAdapterAuth`), store it as a private field defaulting to `{ type: "header_bearer", headerName: "authorization" }`, and replace each of the four literals with a helper that returns:
```ts
{ type: this.#auth.type, headerName: this.#auth.headerName, credential: { secretRef: "openai-api-key" } }
```
No other vendor edits.

### 3. Add the protocol registry and upstream base resolver

New `src/providers/shared/protocol-registry.ts`.

```ts
export type UpstreamProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"

export type ChannelProtocolDescriptor = {
  protocol: UpstreamProtocol
  provider: "openai" | "anthropic" | "gemini"
  requestMode?: "openai_chat" | "openai_responses"
  auth?: OpenAIProviderAdapterAuth
}
```
Descriptor table, keyed by `ChannelType`:
| type | protocol | provider | requestMode | auth |
|---|---|---|---|---|
| `openai` | `openai-chat` | `openai` | `openai_chat` | bearer default |
| `claude-to-openai` | `openai-chat` | `openai` | `openai_chat` | bearer default |
| `gemini` | `openai-chat` | `openai` | `openai_chat` | bearer default |
| `azure-openai` | `openai-chat` | `openai` | `openai_chat` | `{ header_value, "api-key" }` |
| `openai-responses` | `openai-responses` | `openai` | `openai_responses` | bearer default |
| `azure-openai-responses` | `openai-responses` | `openai` | `openai_responses` | `{ header_value, "api-key" }` |
| `claude` | `anthropic-messages` | `anthropic` | - | adapter-internal |
| `gemini-native` | `gemini-generate-content` | `gemini` | - | adapter-internal |

Audio types have no descriptor and stay direct-only.

Also export:
- `getRouteProtocol(routeId)`: chat -> `openai-chat`, messages -> `anthropic-messages`, responses -> `openai-responses`, audio -> `null`.
- `getChannelProtocolDescriptor(type)`.
- `DIRECT_CHANNEL_TYPES`: every table type that has a direct proxy (`openai`, `claude-to-openai`, `gemini`, `azure-openai`, `openai-responses`, `azure-openai-responses`, `claude`) plus `openai-audio` and `azure-openai-audio`. Exclude `gemini-native`: it has no matching client endpoint to proxy.
- `resolveUpstreamBase(config)` returning `{ baseUrl, query }`:
  - `gemini-native`: `new URL(endpoint)`; trim trailing slash; if pathname does not end in `/v1beta` or `/v1`, append `/v1beta`; return origin + path, no query.
  - `azure-openai-responses`: `buildAzureTargetUrlFromPath(endpoint, "/v1/responses")`, strip trailing `/responses`; clear search into `query`.
  - `azure-openai` (audio is direct-only, never converted): `buildAzureTargetUrlFromPath(endpoint, "/v1/chat/completions")`, strip trailing `/chat/completions`; clear search into `query`.
  - `openai-responses`: `buildPrefixedTargetUrl(endpoint, "/v1/responses")`, strip trailing `/responses`.
  - `claude`: `buildPrefixedTargetUrl(endpoint, "/v1/messages")`, strip trailing `/messages`.
  - `openai` / `gemini` / `claude-to-openai`: `buildPrefixedTargetUrl(endpoint, "/v1/chat/completions", "/v1", type)`, strip trailing `/chat/completions`.
  - Strip trailing slash from `baseUrl`; preserve endpoint query only in `query`. Endpoint ending in `#` is rejected earlier for conversion, so no branch needed.
- `getUpstreamHeaderAllowlist(protocol)`: OpenAI chat/responses -> `OPENAI_COMPAT_UPSTREAM_HEADER_ALLOWLIST`, Anthropic -> `CLAUDE_UPSTREAM_HEADER_ALLOWLIST`, Gemini -> new `GEMINI_UPSTREAM_HEADER_ALLOWLIST` (`accept`, `content-type`) in `upstream-request-headers.ts`.

**Why reuse the URL builders:** they already encode the repo's Azure `#` / trailing-slash / `openai/v1` semantics and Gemini-compatible `v1beta/openai` normalization. Stripping the final path segment yields the exact base the chosen Airlock adapter must append to.

### 4. Rewrite route policy around protocols

`src/providers/shared/route-policy.ts` keeps `RouteId` and `resolveRouteId`; delete `ROUTE_POLICIES` / `getRoutePolicy`.

Add:
```ts
export const isChannelAllowedForRoute = (
  routeId: RouteId,
  config: Pick<ChannelConfig, "type" | "endpoint">,
): boolean
```
Rules:
- `audio-speech`: only `openai-audio`, `azure-openai-audio`.
- Text routes: descriptor must exist.
- Endpoint ending in `#`: allowed only when descriptor protocol equals route protocol AND the type has a direct provider (i.e. not `gemini-native`).
- Otherwise any descriptor type is allowed for any text route; conversion provider decides how.

`channel-resolver.ts` line ~77 replaces `getRoutePolicy(routeId)` / `allowedTypes` with `isChannelAllowedForRoute(routeId, config)` inside the loop. Keep all quota, key rotation, mapping, and random/weighted selection behavior unchanged.

### 5. Add the conversion provider

New `src/providers/protocol-conversion.ts`, implementing the existing `ProviderFetch` shape with an added trailing `routeId` parameter.

Flow per request:
1. `descriptor = getChannelProtocolDescriptor(config.type)`, `upstreamProtocol = descriptor.protocol`.
2. `clientProtocol = getRouteProtocol(routeId)`; if missing or equal to upstream, delegate to nothing (should not be called; return 500 guard).
3. Parse and normalize the client body:
   - chat: `openAIChatCompletionRequestSchema.parse` -> `normalizeOpenAIChatRequest`
   - messages: `anthropicMessagesRequestSchema.parse` -> `normalizeAnthropicMessagesRequest`
   - responses: `openAIResponsesRequestSchema.parse` -> `normalizeOpenAIResponsesRequest`
   - Any Zod/other parse error -> `GatewayError` 400, code `request_invalid_payload`, message `Invalid <protocol> request payload`.
4. `assertConversionSupported(canonical, upstreamProtocol)` -> 400 when conversion would silently corrupt semantics:
   - responses-native failure passthrough (`nativeRequest.openaiResponses`) when upstream is not Responses.
   - Anthropic-native-only body (`nativeRequest.anthropicMessages`) when upstream is not Anthropic.
   - `previousResponseId`, `conversationId`, `prompt`, `reasoningSummary`, `responseTruncation`, `responseTextVerbosity`, or OpenAI Responses logprob/include controls set when upstream is not Responses.
   - Responses-native non-function tools (`web_search`, `image_generation`, `custom`) are already captured as native request data and are covered by the native-response check above; reject them for non-Responses upstreams.
   Use route-specific 400 body shapes (below).
5. `base = resolveUpstreamBase(config)`, `apiKey = config.api_key || ""`.
6. Build adapter:
   - `openai`: `new OpenAIProviderAdapter({ apiKey, baseUrl: base.baseUrl, auth: descriptor.auth })`
   - `anthropic`: `new AnthropicProviderAdapter({ apiKey, baseUrl: base.baseUrl, defaultMaxTokens: 4096 })`
   - `gemini`: `new GeminiProviderAdapter({ apiKey, baseUrl: base.baseUrl })`
7. Context:
   - `requestId: crypto.randomUUID()`
   - `signal: c.req.raw.signal`
   - `requestMode: descriptor.requestMode`
   - `forwardedHeaders`: `buildUpstreamRequestHeaders(c.req.raw, { allowHeaders: getUpstreamHeaderAllowlist(upstreamProtocol) })` lowercased into a plain record
   - `forwardedQuery`: `base.query`
8. Non-stream (`canonical.stream === false`):
   - `response = await adapter.complete(canonical, context)`; set `trackingState.upstreamStatus = 200`.
   - Save usage through the existing `saveUsage` callback (catch/log save errors; do not fail the response).
   - Encode per client route:
     - chat -> `encodeCanonicalToOpenAIChatResponse` -> `c.json`
     - messages -> `encodeCanonicalToAnthropicMessagesResponse` -> `c.json`
     - responses -> `encodeCanonicalToOpenAIResponsesResponse` -> `c.json`
9. Stream:
   - `iterator = createStreamReassemblyIterable(adapter.stream(canonical, context), fallbackId, canonical.model)[Symbol.asyncIterator]()`.
   - `await iterator.next()` BEFORE returning a Response. On throw -> route-specific error JSON with `GatewayError.httpStatus` (or 502) and set `trackingState.upstreamStatus`. `first.done` -> 502 `provider_upstream_error` (`Upstream provider returned an empty stream`).
   - Set `trackingState.upstreamStatus = 200`; return `new Response(ReadableStream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } })`.
   - Persistent encoder states MUST be created once, outside the loop, and passed on every call (Airlock's default parameters reset state):
     - Anthropic: `{ startedTextBlock: false, startedToolBlocks: [], pendingToolStops: [] }`
     - Gemini: `{ toolCalls: new Map() }`
     - Responses: copy the state object built in `airlock/apps/gateway/src/routes/responses.ts` around lines 195-420 (`sequenceNumber`, `outputIndex`, `startedTextOutput`, `startedReasoningOutput`, `startedToolCallIds`, `streamedToolCalls`, accumulated text/reasoning, `parallelToolCalls`).
   - Per event:
     - completed event with usage -> `saveUsage(toRepoUsage(upstreamProtocol, usage))`, set `usageSaved`.
     - track accumulated text and tool-call argument text for fallback estimation.
     - chat: `data: ${JSON.stringify(encodeCanonicalToOpenAIChatStreamChunk(event, streamId, includeUsage))}\n\n`; `includeUsage = canonical.providerMetadata?.openai?.chatIncludeUsage === true`.
     - messages: for each encoded event emit `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`.
     - responses: copy Airlock's loop including `response_started`/`response_completed` accumulators; emit `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` for every event (Airlock omits the `event:` line, but emitting both is safer and matches existing direct proxy behavior).
     - gemini client is not exposed; no encoder needed.
   - Normal end: chat/responses append `data: [DONE]\n\n`; messages and none; gemini none.
   - Mid-stream throw: emit route-specific stream error using `encodeOpenAIChatStreamError` / `encodeOpenAIResponsesStreamError` / `encodeAnthropicMessagesStreamError`; Gemini uses `data: {"error":{"code","message"}}\n\n`. Do not throw after headers are sent.
   - If no usage was saved and any output text/tool arguments were produced, save `estimateUsageFromBodies(requestBody, undefined, accumulatedText)`; output may be `""` (guard `sawOutput`). Existing `saveUsage` dedupes, but keep `usageSaved` to avoid repeated writes.
   - `cancel()` calls `iterator.return?.()`.
10. Route-specific error JSON:
   - chat: `{ error: { message, type: upstreamErrorCode ?? mappedType, code: error.code } }`
   - messages: `{ type: "error", error: { type: upstreamErrorCode ?? mappedType, message } }`
   - responses: `{ error: { message, type: mappedType, code } }`
   - `mappedType`: 400 -> `invalid_request_error`, 401 -> `authentication_error`, 403 -> `permission_error`, 404 -> `not_found_error`, 429 -> `rate_limit_error`, otherwise `server_error` / `api_error`.
   - Status: `GatewayError.httpStatus`, else 502 (retryable by `RETRYABLE_STATUS_CODES`).
11. `toRepoUsage(protocol, usage)`:
   - always `prompt_tokens = inputTokens`, `completion_tokens = outputTokens`, `total_tokens = totalTokens`.
   - include `cached_tokens = cachedInputTokens` for non-Anthropic protocols when defined. Anthropic keeps existing semantics (prompt excludes cache reads, no `cached_tokens`), so billing behavior is unchanged for Claude channels.
   - `saveUsage` failures log via `console.warn`, never replace the model response.

### 6. Switch dispatch

- `src/providers/shared/provider-registry.ts`:
  - add `routeId: RouteId` as the last parameter of `ProviderFetch`.
  - keep direct map for all existing direct types, mapping `claude-to-openai` to `openaiProxy.fetch` (same wire protocol).
  - `getProvider(routeId, type)`:
    - audio route: return direct audio provider only.
    - text route with descriptor and `descriptor.protocol !== getRouteProtocol(routeId)`: return `protocolConversionFetch`.
    - same protocol: return the direct provider.
    - unknown type: `undefined`.
- `src/providers/shared/upstream-retry.ts`: thread `routeId` through `executeWithFallbackChannels` -> `executeChannelWithRetries` -> `provider(...)`; append it as the last argument so direct providers ignore it.
- `src/providers/index.ts`: pass `routeId` in the `executeWithFallbackChannels` call.
- Delete `src/providers/claude-to-openai-proxy.ts` and its import. `claude-to-openai` remains a valid channel type for compatibility.

### 7. Add `gemini-native`

- `type.d.ts` `ChannelType` union: add `"gemini-native"`.
- Frontend `ChannelConfig.type` union in `frontend/src/types/index.ts`: add `"gemini-native"`.
- `frontend/src/pages/Channels.tsx`:
  - add `{ value: "gemini-native", label: "Gemini Native" }` to `channelTypes`.
  - placeholder `https://generativelanguage.googleapis.com/`.
  - dedicated endpoint preview (`buildGeminiNativeEndpointPreview`): normalize base path to end in `/v1beta` (accept existing `/v1beta` or `/v1`), append `/models/{model}:generateContent`, show literal `{model}` by decoding `%7Bmodel%7D` if needed. Do not reuse the OpenAI-compatible Gemini builder.
- No backend admin-schema change is needed; channel configs are free-form JSON.
- `claude-to-openai` label stays "Claude via OpenAI"; conversion is now automatic in both directions, so no UI toggle.

### 8. Tests

**New `tests/protocol-conversion.test.ts`** (`bun:test`, mirrors `tests/chat-stream-usage.test.ts` style; `spyOn(globalThis, "fetch")`; restore in `finally`). Call `getProvider(routeId, type)` directly with a real Hono `Context` and a fake `saveUsage` collector. Cases:
1. messages -> openai, non-stream: upstream URL ends `/v1/chat/completions`; body has chat `messages`; response is Anthropic `type:"message"`, text `hi`, `stop_reason:"end_turn"`; usage saved exactly `{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }`.
2. messages -> openai, stream: OpenAI SSE with usage summary; output SSE contains `event: message_start`, `event: content_block_delta`, `event: message_stop`; saveUsage called once.
3. chat -> claude, non-stream: URL `/v1/messages`, header `x-api-key: k`, response has OpenAI `choices[0].message.content`.
4. chat -> azure-openai, non-stream: URL `https://r.openai.azure.com/openai/v1/chat/completions`, header `api-key: k` (proves auth override).
5. chat -> gemini-native, non-stream: URL ends `/v1beta/models/gemini-2.0-flash:generateContent`; native response is encoded to OpenAI chat.
6. responses -> openai chat, non-stream: `input:"hi"` becomes chat messages; response is a Responses object with `output_text`.
7. responses -> chat with `previous_response_id`: 400 before any `fetch` call.
8. responses with native `web_search` tool -> chat: 400 before `fetch`.
9. route policy: messages allows `openai` with a normal endpoint; audio rejects `openai`; messages allows `claude` on endpoint ending `#`; chat rejects `claude` on endpoint ending `#`; chat rejects `gemini-native` on endpoint ending `#` (same protocol but no direct provider).
10. messages input with an image block -> openai: 400 `Invalid anthropic-messages request payload`; assert `fetch` was not called. (The vendored Anthropic schema has no `image` block; the old manual converter also dropped images. Direct `/v1/messages` -> `claude` still passes images through untouched.)

Run this file first: `bun test tests/protocol-conversion.test.ts`.

**E2E harness updates:**
- `tests/mock-upstream.ts`: add `"gemini-native"` to `INSPECTABLE_REQUEST_KEYS`; `getCaptureKey` matches `:generateContent` / `:streamGenerateContent`; derive model from `/models/<id>:`; return native Gemini JSON `{ responseId, modelVersion, candidates:[{ content:{role:"model",parts:[{text:"Mock Gemini native"}]}, finishReason:"STOP", index:0 }], usageMetadata:{ promptTokenCount:7, candidatesTokenCount:3, totalTokenCount:10 } }`; stream variant emits `data: <json>\n\n` frames.
- `tests/setup-test-data.sh`: add `test-gemini-native` channel (`type:"gemini-native"`, endpoint `$MOCK`, `deployment_mapper: {"gemini-native-model":"gemini-2.0-flash"}`); add it to `sk-mock-all` `channel_keys`.
- `tests/run-e2e.sh`:
  - change the existing "non-responses model -> 400" case to model `does-not-exist` (gpt-4o is now convertible).
  - add cross-protocol assertions: messages+gpt-4o non-stream contains `Mock response from`; chat+claude-3-opus contains `Mock Claude response`; responses+claude-3-opus contains `Mock Claude response`; chat+gpt-4o-resp contains `Mock responses output`; chat+gemini-native-model contains `Mock Gemini native`; messages+gpt-4o stream contains `event: message_start`; responses+gpt-4o stream contains `event: response.output_text.delta`.
  - after the Gemini call, inspect `gemini-native` capture: request path contains `/models/gemini-2.0-flash:generateContent`, header `"x-goog-api-key":"mock-key"`, body has `contents`.
  - cleanup loop includes `test-gemini-native`.
- Existing direct-proxy, header-whitelist, quota, auth, and admin assertions remain unchanged.

**Local E2E prerequisites (gitignored; create only if absent):**
`wrangler.local.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "one-api-workers-local",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-28",
  "vars": { "USAGE_ANALYTICS_DATASET": "usage_events_by_token" },
  "assets": {
    "directory": "./public",
    "not_found_handling": "single-page-application",
    "binding": "ASSETS",
    "run_worker_first": true
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "one-api",
    "database_id": "c3f1dd47-482e-4609-b22d-3e58d33024b6"
  }],
  "analytics_engine_datasets": [{ "binding": "USAGE_ANALYTICS", "dataset": "usage_events_by_token" }]
}
```
`.dev.vars` (if absent): `ADMIN_TOKEN=test-admin-token`, `CF_API_TOKEN=test`, `CF_ACCOUNT_ID=test`.

Run:
1. `bun run tests/mock-upstream.ts` (background)
2. `bun run dev:worker` (background, port 8787)
3. `bash tests/setup-test-data.sh`
4. `bash tests/run-e2e.sh`

## Critical files

- `src/providers/protocol-conversion.ts` (new) — canonical normalization, compatibility guard, adapter construction, streaming encoder loops, usage mapping.
- `src/providers/shared/protocol-registry.ts` (new) — protocol matrix and exact upstream base resolution; correctness here determines every converted URL.
- `src/providers/shared/upstream-retry.ts:140-200,264-330` — add `routeId` to `ProviderFetch` calls without changing retry/fallback semantics.
- `src/providers/shared/route-policy.ts:1-35` — replace allowlists with protocol compatibility; audio remains closed.
- `src/airlock/providers/openai-adapter.ts:911-930,945,1179,1610,1933` — auth override for Azure; only vendor logic change.

## Verification

1. `bun test tests/protocol-conversion.test.ts` — all new conversion cases pass.
2. `bun run build` — Worker strict typecheck plus frontend build; catches vendored import/type errors and the new channel type.
3. `cd frontend && bun run lint`.
4. `bun test tests` — no regression in stream estimation, D1, admin auth, or migration tests.
5. E2E sequence above — direct routes still pass; cross-protocol matrix returns the expected bodies and SSE; Gemini native URL/auth assertion passes; negative conversion guards return 400.
6. Manual proof:
   - `curl -s http://localhost:8787/v1/messages -H 'x-api-key: sk-mock-all' -H 'content-type: application/json' -d '{"model":"gpt-4o","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'` -> Anthropic-shaped `type:"message"` with `Mock response`.
   - `curl -N ... /v1/chat/completions` with `{"model":"claude-3-opus","stream":true,...}` -> OpenAI `data:` chunks ending `[DONE]`.

## Assumptions & contingencies

- **Automatic conversion is the feature.** No per-channel opt-in flag; same-protocol requests still take the existing direct path, so production fidelity and latency are unchanged.
- **`gemini-native` means real Gemini API**, not its OpenAI-compatible endpoint. Endpoint is a base URL; `/v1beta` is appended only when absent.
- **Anthropic conversions default to 4096 output tokens** when the client chat/responses request has no max token setting. This matches Airlock's gateway default and avoids an invalid Anthropic request.
- **Stateful Responses fields are rejected** for non-Responses upstreams rather than silently dropped. Clients must use a Responses channel for `previous_response_id`, conversations, prompts, and Responses-only tools.
- **Cross-protocol conversion is text/tool only.** Vendored schemas accept text content parts; OpenAI chat `image_url` parts and Anthropic `image`/`document` blocks are rejected with 400. The old manual converter also dropped images. Direct same-protocol channels are unaffected because they never enter normalization. Preserve native multimodal behavior on direct routes.
- **Streaming errors after the first event are in-band**, matching existing behavior; no fallback channel is attempted after bytes are sent.
- **Airlock vendor code is MIT**; keep the exact commit in this plan as provenance. No new dependency.
- If `wrangler.local.jsonc`/`.dev.vars` are missing, create them exactly as above. If `wrangler dev` still cannot start in this environment (platform/auth), report that E2E could not run and rely on steps 1-4; do not weaken the unit tests.
