# Per-channel upstream protocol support

## Context

Today the upstream protocol is fixed by `channel.type` through the static `CHANNEL_PROTOCOLS` map (`src/providers/shared/protocol-registry.ts`). Multi-standard upstreams (OpenAI-compatible gateways that also serve `/v1/responses`, `/v1/messages`, Gemini) are therefore always converted, and requests using Responses-only/Athropropic-native features fail with one vague 400: `This request relies on OpenAI Responses semantics that cannot be converted to the selected channel protocol` (`src/providers/protocol-conversion.ts:246`).

End state:
1. Each channel declares `protocols` (upstream protocols it serves natively — passthrough with no conversion) and `primary_protocol` (conversion target when the incoming route protocol is not in `protocols`).
2. A request that cannot be converted is retried on another channel that supports the incoming protocol natively; only when none exists does the gateway return an error.
3. That error names the exact unsupported request features, the channel (name + key + type), its protocols, and the conversion target, and sets the OpenAI `error.param` field.
4. Existing channels keep today's behavior: absent `protocols` ⇒ the type's current default protocol.

User decisions: allow all four protocols on every non-audio text channel (Azure limited to `openai-chat`/`openai-responses`); auto-fallback to a natively capable channel; expose channel name+key in the client-visible error.

## Approach

### Step 1 — Protocol model (`type.d.ts`, `src/providers/shared/protocol-registry.ts`)

In `type.d.ts` add above `type ChannelType`:

```ts
type ChannelProtocol =
    | "openai-chat"
    | "openai-responses"
    | "anthropic-messages"
    | "gemini-generate-content";
```

Add to `ChannelConfig` (after `supported_models`):

```ts
    protocols?: ChannelProtocol[];
    primary_protocol?: ChannelProtocol;
    /** Runtime-only identity injected by the retry layer; never persisted. */
    channel_key?: string;
```

Add to `RequestTrackingState`: `lastErrorCode?: string;`.

In `src/providers/shared/protocol-registry.ts`, replace `UpstreamProtocol`'s literal union with `export type UpstreamProtocol = ChannelProtocol`, and replace `CHANNEL_PROTOCOLS`/`getChannelProtocolDescriptor` with:

```ts
export type ChannelProtocolDescriptor = {
    protocol: UpstreamProtocol
    provider: "openai" | "anthropic" | "gemini"
    requestMode?: "openai_chat" | "openai_responses"
    auth?: OpenAIProviderAdapterAuth
}

export const TEXT_UPSTREAM_PROTOCOLS: UpstreamProtocol[] = [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "gemini-generate-content",
]

export const DEFAULT_CHANNEL_PROTOCOLS: Record<string, UpstreamProtocol[]> = {
    "openai": ["openai-chat"],
    "openai-responses": ["openai-responses"],
    "claude": ["anthropic-messages"],
    "gemini-native": ["gemini-generate-content"],
    "azure-openai": ["openai-chat"],
    "azure-openai-responses": ["openai-responses"],
}

const AZURE_TEXT_PROTOCOLS: UpstreamProtocol[] = ["openai-chat", "openai-responses"]

const AZURE_AUTH: OpenAIProviderAdapterAuth = { type: "header_value", headerName: "api-key" }

const PROTOCOL_DESCRIPTORS: Record<UpstreamProtocol, ChannelProtocolDescriptor> = {
    "openai-chat": { protocol: "openai-chat", provider: "openai", requestMode: "openai_chat" },
    "openai-responses": { protocol: "openai-responses", provider: "openai", requestMode: "openai_responses" },
    "anthropic-messages": { protocol: "anthropic-messages", provider: "anthropic" },
    "gemini-generate-content": { protocol: "gemini-generate-content", provider: "gemini" },
}
```

New exports (all accept `config: Partial<ChannelConfig>` so existing test call sites that pass `{ type, endpoint }` stay valid):

- `isAzureChannelType(type)` — true for `azure-openai`, `azure-openai-responses`, `azure-openai-audio`.
- `getAllowedChannelProtocols(type)` — `[]` when `type` is missing, audio, or not in `DEFAULT_CHANNEL_PROTOCOLS`; `AZURE_TEXT_PROTOCOLS` for the two Azure text types; `TEXT_UPSTREAM_PROTOCOLS` otherwise.
- `resolveChannelProtocols(config): UpstreamProtocol[]` — allowed set; declared `config.protocols` filtered to allowed, deduped, then ordered as in `TEXT_UPSTREAM_PROTOCOLS`; when no declared protocol survives, return `DEFAULT_CHANNEL_PROTOCOLS[type]` filtered to allowed; `[]` when the type has no allowed protocols.
- `resolvePrimaryProtocol(config): UpstreamProtocol | null` — `null` when supported is empty; declared `primary_protocol` if supported; else first supported entry of `DEFAULT_CHANNEL_PROTOCOLS[type]`; else `supported[0]`.
- `channelSupportsProtocol(config, protocol): boolean` — `resolveChannelProtocols(config).includes(protocol)`.
- `resolveProtocolDescriptor(config, protocol): ChannelProtocolDescriptor` — `PROTOCOL_DESCRIPTORS[protocol]`, plus `auth: AZURE_AUTH` when `isAzureChannelType(config.type)`. (Azure auth is `api-key` for all Azure protocols.)
- `resolveUpstreamBase(config, protocol): { baseUrl, query }` — second argument becomes required:
  1. `protocol === "gemini-generate-content"` → existing Gemini branch (`normalizeGeminiNativeBaseUrl` + query copy).
  2. `isAzureChannelType(config.type)` → `buildAzureTargetUrlFromPath` with `/v1/responses` (responses) or `/v1/chat/completions` (chat), then `buildBaseResult(..., "/responses" | "/chat/completions")`.
  3. otherwise `requestPath` = `/v1/responses` | `/v1/messages` | `/v1/chat/completions` by protocol, `buildBaseResult(buildPrefixedTargetUrl(endpoint, requestPath), trailingSegment)` where trailingSegment is `/responses`, `/messages`, or `/chat/completions`.

Delete `getChannelProtocolDescriptor` and the `CHANNEL_PROTOCOLS` map. Every callsite is migrated in Steps 2–4; verify with `grep -rn "getChannelProtocolDescriptor" src tests` returning nothing.

`getRouteProtocol`/`ROUTE_PROTOCOLS` and `getUpstreamHeaderAllowlist` are unchanged.

### Step 2 — Backend dispatch uses the channel's protocols

**`src/providers/shared/route-policy.ts`** — `isChannelAllowedForRoute(routeId, config: Partial<ChannelConfig>)`: audio route keeps `isAudioChannelType(config.type)`; every text route returns `resolveChannelProtocols(config).length > 0`. Drop the `getChannelProtocolDescriptor` import.

**`src/providers/shared/provider-registry.ts`** — signature becomes `getProvider(routeId: RouteId, config: Partial<ChannelConfig>)`:

```ts
if (routeId === "audio-speech") return passthroughProxy.fetch
const routeProtocol = getRouteProtocol(routeId)
if (!routeProtocol || resolveChannelProtocols(config).length === 0) return undefined
return channelSupportsProtocol(config, routeProtocol)
    ? passthroughProxy.fetch
    : protocolConversion.fetch
```

**`src/providers/passthrough-proxy.ts`** — replace `getChannelProtocolDescriptor(config.type)` with:

```ts
const upstreamProtocol = getRouteProtocol(routeId)          // null on audio-speech
const descriptor = upstreamProtocol
    ? resolveProtocolDescriptor(config, upstreamProtocol)
    : undefined
```

Nothing else changes: `buildTargetUrl` already derives the path from the incoming request (Azure/Gemini branches keyed by descriptor provider/type), `buildAuthHeaders` reads descriptor provider/auth, and usage checkout keys off `upstreamProtocol`. This is what makes `/v1/responses` on an `openai` channel with `protocols: ["openai-chat","openai-responses"]` a verbatim forward.

**`src/providers/protocol-conversion.ts`** — inside `fetch()`:

```ts
const targetProtocol = resolvePrimaryProtocol(config)
if (!targetProtocol) {
    trackingState.upstreamStatus = 500
    trackingState.errorSummary = "Channel has no upstream protocol available for conversion"
    return buildErrorResponse(routeId, createConversionNotRequiredError())
}
const descriptor = resolveProtocolDescriptor(config, targetProtocol)
```

(delete the old descriptor lookup; change `createConversionNotRequiredError`'s message to `"Channel has no upstream protocol available for conversion"`), then `assertConversionSupported(canonical, targetProtocol, config, resolveChannelProtocols(config))`, `resolveUpstreamBase(config, targetProtocol)`, `toRepoUsage(targetProtocol, ...)`, `buildForwardedHeaders(..., targetProtocol)`.

In the `catch` around `parseClientRequest` + `assertConversionSupported`, also set `trackingState.lastErrorCode = payloadError.code` before returning.

### Step 3 — Actionable conversion errors

In `src/providers/protocol-conversion.ts`:

1. Hoist the field table to module scope and make values lazy:

```ts
const OPENAI_RESPONSES_ONLY_FIELDS: Array<[string, (request: CanonicalRequest) => unknown]> = [
    ["previous_response_id", (request) => request.previousResponseId],
    ["conversation", (request) => request.conversationId],
    ["prompt", (request) => request.prompt],
    ["reasoning.summary", (request) => request.reasoningSummary],
    ["truncation", (request) => request.responseTruncation],
    ["text.verbosity", (request) => request.responseTextVerbosity],
    ["include", (request) => request.providerMetadata?.openai?.responsesOutputTextLogprobs],
    ["top_logprobs", (request) => request.providerMetadata?.openai?.responsesTopLogprobs],
]
```

2. Add helpers:

```ts
const collectNativeResponsesReasons = (native: NonNullable<NonNullable<CanonicalRequest["nativeRequest"]>["openaiResponses"]>): string[] => {
    const reasons: string[] = []
    const toolTypes = [...new Set((native.tools ?? []).map((tool) => (tool as { type?: unknown })?.type).filter((type): type is string => typeof type === "string"))]
    if (toolTypes.length > 0) reasons.push(`tools: ${toolTypes.join(", ")}`)
    const inputTypes = new Set<string>()
    if (Array.isArray(native.input)) {
        for (const item of native.input) {
            const record = item as { type?: unknown; content?: unknown } | null
            const itemType = typeof record?.type === "string" ? record.type : undefined
            if (itemType && itemType !== "message") inputTypes.add(itemType)
            if (Array.isArray(record?.content)) {
                for (const block of record.content) {
                    const blockType = (block as { type?: unknown })?.type
                    if (typeof blockType === "string" && blockType !== "input_text" && blockType !== "output_text") inputTypes.add(blockType)
                }
            }
        }
    }
    if (inputTypes.size > 0) reasons.push(`input: ${[...inputTypes].slice(0, 6).join(", ")}`)
    if (native.include?.includes("reasoning.encrypted_content")) reasons.push("include: reasoning.encrypted_content")
    if (reasons.length === 0) reasons.push("native Responses payload")
    return reasons
}

const describeChannelForError = (config: ChannelConfig): string => {
    const name = config.name || "unnamed"
    const type = config.type || "unknown"
    return config.channel_key
        ? `Channel "${name}" (key: ${config.channel_key}, type: ${type})`
        : `Channel "${name}" (type: ${type})`
}
```

3. Replace `assertConversionSupported` with `(canonical, targetProtocol, config, supportedProtocols)`:

- Return immediately when `targetProtocol === "openai-responses"` (unchanged exemption).
- `fieldReasons` = every entry of `OPENAI_RESPONSES_ONLY_FIELDS` whose getter returns non-`undefined`, as field names; `param` = `fieldReasons[0]`.
- `nativeResponses` = `canonical.nativeRequest?.openaiResponses`; when present, prepend `collectNativeResponsesReasons(nativeResponses)` reasons and semantics `"OpenAI Responses"`.
- When `targetProtocol !== "anthropic-messages"` and `canonical.nativeRequest?.anthropicMessages` exists, use semantics `"Anthropic Messages"` with reason `"native Anthropic Messages content blocks"`.
- If no reasons, return.
- Message (exact template):

```ts
`This request uses ${semantics} semantics that cannot be converted to "${targetProtocol}". Unsupported features: ${reasons.join(", ")}. ${describeChannelForError(config)} supports: ${supportedProtocols.join(", ")}; conversion target: "${targetProtocol}". Enable ${semantics} for this channel, or route this model to a channel that supports it.`
```

- Error code: `request_unsupported_openai_semantics` for Responses semantics, `request_unsupported_anthropic_semantics` for Anthropic semantics. Both via `createUnsupportedSemanticsError(message, code, param)`; pass `param` into `GatewayError` options.

4. `src/airlock/shared/errors.ts`: add `param?: string` to `GatewayErrorOptions` and `readonly param: string | undefined` set from it.

5. `buildErrorPayload(routeId, error, message)` gains `param` from `error instanceof GatewayError ? error.param : undefined`, and spreads it into the OpenAI-shaped payloads only:

```ts
if (routeId === "responses") return { error: { message, type: mappedType, code, ...(param ? { param } : {}) } }
// chat-completions default branch
return { error: { message, type: upstreamErrorCode ?? mappedType, code, ...(param ? { param } : {}) } }
```

Anthropic (`messages`) and Gemini payloads stay untouched.

### Step 4 — Fallback to a protocol-capable channel

**`src/providers/shared/upstream-retry.ts`**:

1. Inside `executeChannelWithRetries`, immediately before `const response = await provider(...)`: `trackingState.lastErrorCode = undefined`.
2. After the provider call and before `if (response.ok)`:

```ts
const conversionErrorCode = trackingState.lastErrorCode
if (!response.ok && conversionErrorCode?.startsWith("request_unsupported_")) {
    return {
        response,
        shouldFallback: true,
        errorCode: conversionErrorCode,
        errorSummary: trackingState.errorSummary,
    }
}
```

This skips key retries and channel cooldown: the request, not the channel, is unsupported.

3. `pickNextFallbackChannel` gains `requireProtocol: UpstreamProtocol | null = null` and filters `remainingChannels` with `channelSupportsProtocol(channel.config, requireProtocol)` when set; returns `null` when the filtered pool is empty.
4. In `executeWithFallbackChannels`, compute `const routeProtocol = getRouteProtocol(routeId)` once, and change the fallback selection to:

```ts
const requiredProtocol = execution.errorCode.startsWith("request_unsupported_") ? routeProtocol : null
const nextChannel = execution.shouldFallback && fallbackCount < routing.maxFallbacks
    ? pickNextFallbackChannel(channels, attemptedChannelKeys, routing, requiredProtocol)
    : null
```

5. `executeWithFallbackChannels`'s provider lookup becomes `getProvider(routeId, currentChannel.config)`.
6. In `executeChannelWithRetries`, set `channel_key` on the runtime config so conversion errors can name the channel:

```ts
const runtimeConfig: ChannelConfig = {
    ...config,
    channel_key: channel.key,
    api_key: currentKey,
    api_keys: [currentKey],
}
```

No capability-based reordering in `resolveChannel`; the existing priority/weighted/round-robin strategy still picks the first channel, and the fallback rescues conversion failures. This keeps load balancing intact.

### Step 5 — Persist and validate channel protocols

**`src/channel-config.ts`**:

- `NormalizedChannelConfig` adds `protocols: ChannelProtocol[]; primary_protocol: ChannelProtocol | null;` (also list them in the `Omit<...>` clause).
- `normalizeChannelConfig` sets `protocols: resolveChannelProtocols(config)` and `primary_protocol: resolvePrimaryProtocol(config)` (import both from `./providers/shared/protocol-registry`; no import cycle exists).
- `sanitizeChannelConfig` returns `protocols: normalized.protocols` and `...(normalized.primary_protocol ? { primary_protocol: normalized.primary_protocol } : {})`.

**`src/constants.ts`**: `DB_VERSION: "v0.0.7"` (from `v0.0.6`). `db.migrate()` already re-sanitizes and rewrites every `channel_config` row when the version differs, materializing `protocols`/`primary_protocol`.

**`src/admin/channel_api.ts`**:

- Add `const CHANNEL_PROTOCOL_SCHEMA = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate-content"]);`
- Add to both the `ChannelUpsertEndpoint` body schema and the `ChannelFetchModelsEndpoint` body schema:
  `protocols: z.array(CHANNEL_PROTOCOL_SCHEMA).optional()`, `primary_protocol: CHANNEL_PROTOCOL_SCHEMA.optional()`.
- In `ChannelUpsertEndpoint.handle`, validate the raw body before `sanitizeChannelConfig`:

```ts
const requestedProtocols = Array.isArray(rawConfig.protocols) ? rawConfig.protocols : []
const allowedProtocols = getAllowedChannelProtocols(rawConfig.type)
const invalidProtocol = requestedProtocols.find((protocol) => !allowedProtocols.includes(protocol))
if (invalidProtocol) {
    return c.text(`Protocol not supported for channel type ${rawConfig.type ?? "unknown"}: ${invalidProtocol}`, 400)
}
if (rawConfig.primary_protocol && requestedProtocols.length > 0 && !requestedProtocols.includes(rawConfig.primary_protocol)) {
    return c.text("primary_protocol must be included in protocols", 400)
}
```

### Step 6 — Admin UI

**`frontend/src/types/index.ts`** — add `export type ChannelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate-content'`, change `ChannelConfig.type` to include the same union as today, and add `protocols?: ChannelProtocol[]; primary_protocol?: ChannelProtocol`.

**`frontend/src/api/client.ts`** — in `responseInterceptor`, replace the error extraction branch so object-shaped proxy errors keep their message (400 responses are not rewritten by the status switch):

```ts
const nestedError = errorData?.error
if (typeof errorData?.message === 'string') {
  errorMessage = errorData.message
} else if (typeof nestedError === 'string') {
  errorMessage = nestedError
} else if (nestedError && typeof nestedError === 'object' && typeof nestedError.message === 'string') {
  const code = typeof nestedError.code === 'string' ? ` [${nestedError.code}]` : ''
  const param = typeof nestedError.param === 'string' ? ` (param: ${nestedError.param})` : ''
  errorMessage = `${nestedError.message}${code}${param}`
} else {
  errorMessage = JSON.stringify(errorData)
}
```

**`frontend/src/pages/Channels.tsx`**:

- Constants near `channelTypes`:

```ts
const channelProtocolOptions: Array<{ value: ChannelProtocol; labelKey: string }> = [
  { value: "openai-chat", labelKey: "channels.protocolOpenAIChat" },
  { value: "openai-responses", labelKey: "channels.protocolOpenAIResponses" },
  { value: "anthropic-messages", labelKey: "channels.protocolAnthropicMessages" },
  { value: "gemini-generate-content", labelKey: "channels.protocolGemini" },
];
const defaultChannelProtocols: Record<string, ChannelProtocol[]> = {
  openai: ["openai-chat"],
  "openai-responses": ["openai-responses"],
  claude: ["anthropic-messages"],
  "gemini-native": ["gemini-generate-content"],
  "azure-openai": ["openai-chat"],
  "azure-openai-responses": ["openai-responses"],
};
const getAllowedProtocols = (type: string | undefined): ChannelProtocol[] => {
  if (!type || type === "openai-audio" || type === "azure-openai-audio") return [];
  if (type === "azure-openai" || type === "azure-openai-responses") return ["openai-chat", "openai-responses"];
  return channelProtocolOptions.map((option) => option.value);
};
const isAudioChannelType = (type: string | undefined): boolean =>
  type === "openai-audio" || type === "azure-openai-audio";
```

- `createDefaultChannelFormData()` adds `protocols: ["openai-chat"]`, `primary_protocol: "openai-chat"`.
- Type `Select` `onChange`: set type plus `protocols: defaultChannelProtocols[value] ?? []`, `primary_protocol: defaultChannelProtocols[value]?.[0]`.
- `normalizeChannelFormConfig` normalizes protocol fields (keeps save/toggle/duplicate paths consistent):

```ts
const allowedProtocols = getAllowedProtocols(config.type);
const declaredProtocols = Array.isArray(config.protocols)
  ? config.protocols.filter((protocol) => allowedProtocols.includes(protocol))
  : [];
const protocols = declaredProtocols.length > 0
  ? declaredProtocols
  : (defaultChannelProtocols[config.type] ?? []).filter((protocol) => allowedProtocols.includes(protocol));
const primary_protocol = config.primary_protocol && protocols.includes(config.primary_protocol)
  ? config.primary_protocol
  : protocols[0];
```

and include `protocols`, `primary_protocol` in the returned object.

- New `<Card>` after the Basic Info card, rendered only when `getAllowedProtocols(formData.type).length > 0`; heading `t("channels.protocolSupport")`, hint `t("channels.protocolSupportHint")`. Content: one checkbox row per `channelProtocolOptions` filtered by allowed protocols (checked = `formData.protocols?.includes(value)`), plus a `Select` labelled `t("channels.primaryProtocol")` with hint `t("channels.primaryProtocolHint")`, options = checked protocols only.
  - Unchecking the last checked protocol: block the change and `addToast(t("channels.protocolRequired"), "error")`.
  - Unchecking the primary: set `primary_protocol` to the first remaining checked protocol.
  - Checking a protocol when none was checked (defensive): leave primary untouched (normalization fixes it).
- Endpoint preview: replace `getChannelRequestPreviewPath(type)` with `getProtocolRequestPreviewPath(protocol?: ChannelProtocol)` returning `/v1/chat/completions` (default), `/v1/responses`, `/v1/messages`, or `/models/{model}:generateContent`; `getChannelEndpointPreview(type, endpoint, protocol)` uses `isAudioChannelType(type)` → `"/v1/audio/speech"`, then `protocol === "gemini-generate-content"` → `buildGeminiNativeEndpointPreview`, then `isAzureChannelType(type)` → `buildAzureEndpointPreview`, else `buildPrefixedEndpointPreview`. Delete `buildClaudeEndpointPreview` and `isOpenAIStyleChannelType` (orphaned by this switch). Call site (currently line 1136) passes `formData.primary_protocol`. Keep `getChannelEndpointPlaceholder` type-based.

**`frontend/src/i18n/locales/{en,zh-CN,zh-TW}.json`** — add under `channels`:

| key | en | zh-CN | zh-TW |
|---|---|---|---|
| `protocolSupport` | `Protocol Support` | `协议支持` | `協定支援` |
| `protocolSupportHint` | `Upstream protocols this endpoint serves natively. Matching requests are forwarded verbatim; other protocols are converted to the primary protocol.` | `该端点原生支持的协议。命中支持协议时原样转发，其它协议会转换为主协议。` | `此端點原生支援的協定。命中支援協定時原樣轉發，其它協定會轉換為主協定。` |
| `primaryProtocol` | `Primary Protocol` | `主协议` | `主協定` |
| `primaryProtocolHint` | `Conversion target when the incoming protocol is not supported by this channel.` | `当入站协议不在支持列表中时，请求会转换为主协议。` | `當入站協定不在支援列表中時，請求會轉換為主協定。` |
| `protocolRequired` | `Keep at least one enabled protocol` | `至少保留一个协议` | `至少保留一個協定` |
| `protocolOpenAIChat` | `OpenAI Chat Completions` | same | same |
| `protocolOpenAIResponses` | `OpenAI Responses` | same | same |
| `protocolAnthropicMessages` | `Anthropic Messages` | same | same |
| `protocolGemini` | `Gemini GenerateContent` | same | same |

### Step 7 — Tests

Update existing tests mechanically (no assertion weakening):

- `tests/helpers/provider-harness.ts:85`: build the channel config before dispatch and pass it:
  `const channelConfig = { name: "test", endpoint: "", ...options.config, type: options.type } as ChannelConfig; const provider = getProvider(options.routeId, channelConfig)`.
- `tests/protocol-conversion.test.ts:1101-1124`: `getProvider(route, { type })`, e.g. `getProvider("chat-completions", { type: "openai" })`, `getProvider("chat-completions", { type: "unknown" as ChannelType })`.
- `tests/protocol-conversion.test.ts:1438-1490`: pass the second argument to every `resolveUpstreamBase` call — `"gemini-generate-content"` for gemini-native, `"openai-chat"` for azure-openai/openai, `"openai-responses"` for azure-openai-responses/openai-responses, `"anthropic-messages"` for claude. Expected values stay identical.
- `tests/protocol-conversion.test.ts` assertions that match the old guard text `"cannot be converted to the selected channel protocol"` or `createConversionNotRequiredError`'s old message: switch to the new substrings defined in Step 3/Step 2.

Add `tests/channel-protocols.test.ts` (imports `bun:test`, `hono`, `db`, `adminApi`, helpers `createTestDatabase`/`installUpstream`) with:

1. `resolveChannelProtocols`/`resolvePrimaryProtocol` defaults and overrides:
   - `{ type: "openai" }` → `["openai-chat"]`, primary `"openai-chat"`.
   - `{ type: "openai", protocols: ["openai-responses", "openai-chat"] }` → `["openai-chat", "openai-responses"]` (canonical order).
   - primary respected only when declared in the list.
   - `{ type: "azure-openai", protocols: ["gemini-generate-content"] }` → `["openai-chat"]`.
   - `{ type: "openai-audio" }` → `[]`, primary `null`.
2. Dispatch: `getProvider("responses", { type: "openai", protocols: ["openai-chat", "openai-responses"] })` is `passthroughProxy.fetch`; `getProvider("responses", { type: "openai" })` and `getProvider("chat-completions", { type: "openai", protocols: ["openai-responses"] })` are `protocolConversion.fetch`.
3. Native passthrough preserves the Responses payload: `runProvider({ routeId: "responses", type: "openai", config: { endpoint: "https://api.openai.com/v1", api_key: "sk-test", protocols: ["openai-chat", "openai-responses"], primary_protocol: "openai-chat" }, requestBody: { model: "gpt-4.1", input: "hi", previous_response_id: "resp_prev" } })` → upstream URL exactly `https://api.openai.com/v1/responses`, upstream JSON body keeps `previous_response_id: "resp_prev"`, header `authorization: Bearer sk-test`, response 200.
4. Declared protocols drive the conversion target: `routeId: "responses"`, `type: "openai-responses"`, `protocols: ["openai-chat"]`, mock chat-completions response (reuse the fixture used by the existing responses→chat test) → upstream path ends `/v1/chat/completions`, response 200.
5. Rich error: `runProvider({ routeId: "responses", type: "openai", config: { name: "chat-only", channel_key: "chat-only-key", endpoint: "https://api.openai.com/v1" }, requestBody: { model: "gpt-4.1", input: "hi", previous_response_id: "resp_prev", conversation: "conv_1" } })` → status 400, body `error.code === "request_unsupported_openai_semantics"`, `error.param === "previous_response_id"`, message contains `previous_response_id`, `conversation`, `Channel "chat-only" (key: chat-only-key, type: openai)`, `supports: openai-chat`, `conversion target: "openai-chat"`.
6. Fallback rescue: channels `chat` (`normalizeChannelConfig({ name: "chat", type: "openai", endpoint: "https://upstream.test/v1", api_keys: ["k"] })`) and `resp` (`normalizeChannelConfig({ name: "resp", type: "openai-responses", endpoint: "https://upstream.test/v1", api_keys: ["k"] })`) both mapping model `gpt-4.1`; `installUpstream` records paths and returns a Responses payload for `/responses`; call `executeWithFallbackChannels(new Context(new Request("http://localhost/v1/responses", { method: "POST" })), [chat, resp], chat, { model: "gpt-4.1", input: "hi", previous_response_id: "resp_prev" }, async () => {}, () => {}, { retryCount: 0 }, () => {}, "responses", { ...DEFAULT_CHANNEL_ROUTING_CONFIG, retryBackoffMs: 0 })` → response 200 and recorded paths exactly `["/v1/responses"]` (no chat-completions call, no key retry).
7. DB migration materializes defaults: `createTestDatabase()`, insert `channel_config` row `{ name: "Legacy", type: "openai", endpoint: "https://api.openai.com/v1", api_keys: ["k"], models: [{ id: "gpt-4.1", name: "gpt-4.1" }] }`, run `db.migrate(fixture.context)`, re-read row → `protocols: ["openai-chat"]`, `primary_protocol: "openai-chat"`. Run `db.migrate` twice and assert the row is unchanged (idempotent).
8. Admin validation: `new Hono<HonoCustomType>().route("/", adminApi)`, `db.migrate` fixture, `fixture.context.env.ADMIN_TOKEN = "fixture-admin-token"`, POST `/api/admin/channel/azure-gemini` with `{ name: "x", type: "azure-openai", endpoint: "https://r.openai.azure.com/", api_keys: ["k"], protocols: ["gemini-generate-content"] }` and header `x-admin-token` → 400 with body containing `gemini-generate-content`; POST with `protocols: ["openai-chat", "openai-responses"], primary_protocol: "gemini-generate-content"` → 400 with `primary_protocol must be included in protocols`; POST valid `protocols: ["openai-chat", "openai-responses"], primary_protocol: "openai-responses"` → 200 and the stored row contains both fields.

## Critical files & anchors

- `src/providers/shared/protocol-registry.ts` — registry rewrite; `buildBaseResult`, `normalizeGeminiNativeBaseUrl` are reused.
- `src/providers/protocol-conversion.ts` — `fetch()` protocol selection plus `assertConversionSupported`/`buildErrorPayload` rewrite.
- `src/providers/shared/upstream-retry.ts` — `executeChannelWithRetries`, `pickNextFallbackChannel`, `executeWithFallbackChannels` fallback filtering.
- `frontend/src/pages/Channels.tsx` — form state, `normalizeChannelFormConfig` (line ~200), preview helpers (lines ~431-559), Basic Info card (line ~1451), new protocol card.
- `tests/protocol-conversion.test.ts` — dispatch/base-URL tests to update; new file mirrors its provider harness style.

## Verification

1. `bun run typecheck` — worker + frontend TypeScript pass.
2. `bun test tests` — full suite passes (includes updated dispatch/base-URL tests and the new file).
3. Targeted new behavior:
   - `bun test tests/channel-protocols.test.ts` — all 8 cases pass. Failure of case 3 means passthrough was not selected; failure of case 6 means fallback filtering did not engage.
4. `bun run --filter frontend build` — Vite build succeeds (i18n keys resolve at runtime, not build time, so also do step 5).
5. Manual UI check: `bun run dev`, open `http://localhost:5173/channels`, Add Channel.
   - Type `OpenAI`: protocol card shows 4 checkboxes, only `OpenAI Chat Completions` checked; checking `OpenAI Responses` and selecting it as Primary updates the endpoint preview to `https://api.openai.com/v1/responses`; save and reopen — both stay checked and Primary persists.
   - Switching type to `OpenAI Audio` hides the protocol card and the preview path becomes `/v1/audio/speech`.
   - Unchecking the only checked protocol shows the `Keep at least one enabled protocol` toast and leaves the checkbox checked.
6. Error surface check: with a chat-only channel selected, send a Responses request containing `previous_response_id`; the admin API Test page shows the full message including the channel name/key, supported protocols, and conversion target (proves `client.ts` extraction).

## Assumptions & contingencies

- Channel key is exposed in client-visible conversion errors (user-chosen). It arrives via the runtime-only `ChannelConfig.channel_key`, never persisted: `sanitizeChannelConfig` whitelists fields, so the DB rewrite drops it.
- All four text protocols are selectable on non-Azure text channel types; Azure types stay limited to `openai-chat`/`openai-responses`. Enabling a protocol the upstream does not actually serve is the operator's responsibility; the gateway forwards verbatim.
- Existing stored channels without `protocols` use the type default (identical to pre-change behavior), materialized once by the `DB_VERSION` bump.
- Contingency: if some runtime path constructs a channel config bypassing `normalizeChannelConfig` and lacks `protocols`, `resolveChannelProtocols` still returns type defaults, so behavior does not regress.
- Contingency: if any other test asserts the old conversion-guard message or old `getChannelProtocolDescriptor` export, update it to the new message/API — do not re-add the old export.
