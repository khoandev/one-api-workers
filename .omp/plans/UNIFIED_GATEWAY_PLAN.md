# Plan: Unified protocol gateway + Gemini native inbound

## Quyết định đã chốt

1. **Unified passthrough**: cùng protocol thì forward raw (giữ nguyên body/SSE, ảnh, tài liệu, native fields); khác protocol thì convert qua Airlock canonical. Xóa toàn bộ proxy text riêng lẻ.
2. **Endpoint `#` (URL chính xác)**: giữ hỗ trợ. Raw dùng URL builder hiện có; convert inject `fetcher` vào adapter để ghi đè path/origin, giữ query do adapter thêm (`alt=sse`).
3. **Gemini native inbound**: thêm `POST /v1beta/models/{model}:generateContent` và `:streamGenerateContent`, convert sang mọi text channel type; cùng protocol thì raw.
4. Audio vẫn direct (không có canonical audio), nhưng gộp vào một provider forwarding duy nhất.

## Kiến trúc dispatch

`getProvider(routeId, type)`:

```
audio route            -> passthrough
không có descriptor    -> undefined
route protocol == channel protocol -> passthrough
còn lại                -> protocolConversion
```

- `RouteId` thêm `"gemini-generate-content"`.
- Xóa `DIRECT_CHANNEL_TYPES`, `hasDirectProvider`, nhánh `#` trong route policy.
- `isChannelAllowedForRoute`: audio chỉ nhận audio type; text route nhận mọi text descriptor, kể cả endpoint `#`.

## Raw passthrough provider

File mới `src/providers/passthrough-proxy.ts`, thay 5 file proxy:

- `openai-proxy.ts`, `azure-openai-proxy.ts`, `claude-proxy.ts`,
  `openai-responses-proxy.ts`, `azure-openai-responses-proxy.ts`.

Xử lý theo protocol:

- **openai-chat**: URL `/v1/chat/completions` (Azure dùng `buildAzureTargetUrlFromPath`, Gemini type dùng nhánh `/v1beta/openai`); auth `Authorization: Bearer` hoặc `api-key`; stream mode thêm `stream_options.include_usage` như proxy cũ.
- **anthropic-messages**: URL `/v1/messages`; `x-api-key` + `anthropic-version` mặc định; giữ `anthropic-beta`.
- **openai-responses**: URL `/responses`; auth Bearer hoặc `api-key`; raw giữ `previous_response_id`, native tools, images.
- **gemini-generate-content**: URL `/models/{mappedModel}:generateContent|:streamGenerateContent`; stream thêm `alt=sse`; auth `x-goog-api-key`; body bỏ `model`/`stream` trước khi gửi.
- **audio**: `/v1/audio/speech`; auth Bearer hoặc `api-key`; usage ước lượng từ input như hiện tại.

Header: dùng allowlist hiện có, thêm `x-goog-api-key` vào `BLOCKED_HEADER_NAMES`, override bằng channel key. Query: giữ query của endpoint; Gemini thêm query client hợp lệ (bỏ `key`, `alt`).

Stream passthrough: `response.body.tee()`, trả client stream gốc, tee còn lại đọc usage trong `executionCtx.waitUntil`. Non-stream: `checkout*UsageData` trước khi trả response. `trackingState.upstreamStatus` luôn set.

Usage helpers:

- Giữ `openai-stream-utils.ts`, `responses-stream-utils.ts` (tái sử dụng).
- Tách usage Claude khỏi `claude-proxy.ts` sang `src/providers/shared/anthropic-stream-utils.ts`.
- Thêm `src/providers/shared/gemini-stream-utils.ts`: đọc `usageMetadata` non-stream/SSE; fallback `estimateUsageFromBodies` khi thiếu usage.

## Endpoint `#`

- Raw: builder hiện có trả URL tuyệt đối (không nối path); Gemini builder mới xử lý `#`.
- Convert: `createAdapter` nhận `fetcher` khi `config.endpoint.endsWith("#")`; wrapper giữ method/body/headers, thay origin+path bằng URL exact, giữ search params adapter thêm (`alt=sse`, forwarded query).

## Gemini native inbound

Route:

- `api.post("/v1beta/models/*", UnifiedProxyEndpoint)`.
- Parse `{model, action}` từ path; chỉ nhận `generateContent` / `streamGenerateContent`, sai action trả 404.
- `resolveChannel(c, routeId, { model, stream })` để không phải nhét field giả vào body.
- Auth: `x-goog-api-key`, hoặc `?key=` **chỉ** cho route Gemini; giữ `Authorization`/`x-api-key` cũ.
- Conversion: `parseClientRequest` dùng `geminiGenerateContentRequestSchema` + `normalizeGeminiGenerateContentRequest({...parsed, model: mappedModel, stream})`.
- Response: `encodeCanonicalToGeminiGenerateContentResponse`; stream dùng `encodeCanonicalToGeminiGenerateContentStreamEvents`, ghi `data: {...}\n\n`, không gửi `[DONE]`.
- Error: shape `{ error: { code, message, status } }`; stream error `data: {"error":...}`. Auth/model/quota response từ `resolveChannel` cũng được wrap sang shape Gemini.

## Files

### Tạo mới

- `src/providers/passthrough-proxy.ts`
- `src/providers/shared/anthropic-stream-utils.ts`
- `src/providers/shared/gemini-stream-utils.ts`
- `src/providers/shared/gemini-target-url.ts`
- `src/providers/shared/gemini-errors.ts`
- `tests/helpers/provider-harness.ts`
- `tests/passthrough.test.ts`
- `tests/gemini-inbound.test.ts`

### Sửa

- `src/providers/index.ts` (đăng ký route Gemini, parse target, wrap lỗi)
- `src/providers/protocol-conversion.ts` (Gemini parse/encode/error, fetcher `#`, bỏ nhánh audio/same-protocol không còn dùng)
- `src/providers/shared/provider-registry.ts`
- `src/providers/shared/route-policy.ts`
- `src/providers/shared/protocol-registry.ts`
- `src/providers/shared/channel-resolver.ts`
- `src/providers/shared/auth.ts`
- `src/providers/shared/upstream-request-headers.ts`
- `src/providers/shared/azure-target-url.ts` (bỏ `buildAzureTargetUrl` nếu không còn caller)
- `tests/protocol-conversion.test.ts`
- `tests/chat-stream-usage.test.ts`
- `tests/mock-upstream.ts`
- `tests/setup-test-data.sh`
- `tests/run-e2e.sh`
- `README.md`
- `docs/usage-and-configuration.md`, `docs/usage-and-configuration.zhCN.md`
- `docs/testing.md`

### Xóa

- 5 file proxy text kể trên.

## Test plan (đầy đủ)

### Unit

`tests/protocol-conversion.test.ts`

- Giữ toàn bộ ma trận convert hiện có.
- Sửa test dispatch: same protocol -> passthrough; cross protocol -> conversion; unknown -> undefined; audio -> passthrough.
- Sửa route policy: mọi text route × mọi text type, kể cả `#`; audio chỉ audio type.
- Gemini inbound: convert sang openai/azure/chat, claude, responses; non-stream + stream; usage; encode response/SSE; lỗi shape.
- Giữ test từ chối image khi **khác** protocol.

`tests/passthrough.test.ts`

- Non-stream: URL/auth/body/header scrub cho openai, azure, claude, responses, azure-responses, gemini-native, audio.
- Ảnh/native fields giữ nguyên: `image_url`, Anthropic image block, `previous_response_id`.
- Stream: byte SSE giữ nguyên; usage lấy từ stream cho 4 protocol; fallback estimate khi thiếu usage.
- `#`: raw exact path; converted exact path + `alt=sse`.
- Gemini raw: model lấy từ mapping, body không có `model`, `x-goog-api-key`.

`tests/gemini-inbound.test.ts`

- Parse route/action/model.
- Auth: header, query `key`, invalid key, query key không áp dụng cho route khác.
- Gemini stream SSE không có `[DONE]`; error JSON; invalid payload/route 400/404.
- Header/query không leak `key`, `alt`, token client.

`tests/chat-stream-usage.test.ts`

- Chuyển provider loop sang `getProvider`/passthrough; giữ test estimate/UTF-8/usage authoritative.

### E2E

`tests/mock-upstream.ts`

- Stream Gemini theo path `:streamGenerateContent` (hiện chỉ đọc `body.stream`).
- Thêm endpoint audio trả `audio/mpeg` nếu cần test audio.

`tests/setup-test-data.sh`

- Thêm channel `test-exact` type `openai`, endpoint `$MOCK/exact/chat/completions#`, model `gpt-4o-exact`; thêm vào token `sk-mock-all`.

`tests/run-e2e.sh`

- Gemini inbound non-stream/stream qua gemini-native (raw), openai, claude, responses.
- Auth `x-goog-api-key` và `?key=`.
- Invalid action/model/image -> Gemini error shape.
- Header scrub: Authorization/cookie/x-forwarded-for/x-goog-api-key; upstream chỉ channel key.
- Raw Gemini `alt=sse`, body `contents`, path model.
- Same-protocol ảnh/native field được forward.
- `#` exact URL qua `test-exact`.
- Audio path/auth.
- Giữ các test quota/analytics hiện có.

## Docs

- README: bỏ câu “same-protocol giữ direct proxy”; nêu raw passthrough + convert; Gemini inbound.
- `docs/usage-and-configuration*.md`: mục protocol conversion, `#`, Gemini native inbound, auth.
- `docs/testing.md`: bổ sung coverage.

## Hành vi thay đổi cần biết

- Cùng protocol: raw passthrough, không validate schema (như proxy cũ), giữ multimodal/native.
- Khác protocol: vẫn text/tool như Airlock; ảnh/document bị từ chối (giữ nguyên hành vi hiện tại).
- Endpoint `#` giờ dùng được cho mọi text channel (trước chỉ same-protocol direct), kể cả khi convert.
- Gemini inbound luôn trả SSE cho `:streamGenerateContent`, bất kể client gửi `alt`.
- `x-goog-api-key` bị chặn forward; `?key=` chỉ dùng để auth route Gemini.

## Verify

```bash
bun run typecheck
bun test tests
bun run build
cd frontend && bun run lint
```

E2E:

```bash
bun run tests/mock-upstream.ts
bun run dev:worker
bash tests/setup-test-data.sh
bash tests/run-e2e.sh
```

## Ngoài phạm vi

- Không thêm audio conversion.
- Không thêm Gemini `/v1beta/models` list endpoint.
- Không đổi UI playground.
