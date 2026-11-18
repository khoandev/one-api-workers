# Pricing sync from models.dev

## Context

Trang Pricing hiện chỉ nhập tay `MODEL_PRICING_CONFIG` (`{model: {billingMode, input, output, cache}}`, đơn vị USD/1M token). Yêu cầu: tự động lấy giá từ `https://models.dev/api.json`.

Đã xác minh API ngày 2026-11-18: payload là object `providerId -> {id, name, api?, models: {modelId -> {id, name, canonical_model_id?, cost: {input?, output?, cache_read?}}}}`, 324 provider, 9978 entry, 4360 id. `cost.input/output/cache_read` là USD/1M token, khớp trực tiếp với `input/output/cache` của config. Fetch phải qua Worker (CORS + admin auth).

Kết quả chốt:
- Có nút "Sync from models.dev" mở dialog preview; mặc định chỉ điền model chưa có giá, có checkbox ghi đè.
- Cron hằng ngày `0 3 * * *` (UTC) tự điền model thiếu giá, không bao giờ ghi đè.
- Khi trùng model id ở nhiều provider: ưu tiên provider official (theo loại channel trước, rồi danh sách official), fallback giá input dương thấp nhất.
- Chỉ áp dụng cho pricing global; `channel.model_pricing` giữ nguyên. Không thêm toggle bật/tắt cron.

## Approach

### 1. Tách sanitizer pricing sang module dùng chung

Tạo `src/pricing-config.ts`, move nguyên văn từ `src/admin/pricing_api.ts`: `toPositiveNumber`, `normalizeBillingMode`, `sanitizePricingConfig`; export cả ba. Xóa chúng khỏi `pricing_api.ts` và import `sanitizePricingConfig` từ `../pricing-config`. Không đổi hành vi sanitize (giữ nguyên quy tắc legacy `request`).

### 2. Module sync `src/pricing-sync.ts`

Không có module tương đương trong repo; tạo mới. Import `getChannelModels`/`getJsonSetting`/`saveSetting` từ `./utils`, `sanitizeChannelConfig` từ `./channel-config`, `sanitizePricingConfig` từ `./pricing-config`, `CONSTANTS` từ `./constants`.

Hằng số và type:

```ts
export const MODELS_DEV_PRICING_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 20_000;

const OFFICIAL_PROVIDER_IDS = new Set([
  "openai", "azure", "anthropic", "google", "google-vertex", "google-vertex-anthropic",
  "deepseek", "mistral", "xai", "meta", "cohere", "amazon-bedrock",
  "groq", "cerebras", "fireworks-ai", "togetherai",
]);

const CHANNEL_TYPE_PROVIDER_IDS: Record<string, string[]> = {
  "openai": ["openai"],
  "openai-audio": ["openai"],
  "openai-responses": ["openai"],
  "azure-openai": ["azure", "openai"],
  "azure-openai-audio": ["azure", "openai"],
  "azure-openai-responses": ["azure", "openai"],
  "claude": ["anthropic"],
  "gemini-native": ["google", "google-vertex"],
};

export type PricingSyncSuggestion = {
  input: number;
  output: number;
  cache?: number;
  provider: string;
};

export type PricingSyncPreview = {
  suggestions: Record<string, PricingSyncSuggestion>;
  unmatched: string[];
  targetCount: number;
  providerCount: number;
  fetchedAt: string;
};

export type PricingSyncTarget = { model: string; channelTypes: string[] };
type Candidate = { provider: string; modelKey: string; input: number; output: number; cache?: number };
```

Chuẩn hóa khóa (`export` để test):

```ts
export const normalizePricingModelKey = (value: string): string =>
  value.trim().toLowerCase()
    .replace(/[_.\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
```

Lookup key của target (gộp candidate từ tất cả key, dedupe theo `provider + modelKey`):
1. `normalizePricingModelKey(model)`
2. normalize của phần sau `/` cuối (`model.split("/").pop()`)
3. bỏ hậu tố region `@...` của (2)
4. bỏ hậu tố ngày `-\d{4}-\d{2}-\d{2}$` hoặc `-\d{8}$` của (3)

Gộp candidate của cả 4 key rồi mới `pickCandidate` để model có prefix vẫn ưu tiên được official provider.

`buildModelsDevIndex(payload)`:
- Throw `Error("Invalid models.dev response")` nếu payload không phải object hoặc không có provider nào có `models` object.
- Với mỗi provider: `providerId` = key object (fallback `provider.id`), tăng `providerCount`.
- Bỏ qua model không phải object; `modelId` = `model.id` string hoặc key object.
- Đọc `cost.input`, `cost.output`, `cost.cache_read` khi `cost` là object, bằng helper chỉ nhận number hữu hạn `>= 0` (giá trị khác coi như 0/không có). Bỏ qua `cost.cache_write`, `cost.input_audio`, `cost.output_audio`.
- Bỏ candidate nếu `input <= 0 && output <= 0` (model free không đại diện được trong config; tránh suggestion toàn 0).
- Candidate `{provider, modelKey: modelId, input, output, cache}`; chỉ set `cache` khi `cache_read > 0`.
- Index theo các key string không rỗng: `model.id`, `modelId`, `model.canonical_model_id`, `model.name`; với key chứa `/` thêm cả phần sau `/` cuối. Dedupe theo cặp `provider + modelKey` trong cùng key.
- Trả `{ index: Map<string, Candidate[]>, providerCount }`.

`export const collectPricingSyncTargets(channels, existingPricing)`:
- Với mỗi channel: `sanitizeChannelConfig(channel)`; bỏ qua khi `normalized.enabled === false`.
- Mỗi model từ `getChannelModels(normalized)` (đã lọc `enabled !== false`) thêm target theo `model.name`, kèm `normalized.type` nếu có.
- Thêm mọi key của `existingPricing` làm target (không kèm type) để preview có thể ghi đè giá đã lưu.
- Trả mảng sort theo `model.localeCompare`, `channelTypes` là mảng type đã sort/unique.

`pickCandidate(candidates, channelTypes)`:
- `preferred` = unique các provider id từ `CHANNEL_TYPE_PROVIDER_IDS[type]` theo thứ tự channelTypes.
- `rank(candidate)`: index trong `preferred` nếu có; nếu không, `preferred.length` khi provider thuộc `OFFICIAL_PROVIDER_IDS`; còn lại `preferred.length + 1`.
- Sort tăng dần: `rank`, rồi input (`input > 0 ? input : Infinity`), rồi output tương tự, rồi `provider.localeCompare`, rồi `modelKey.localeCompare`; lấy phần tử đầu.
- `export const buildPricingSuggestions(payload, targets)` dùng index + lookup + pick; suggestion `{input, output, cache?, provider}`; model không có candidate vào `unmatched` (sort theo `localeCompare`). Trả `PricingSyncPreview` với `fetchedAt = new Date().toISOString()`.

`mergePricingSuggestions(existing, suggestions, overwrite)` (export, pure):
- Copy `existing`; với từng suggestion:
  - `hasExistingPricing` = entry hiện tại có `input/output/cache/request > 0` hoặc `billingMode === "request"`.
  - Nếu `hasExistingPricing && !overwrite`: đẩy vào `skipped`, giữ nguyên.
  - Ngược lại tạo entry mới `{billingMode: "volume"}` + `input` nếu `> 0` + `output` nếu `> 0` + `cache` nếu `> 0`; entry không còn giá trị dương nào thì `skipped`, không ghi.
  - Entry mới thay thế hoàn toàn entry cũ (bỏ `request` legacy).
- Chạy `sanitizePricingConfig` trên object kết quả; trả `{config, updated, skipped}` (hai mảng sort).

`loadPricingSyncInputs(c)`:
- `SELECT key, value FROM channel_config`; parse JSON từng row, bỏ row lỗi/không phải object.
- Đọc `getJsonSetting<Record<string, Partial<ModelPricing>>>(c, CONSTANTS.MODEL_PRICING_KEY)`; null/không phải object coi như `{}`.
- Trả `{targets}` qua `collectPricingSyncTargets`.

`fetchModelsDevPricing()`: `fetch(MODELS_DEV_PRICING_URL, {headers: {Accept: "application/json"}, signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS)})`; `!response.ok` throw `Error("models.dev returned <status>")`; trả `response.json()`.

`export const buildPricingSyncPreview(c)`:
- Lấy targets. Nếu `targets.length === 0`, trả preview rỗng (`suggestions: {}`, `unmatched: []`, `targetCount: 0`, `providerCount: 0`, `fetchedAt`) và KHÔNG fetch.
- Ngược lại fetch rồi `buildPricingSuggestions`.

`export const applyPricingSync(c, suggestions, overwrite)`:
- Đọc config hiện tại (null/không phải object coi như `{}`), `mergePricingSuggestions`, nếu `updated.length > 0` thì `saveSetting(c, CONSTANTS.MODEL_PRICING_KEY, JSON.stringify(config))`.
- Trả `{updated, skipped}`.

`export const runScheduledPricingSync(c)`: `buildPricingSyncPreview(c)` rồi `applyPricingSync(c, preview.suggestions, false)`; trả summary `{targetCount, matched, updated, skipped, unmatched}` để log.

### 3. Admin preview endpoint

Trong `src/admin/pricing_api.ts`, thêm `PricingSyncPreviewEndpoint extends OpenAPIRoute`:
- `schema`: tag `Admin API`, summary `Preview pricing suggestions from models.dev`; response 200 qua `CommonSuccessfulResponse(z.object({ suggestions: z.record(z.string(), z.object({ input: z.number(), output: z.number(), cache: z.number().optional(), provider: z.string() })), unmatched: z.array(z.string()), targetCount: z.number(), providerCount: z.number(), fetchedAt: z.string() }))`.
- `handle`: gọi `buildPricingSyncPreview(c)`, trả `{success: true, data}`; catch trả `c.text(error.message, 502)` (giống `ChannelFetchModelsEndpoint`).

Trong `src/admin/index.ts`: import endpoint, đăng ký `api.post("/api/admin/pricing/sync", PricingSyncPreviewEndpoint)` ngay sau route pricing hiện có.

### 4. Cron hằng ngày

`wrangler.jsonc` và `wrangler.local.jsonc`: thêm top-level
```jsonc
"triggers": { "crons": ["0 3 * * *"] }
```

`src/index.ts`:
- Đổi `import type { Context } from 'hono'` thành import value `Context`.
- Thêm handler cạnh `export default`:

```ts
const scheduled: ExportedHandlerScheduledHandler<CloudflareBindings> = async (_controller, env, ctx) => {
  const context = new Context<HonoCustomType>(
    new Request("https://pricing-sync.internal/"),
    { env, executionCtx: ctx },
  );
  try {
    await db.ensureReady(context);
    console.log("Scheduled pricing sync", await runScheduledPricingSync(context));
  } catch (error) {
    console.error("Scheduled pricing sync failed", error);
  }
};

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<CloudflareBindings>;
```

`app.fetch` là arrow property của Hono app nên không mất `this`; test hiện tại `app.fetch(...)` vẫn chạy vì default export mới vẫn có `fetch`. Không đổi route/middleware nào khác.

### 5. Frontend: types + API client

`frontend/src/types/index.ts`, sau `PricingConfig`:

```ts
export interface PricingSyncSuggestion {
  input: number
  output: number
  cache?: number
  provider: string
}

export interface PricingSyncPreview {
  suggestions: Record<string, PricingSyncSuggestion>
  unmatched: string[]
  targetCount: number
  providerCount: number
  fetchedAt: string
}
```

`frontend/src/api/client.ts`: import hai type trên; thêm method sau `savePricing`:

```ts
previewPricingSync: () =>
  request<ApiResponse<PricingSyncPreview>>('/api/admin/pricing/sync', { method: 'POST' }),
```

### 6. Frontend: dialog preview + áp dụng

Trong `frontend/src/pages/Pricing.tsx`:
- Import thêm `PricingSyncPreview, PricingSyncSuggestion` từ `@/types`; `Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle` từ `@/components/ui/dialog`; `Checkbox` từ `@/components/ui/checkbox`; `Download` từ `lucide-react`.
- Helper cạnh `isCustomPricingRow`:

```ts
const hasConfiguredPricing = (pricing?: Partial<PricingModel> | null): boolean =>
  Boolean(pricing) && (
    normalizePricingNumber(pricing?.input, 0) > 0
    || normalizePricingNumber(pricing?.output, 0) > 0
    || normalizePricingNumber(pricing?.cache, 0) > 0
    || normalizePricingNumber(pricing?.request, 0) > 0
    || pricing?.billingMode === "request"
  );
```

- State: `syncDialogOpen` (false), `syncPreview` (`PricingSyncPreview | null`), `syncOverwrite` (false).
- Preview mutation: `apiClient.previewPricingSync()`; onSuccess set `syncPreview`, reset `syncOverwrite=false`, mở dialog; onError toast `t('pricing.syncFailed', {message: error.message})` type `error`.
- `syncBaseConfig` = `editMode === "cards" ? buildConfigFromRows(pricingRows) : normalizedJsonConfig` (đặt sau `currentPricingConfig`); `null` nghĩa là JSON không hợp lệ.
- `syncPreviewRows` = entries của `syncPreview.suggestions`, map `{model, current: syncBaseConfig?.[model], next, hasExisting}`, filter `!hasExisting || syncOverwrite`, sort theo model.
- `formatSyncPricing(pricing)`: nếu `billingMode === "request"` trả `t('pricing.estimatedCostRequest', {cost: input.toFixed(PRICING_DECIMALS)})`; ngược lại trả `input / output / cache` (mỗi giá trị `> 0` format `toFixed(PRICING_DECIMALS)`, còn lại `t('pricing.syncEmptyValue')`). Với suggestion (`PricingSyncSuggestion`, không có `billingMode`), gọi helper bằng `{billingMode: "volume", ...next}`.
- `handleApplySync`:
  - Nếu `!syncBaseConfig`: toast `t('common.jsonFormatError')`, return.
  - Nếu `syncPreviewRows.length === 0`: đóng dialog, toast `t('pricing.syncNoChanges')` type `info`, return.
  - Copy base config; với mỗi row tạo `{billingMode: "volume"}` + input/output/cache dương từ `next`; gán đè key model.
  - `normalizePricingConfig(nextConfig)`.
  - Cards mode: dựng `nextRows = buildPricingRows(modelChannelMap, sanitized, {sortConfiguredFirst: true})`, `setPricingRows(nextRows)`, và dùng `buildConfigFromRows(nextRows)` làm config để lưu (tránh lệch thứ tự key gây auto-save lần hai). JSON mode: `setJsonValue(JSON.stringify(sanitized, null, 2))` và dùng `sanitized`.
  - Gọi ngay `saveMutation.mutate({config: configToSave, source: "manual", signature: JSON.stringify(configToSave)})` (không chờ auto-save 800ms).
  - Đóng dialog, toast `t('pricing.syncApplied', {count})` type `success`.
- Button trong `PageContainer.actions`, đặt trước nút Refresh: variant `outline`, size `sm`, icon `Download`, label `t('pricing.syncFromModelsDev')`, `disabled={syncPreviewMutation.isPending}`; gọi `syncPreviewMutation.mutate()`.
- Dialog `open={syncDialogOpen}` + `onOpenChange={setSyncDialogOpen}`, `max-w-3xl`, hiển thị:
  - `DialogTitle` `t('pricing.syncDialogTitle')`.
  - Description `t('pricing.syncDialogDescription', {providers: providerCount, targets: targetCount, matched: Object.keys(suggestions).length, unmatched: unmatched.length})`.
  - Dòng note `t('pricing.syncCronNote')` và (nếu có) `t('pricing.syncUnmatchedList', {models: unmatched.slice(0, 10).join(", ")})`.
  - Bảng scroll `max-h-[50vh] overflow-y-auto` với header Model / Current / models.dev / Provider; mỗi row dùng `formatSyncPricing` cho current và next; provider hiển thị `next.provider`.
  - Nếu `syncPreviewRows.length === 0`: hiện `t('pricing.syncNothing')`.
  - Footer: checkbox `checked={syncOverwrite}` + `onCheckedChange={setSyncOverwrite}` label `t('pricing.syncOverwriteExisting')`; nút Cancel (`t('common.cancel')`) đóng dialog; nút Apply label `t('pricing.syncApplyCount', {count: syncPreviewRows.length})`, disabled khi count 0 hoặc `saveMutation.isPending`.

Không đổi auto-save effect hiện có: `saveMutation` đã set `skipNextPricingSyncRef` trong `onSuccess`, nên dữ liệu vừa merge không bị hydrate đè.

### 7. i18n (en, zh-CN, zh-TW)

Thêm vào object `pricing` của cả 3 file `frontend/src/i18n/locales/*.json`:

en:
```json
"syncFromModelsDev": "Sync from models.dev",
"syncDialogTitle": "Pricing sync preview",
"syncDialogDescription": "Fetched {{providers}} providers from models.dev. Checked {{targets}} models, matched {{matched}}, not found {{unmatched}}.",
"syncOverwriteExisting": "Overwrite existing prices (including per-request billing)",
"syncColumnModel": "Model",
"syncColumnCurrent": "Current",
"syncColumnNext": "models.dev",
"syncColumnProvider": "Provider",
"syncApplyCount": "Apply {{count}}",
"syncApplied": "Applied pricing for {{count}} models",
"syncNoChanges": "No pricing changes to apply",
"syncNothing": "No changes to apply. Enable overwrite or add models in Channel Management.",
"syncUnmatchedList": "Not found on models.dev: {{models}}",
"syncFailed": "Sync failed: {{message}}",
"syncCronNote": "Daily automatic sync only fills models without pricing.",
"syncEmptyValue": "—"
```

zh-CN:
```json
"syncFromModelsDev": "从 models.dev 同步",
"syncDialogTitle": "定价同步预览",
"syncDialogDescription": "已从 models.dev 获取 {{providers}} 个供应商，检查 {{targets}} 个模型，匹配 {{matched}} 个，未匹配 {{unmatched}} 个。",
"syncOverwriteExisting": "覆盖已有价格（包括按次计费）",
"syncColumnModel": "模型",
"syncColumnCurrent": "当前",
"syncColumnNext": "models.dev",
"syncColumnProvider": "供应商",
"syncApplyCount": "应用 {{count}} 项",
"syncApplied": "已应用 {{count}} 个模型的价格",
"syncNoChanges": "没有可应用的价格变更",
"syncNothing": "没有可应用的变更。请开启覆盖，或先在渠道管理中添加模型。",
"syncUnmatchedList": "models.dev 未找到：{{models}}",
"syncFailed": "同步失败：{{message}}",
"syncCronNote": "每日自动同步只会填充没有价格的模型。",
"syncEmptyValue": "—"
```

zh-TW:
```json
"syncFromModelsDev": "從 models.dev 同步",
"syncDialogTitle": "定價同步預覽",
"syncDialogDescription": "已從 models.dev 取得 {{providers}} 個供應商，檢查 {{targets}} 個模型，匹配 {{matched}} 個，未匹配 {{unmatched}} 個。",
"syncOverwriteExisting": "覆蓋已有價格（包括按次計費）",
"syncColumnModel": "模型",
"syncColumnCurrent": "目前",
"syncColumnNext": "models.dev",
"syncColumnProvider": "供應商",
"syncApplyCount": "套用 {{count}} 項",
"syncApplied": "已套用 {{count}} 個模型的價格",
"syncNoChanges": "沒有可套用的價格變更",
"syncNothing": "沒有可套用的變更。請開啟覆蓋，或先在渠道管理中新增模型。",
"syncUnmatchedList": "models.dev 找不到：{{models}}",
"syncFailed": "同步失敗：{{message}}",
"syncCronNote": "每日自動同步只會填入沒有價格的模型。",
"syncEmptyValue": "—"
```

### 8. Tests

Tạo `tests/pricing-sync.test.ts` (Bun test), fixture payload nhỏ:

```ts
const modelsDevPayload = {
  openai: { models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o", cost: { input: 2.5, output: 10, cache_read: 1.25 } } } },
  azure: { models: { "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } } } },
  anthropic: { models: { "claude-sonnet-4.5": { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", cost: { input: 3, output: 15, cache_read: 0.3 } } } },
  reseller: { models: {
    "openai/gpt-4o": { id: "openai/gpt-4o", cost: { input: 0.5, output: 1 } },
    "gpt-4o-mini": { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
    "zero-model": { id: "zero-model", cost: { input: 0, output: 0 } },
  } },
};
```

Các test:
1. `normalizePricingModelKey("Claude Sonnet 4.5") === "claude-sonnet-4-5"`.
2. `collectPricingSyncTargets` với channel enabled chứa `gpt-4o` + model disabled `gpt-4o-mini`, channel disabled chứa `disabled-model`, existing config có `stored-model`; kết quả đúng `["gpt-4o", "stored-model"]`.
3. Official preference: target `{model:"gpt-4o", channelTypes:["openai"]}` → `{input:2.5, output:10, cache:1.25, provider:"openai"}` (bỏ reseller 0.5).
4. Fallback lowest: target `{model:"gpt-4o-mini", channelTypes:[]}` → provider `reseller`, `{input:0.15, output:0.6}`.
5. Prefix + separator: target `{model:"anthropic/claude-sonnet-4.5", channelTypes:["claude"]}` → provider `anthropic`, `{input:3, output:15, cache:0.3}`.
6. Free model: target `zero-model` → `unmatched` chứa `zero-model`, không có suggestion.
7. `mergePricingSuggestions` fill-only: existing `{"gpt-4o":{billingMode:"request",input:1}, legacy:{request:0.5}}`; suggestions gồm `gpt-4o`, `gpt-4o-mini`; `updated == ["gpt-4o-mini"]`; `config["gpt-4o"]` giữ `billingMode:"request"`; `config["legacy"]` thành `{billingMode:"request",input:0.5}` (sanitizer migrate legacy request-only); `config["gpt-4o-mini"] == {billingMode:"volume",input:0.15,output:0.6}`.
8. `mergePricingSuggestions` overwrite: `gpt-4o` thành `{billingMode:"volume",input:2.5,output:10,cache:1.25}`, `legacy` thành `{billingMode:"request",input:0.5}`.
9. Route test `POST /api/admin/pricing/sync`: dùng `createTestDatabase()` từ `tests/helpers/sqlite-d1`, `await db.initialize(fixture.context)`, insert `channel_config` row `openai-test` (`type:"openai"`, endpoint bất kỳ, models `[{id:"gpt-4o",name:"gpt-4o"}]`), stub `globalThis.fetch` trả `Response.json(modelsDevPayload)` và assert URL gọi là `https://models.dev/api.json`; gọi `app.fetch(new Request("http://localhost/api/admin/pricing/sync", {method:"POST", headers:{"x-admin-token":"admin-token"}}), {DB: fixture.database, ADMIN_TOKEN: "admin-token", USAGE_ANALYTICS: {writeDataPoint(){}}} as any, {waitUntil(){}, passThroughOnException(){}} as any)`; expect status 200 và `body.data.suggestions["gpt-4o"]` khớp `{input:2.5, output:10, cache:1.25, provider:"openai"}`. Restore `globalThis.fetch` trong `finally`.

## Critical files & anchors

| File | Vị trí | Lý do |
|---|---|---|
| `src/pricing-sync.ts` | mới | Toàn bộ index/normalize/rank/merge/fetch/cron logic |
| `src/admin/pricing_api.ts` | helper 18–98, cuối file | Move sanitizer, thêm endpoint preview |
| `src/index.ts` | dòng 175 `export default app` | Đổi sang object `{fetch, scheduled}` + `Context` value import |
| `frontend/src/pages/Pricing.tsx` | component `Pricing()` dòng 414, actions ~801, cuối 1075 | Nút sync, state, dialog, merge/apply |
| `wrangler.jsonc` / `wrangler.local.jsonc` | top-level | `triggers.crons` |

## Verification

1. `bun test tests/pricing-sync.test.ts` → 9 test pass. Sau đó `bun test tests` → toàn bộ suite pass.
2. `bun run typecheck` → Worker + frontend pass (bao gồm default export mới và locale JSON).
3. Endpoint thật:
   - Terminal 1: `bun run dev:worker` (dùng `wrangler.local.jsonc`, D1 local `one-api`, cổng 8787).
   - Seed:
     ```bash
     curl -s -X POST http://localhost:8787/api/admin/db_initialize \
       -H "x-admin-token: $(grep ^ADMIN_TOKEN .dev.vars | cut -d= -f2-)"
     curl -s -X POST http://localhost:8787/api/admin/channel/test-openai \
       -H 'content-type: application/json' -H "x-admin-token: $(grep ^ADMIN_TOKEN .dev.vars | cut -d= -f2-)" \
       -d '{"name":"OpenAI","type":"openai","endpoint":"https://api.openai.com/v1","api_keys":["sk-test"],"models":[{"id":"gpt-4o","name":"gpt-4o"}]}'
     ```
   - Gọi preview:
     ```bash
     curl -s -X POST http://localhost:8787/api/admin/pricing/sync \
       -H "x-admin-token: $(grep ^ADMIN_TOKEN .dev.vars | cut -d= -f2-)" \
       | jq '.data.suggestions["gpt-4o"]'
     ```
     Kỳ vọng: object `provider: "openai"`, `input: 2.5`, `output: 10`, `cache: 1.25` (giá models.dev có thể đổi; nếu khác, vẫn phải có `provider == "openai"` và các trường số dương). DB chưa đổi sau preview.
4. UI: `bun run dev`, mở `http://localhost:5173/pricing` → bấm "Sync from models.dev" → dialog hiện `gpt-4o` với giá models.dev; Apply → toast "Applied pricing for 1 models"; reload trang giá vẫn còn. Sửa tay giá `gpt-4o` thành `9`, bấm sync, tick "Overwrite existing prices" → bảng preview hiện `gpt-4o` với giá models.dev; Apply ghi đè về giá models.dev.
5. Cron local: dừng dev worker, chạy `bunx wrangler dev --config wrangler.local.jsonc --local --host localhost --test-scheduled`, thêm channel model chưa có giá (ví dụ `gpt-4o-mini`) qua admin API, rồi:
   ```bash
   curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"
   bunx wrangler d1 execute one-api --config wrangler.local.jsonc --local \
     --command "SELECT value FROM settings WHERE key='MODEL_PRICING_CONFIG'"
   ```
   Kỳ vọng log `Scheduled pricing sync` có `updated >= 1`; JSON trong settings có `gpt-4o-mini`; giá `gpt-4o` đã có từ bước UI giữ nguyên (không bị ghi đè). Nếu đã apply `gpt-4o` ở bước 4, cron chỉ thêm model thiếu.

## Assumptions & contingencies

- Schema models.dev (provider → models → `cost.{input,output,cache_read}`, USD/1M token) đã xác minh 2026-11-18. Nếu đổi shape, endpoint trả 502 `Invalid models.dev response`, cron log error và không ghi DB.
- Deployment đang dùng Workers Paid: binding `analytics_engine_datasets` trong `wrangler.jsonc` đã yêu cầu paid plan, nên CPU parse ~6.5MB JSON nằm trong hạn mức. Nếu thực tế chạy Free plan và cron/preview lỗi CPU (1102), giữ nguyên code nhưng ghi rõ giới hạn trong PR; không thêm cache phức tạp.
- Cron luôn bật sau deploy, chạy 03:00 UTC mỗi ngày; chỉ điền model thiếu giá nên không đổi giá admin đã đặt. Manual apply và cron có thể chạy xen kẽ; last-write-wins, nhưng cron không ghi đè nên xung đột vô hại.
- Giá sync là baseline theo policy official/lowest, không phản ánh giá thực của endpoint reseller; admin vẫn có thể sửa tay hoặc dùng `channel.model_pricing`.
