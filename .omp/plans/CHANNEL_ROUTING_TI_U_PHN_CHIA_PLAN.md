# Tối ưu phân chia channel và retry

## Bối cảnh

- Hiện tại `resolveChannel` (`src/providers/shared/channel-resolver.ts`) đọc cache rows thô 30 giây, nhưng vẫn `JSON.parse` + `normalizeChannelConfig` cho **mọi channel được gán cho token, mỗi request**, rồi `findChannelModelMapping` chuẩn hóa lại lần nữa. `models.ts` lặp lại y hệt.
- Chọn channel: `pickHighestPriorityChannel` lấy weight cao nhất, random trong nhóm cùng weight. Weight là "priority tier", không phải trọng số phân phối.
- Retry: hằng số `MAX_CHANNEL_RETRIES = 3`, `MAX_CHANNEL_FALLBACKS = 3` (`src/channel-config.ts`), retry ngay lập tức, không backoff, không cooldown, không có sức khỏe channel. Per-channel chỉ có `weight`, `auto_retry`, `auto_rotate`.
- Mục tiêu: (1) compile channel một lần mỗi TTL cache thay vì mỗi request; (2) cho admin cấu hình chiến lược chọn channel + tham số retry/fallback/backoff/cooldown/status; (3) thêm cooldown channel lỗi để tăng ổn định.

## Cách làm

### 1. Kiểu cấu hình routing (global setting)

`type.d.ts`:

```ts
type ChannelRoutingStrategy = "priority" | "weighted" | "round-robin";

type ChannelRoutingConfig = {
    strategy: ChannelRoutingStrategy;
    maxRetries: number;
    maxFallbacks: number;
    retryBackoffMs: number;
    cooldownMs: number;
    retryStatusCodes: number[];
};

type SystemConfig = BillingConfig & {
    adminSecurity: AdminSecurityConfig;
    apiDocs: ApiDocsConfig;
    routing: ChannelRoutingConfig;
}
```

`src/system-config.ts`:

```ts
export const DEFAULT_CHANNEL_ROUTING_CONFIG: ChannelRoutingConfig = {
    strategy: "priority",
    maxRetries: 3,
    maxFallbacks: 3,
    retryBackoffMs: 200,
    cooldownMs: 30_000,
    retryStatusCodes: [401, 403, 408, 409, 429, 500, 502, 503, 504, 529],
};

export const normalizeChannelRoutingConfig = (
    value?: Partial<ChannelRoutingConfig> | null
): ChannelRoutingConfig
```

Quy tắc chuẩn hóa (dùng chung server, frontend phải mirror y hệt):

- `strategy`: chỉ nhận `"priority" | "weighted" | "round-robin"`, còn lại `"priority"`.
- Số nguyên: `Math.trunc`, clamp `maxRetries`/`maxFallbacks` 0..10, `retryBackoffMs` 0..5000, `cooldownMs` 0..300000; không hữu hạn thì lấy default.
- `retryStatusCodes`: nếu là array thì lấy số nguyên 100..599, dedupe, sort tăng dần; array rỗng giữ `[]` (tắt retry theo HTTP status). Không phải array thì lấy default.
- `normalizeSystemConfig` thêm `routing: normalizeChannelRoutingConfig(value?.routing)`.
- `DEFAULT_SYSTEM_CONFIG` thêm `routing: DEFAULT_CHANNEL_ROUTING_CONFIG`.

`src/admin/system_api.ts`: thêm `channelRoutingConfigSchema` khớp các giới hạn trên; trong `systemConfigSchema` khai báo `routing: channelRoutingConfigSchema.optional()` để request cũ không gửi `routing` vẫn hợp lệ (normalize điền default).

### 2. Compile channel catalog một lần

`src/providers/shared/auth.ts`:

```ts
export type ChannelCatalogEntry = {
    key: string;
    config: NormalizedChannelConfig;
};

const loadAllChannels = async (
    c: Context<HonoCustomType>
): Promise<{ results: ChannelCatalogEntry[] }>
```

- `loadAllChannels` query `SELECT key, value FROM channel_config`, `JSON.parse` + `normalizeChannelConfig` mỗi row **một lần trong loader**; row lỗi thì `console.error` và bỏ qua. Vẫn dùng `cachedValue(c.env.DB, "channel_config:all", 30_000, loader)`.
- `fetchChannelsForToken` trả `Promise<{ results: ChannelCatalogEntry[] }>`; filter theo `tokenData.channel_keys` giữ nguyên.
- `invalidateChannelCache` giữ nguyên key/TTL, không cần thêm cache mới.

### 3. Module chọn channel + cooldown

Tạo `src/providers/shared/channel-selection.ts` (không import từ `channel-resolver` để tránh vòng lặp):

```ts
export type SelectableChannel = {
    key: string;
    config: { weight?: number };
};

export const resetChannelSelectionState = (): void;
export const markChannelSuccess = (channelKey: string): void;
export const markChannelFailure = (
    channelKey: string,
    cooldownMs: number,
    now?: number,
): void;
export const selectChannel = <T extends SelectableChannel>(
    channels: T[],
    strategy: ChannelRoutingStrategy,
    options?: { now?: number; random?: () => number },
): T;
```

Hành vi:

- State module-level trong isolate: `Map<string, number>` cooldown, `Map<string, number>` cursor round-robin. `resetChannelSelectionState()` xóa cả hai (dùng cho test).
- `markChannelFailure`: `cooldownMs <= 0` thì bỏ qua; ngược lại lưu `now + cooldownMs`; map quá 256 entry thì xóa entry cũ nhất. `markChannelSuccess` xóa entry của channel.
- `selectChannel`:
  - `now = options.now ?? Date.now()`, `random = options.random ?? Math.random`.
  - Lọc `healthy = channels.filter(c => (cooldowns.get(c.key) ?? 0) <= now)`. Nếu `healthy.length > 0` dùng `healthy`, ngược lại dùng toàn bộ `channels` (không để request fail chỉ vì tất cả đang cooldown).
  - `channels.length === 0` thì `throw new Error("selectChannel requires at least one channel")`.
  - `"priority"`: một pass tìm weight lớn nhất, gom nhóm, chọn `pool[Math.floor(random() * pool.length)]`.
  - `"weighted"`: `effectiveWeight = Math.max(0, Math.trunc(c.config.weight ?? 0)) + 1`; roll `random() * total`, trừ dần, trả channel khi roll < 0 (fallback phần tử cuối).
  - `"round-robin"`: sort bản copy theo `key` tăng dần; signature `ordered.map(c => c.key).join("\u0000")`; lấy cursor `% ordered.length`, tăng cursor, đưa signature về cuối Map, cap 256 entry.

### 4. Resolver dùng catalog đã compile + routing

`src/providers/shared/channel-resolver.ts`:

- Xóa `pickHighestPriorityChannel` và export này.
- `ChannelResolution` thêm `routing: ChannelRoutingConfig`.
- Vòng lặp channel:
  - `const config = row.config;` (không `JSON.parse`, không `normalizeChannelConfig`).
  - `const mapping = findModelMapping(config.models, requestedModel);`
  - Bỏ import `normalizeChannelConfig`, `findChannelModelMapping`, `pickHighestPriorityChannel`.
- Sau khi lọc quota và x-channel-key: `const routing = (await getSystemConfig(c)).routing;` (import `getSystemConfig` từ `../../system-config`).
- `const selectedChannel = selectChannel(availableChannels, routing.strategy);`
- Trả thêm `routing` trong object kết quả.

`src/utils.ts`:

```ts
export const findModelMapping = (
    models: ChannelModelMapping[],
    model: string,
): ChannelModelMapping | null
```

- Pass 1 exact case-insensitive, pass 2 wildcard, chỉ xét `enabled !== false`.
- `findChannelModelMapping` giữ nguyên chữ ký và gọi `findModelMapping(getChannelModels(config), model)`.
- `getChannelModels` giữ nguyên cho `pricing-sync.ts`.

### 5. Engine retry/fallback dùng routing

`src/providers/shared/upstream-retry.ts`:

- Xóa `RETRYABLE_STATUS_CODES`, import `MAX_CHANNEL_RETRIES`/`MAX_CHANNEL_FALLBACKS`, `normalizeChannelConfig`, `shuffleKeys`, `pickHighestPriorityChannel`.
- Import `selectChannel`, `markChannelSuccess`, `markChannelFailure` từ `./channel-selection`.
- `pickInitialKey(config: NormalizedChannelConfig)` trả `pickRandomItem(config.api_keys) ?? null` (không shuffle cả mảng).
- `pickRetryKey(config: NormalizedChannelConfig, currentKey, usedKeys)` giữ logic chọn key chưa dùng, bỏ normalize.
- `buildChannelRequestBody(...)` gọi **một lần cho mỗi channel**, trước vòng attempt.
- `waitForRetry(backoffMs: number, attemptIndex: number)`:
  - `delay = Math.min(backoffMs * 2 ** attemptIndex, 10_000)`; `delay <= 0` trả ngay.
  - chờ `delay + Math.floor(Math.random() * 50)` ms bằng `setTimeout` (không cần import).
- Export `executeChannelWithRetries` với chữ ký thêm tham số cuối:

```ts
export const executeChannelWithRetries = async (
    c: Context<HonoCustomType>,
    channel: ResolvedChannelCandidate,
    requestBody: any,
    saveUsage: (usage: Usage) => Promise<void>,
    trackingState: RequestTrackingState,
    provider: ProviderFetch,
    routeId: RouteId,
    routing: ChannelRoutingConfig,
): Promise<ChannelExecutionResult>
```

  - `const config = channel.config;`
  - `const retryStatusCodes = new Set(routing.retryStatusCodes);`
  - `const maxAttempts = 1 + (config.auto_retry ? routing.maxRetries : 0);`
  - `response.ok` → `markChannelSuccess(channel.key)` rồi trả.
  - `!retryStatusCodes.has(response.status)` → trả `shouldFallback: false`, **không** cooldown.
  - Còn attempt: discard response, `await waitForRetry(routing.retryBackoffMs, attemptIndex)`, đổi key, `trackingState.retryCount += 1`.
  - Hết attempt do status retryable hoặc exception: `markChannelFailure(channel.key, routing.cooldownMs)` trước khi trả.
  - Channel thiếu API key: giữ lỗi hiện tại, không cooldown.
- `pickNextFallbackChannel(channels, attemptedChannelKeys, routing)` → `selectChannel(remaining, routing.strategy)`.
- `executeWithFallbackChannels` thêm tham số cuối `routing: ChannelRoutingConfig` sau `routeId`:
  - Thay `MAX_CHANNEL_FALLBACKS` bằng `routing.maxFallbacks`.
  - Trước khi chuyển channel kế tiếp (cả nhánh provider không hỗ trợ và nhánh fallback sau lỗi): nếu còn channel kế và `routing.retryBackoffMs > 0`, `await waitForRetry(routing.retryBackoffMs, fallbackCount)`.
  - Không đánh cooldown cho lỗi "Channel type not supported" (lỗi cấu hình, không phải lỗi upstream).

`src/providers/index.ts`: destructure `routing` từ `resolveChannel` result và truyền vào `executeWithFallbackChannels(..., routeId, routing)`.

`src/channel-config.ts`: xóa `MAX_CHANNEL_RETRIES`, `MAX_CHANNEL_FALLBACKS`. Kiểm tra `rg "MAX_CHANNEL_RETRIES|MAX_CHANNEL_FALLBACKS|pickHighestPriorityChannel" src` phải không còn kết quả.

### 6. Models endpoint dùng catalog

`src/providers/models.ts`:

- Bỏ `normalizeChannelConfig`, `getChannelModels`; dùng `row.config`.
- `for (const model of config.models) { if (model.enabled === false) continue; ... }`.

### 7. Frontend types + normalize

`frontend/src/types/index.ts`: thêm `ChannelRoutingStrategy`, `ChannelRoutingConfig`; `SystemConfig.routing`.

`frontend/src/lib/system-config.ts`:

- `DEFAULT_CHANNEL_ROUTING_CONFIG` giống server.
- `normalizeChannelRoutingConfig` mirror đúng quy tắc server (kể cả array rỗng giữ rỗng).
- `normalizeSystemConfig` thêm `routing`.
- `DEFAULT_SYSTEM_CONFIG` thêm `routing`.

### 8. UI System Settings

`frontend/src/pages/SystemSettings.tsx`:

- Import `Select`, icon `Shuffle` từ `lucide-react`, `normalizeChannelRoutingConfig`.
- Thêm local component `NumberSetting({ id, label, hint, value, min, max, step, onChange })` dùng `<Input type="number">`, đặt ở file scope (không export).
- Thêm state `retryCodesText` khởi tạo từ default; effect đồng bộ khi `systemConfigQuery.data` fetch xong (join `", "`).
- Hàm `updateRouting(patch: Partial<ChannelRoutingConfig>)` gọi `setSystemConfig(current => ({ ...current, routing: normalizeChannelRoutingConfig({ ...current.routing, ...patch }) }))`.
- Section mới (đặt giữa Telegram và Display Precision), dùng `ButtonGroup` hoặc `Select` cho strategy:
  - Strategy: `priority` / `weighted` / `round-robin`.
  - `maxRetries` 0..10, `maxFallbacks` 0..10, `retryBackoffMs` 0..5000 step 50, `cooldownMs` 0..300000 step 1000.
  - `retryStatusCodes`: `<Input value={retryCodesText}>`; onChange cập nhật text và parse tách bằng `/[,\s]+/`, giữ số nguyên 100..599; list rỗng hợp lệ.
  - Hint mô tả: priority = tier weight cao nhất rồi random; weighted = random theo `weight + 1`; round-robin = xoay vòng toàn bộ channel; cooldown chỉ trong Worker instance hiện tại; status list rỗng tắt retry theo HTTP status.
- Auto-save hiện có tự lưu qua `saveSystemConfig`.

### 9. i18n

Thêm key vào `frontend/src/i18n/locales/en.json`, `zh-CN.json`, `zh-TW.json` dưới `settings`:

`routing`, `routingDesc`, `routingStrategy`, `routingStrategyPriority`, `routingStrategyWeighted`, `routingStrategyRoundRobin`, `routingStrategyHint`, `maxRetries`, `maxRetriesHint`, `maxFallbacks`, `maxFallbacksHint`, `retryBackoff`, `retryBackoffHint`, `failureCooldown`, `failureCooldownHint`, `retryStatusCodes`, `retryStatusCodesHint`.

Nội dung tiếng Anh chuẩn:

- `routing`: "Channel Routing"
- `routingDesc`: "How requests are distributed across channels and retried after failures."
- `routingStrategyHint`: "Priority: highest weight tier, random within the tier. Weighted: random proportional to weight + 1. Round robin: rotate across all eligible channels."
- `maxRetriesHint`: "Additional attempts per channel after the first failure. Only applies when the channel enables Auto Retry."
- `maxFallbacksHint`: "Maximum other channels to try after the current channel fails."
- `retryBackoffHint`: "Base delay before a retry. Doubles per attempt, capped at 10 seconds. 0 disables waiting."
- `failureCooldownHint`: "Skip a failing channel for this long in the current Worker instance. 0 disables cooldown."
- `retryStatusCodesHint`: "Comma-separated HTTP status codes that trigger retry or failover. Empty disables status-based retries."

Cập nhật `channels.autoRetryHint` (3 locale) thành "Automatically retry up to the configured retry limit on retryable errors" (bản Trung tương ứng), vì không còn cố định 3 lần. Cập nhật `channels.channelWeightHint` thành "Higher weight is preferred under the priority strategy and increases selection chance under the weighted strategy."

### 10. Test

`tests/channel-cache.test.ts`:

- Đổi type `keysOf` sang `{ results?: { key: string }[] }`.
- Thêm một channel fixture có `{"name":"c","weight":3,"auto_retry":false}` và assert `config.weight === 3`, `config.auto_retry === false` trên kết quả `fetchChannelsForToken`.
- Assert hai lần gọi `fetchChannelsForToken` với token không giới hạn channel trả cùng một object (`toBe`) để chứng minh loader compile chỉ chạy một lần.

Tạo `tests/channel-routing.test.ts`:

- `normalizeSystemConfig({})` có routing default; clamp `maxRetries: 99` → 10, `cooldownMs: -1` → 0; dedupe/sort status codes; `retryStatusCodes: []` giữ `[]`.
- `selectChannel` priority: weights `[0,3,3]`, `random: () => 0` trả channel weight 3 đầu tiên; `random: () => 0.99` trả channel weight 3 còn lại.
- `selectChannel` weighted: weights `[0,5]`, `random: () => 0` trả weight 0; `random: () => 0.99` trả weight 5.
- `selectChannel` round-robin: gọi 3 lần với `[a,b,c]` trả `a,b,c`; gọi `resetChannelSelectionState()` giữa các test.
- Cooldown: `markChannelFailure("a", 1000, 1000)`; `selectChannel([a,b], "priority", { now: 1500 })` trả `b`; `{ now: 2001 }` lại có thể trả `a`; `markChannelSuccess("a")` xóa cooldown.
- `executeChannelWithRetries`: fake provider trả 500, 500, 200; routing `{ retryBackoffMs: 0, cooldownMs: 0, maxRetries: 3, retryStatusCodes: [500] }` → provider gọi 3 lần, response ok, `retryCount === 2`.
- `executeChannelWithRetries`: fake provider trả 400 với `retryStatusCodes: [500]` → gọi 1 lần, `shouldFallback === false`.
- `executeChannelWithRetries`: `auto_retry: false`, provider trả 500 → gọi 1 lần.
- `executeWithFallbackChannels`: hai channel type `"unknown"` (provider không tồn tại), ghi lại `setActiveChannel`; `maxFallbacks: 0` → chỉ `["a"]`; `maxFallbacks: 1` → `["a","b"]`; response 400.

## File trọng tâm

- `src/providers/shared/upstream-retry.ts` — vòng retry/fallback, backoff, cooldown, giới hạn cấu hình.
- `src/providers/shared/channel-resolver.ts` — dùng catalog compile, chọn channel theo strategy, trả `routing`.
- `src/providers/shared/auth.ts` — compile + cache `NormalizedChannelConfig`.
- `src/system-config.ts` — default/normalize routing; `src/admin/system_api.ts` — schema API.
- `frontend/src/pages/SystemSettings.tsx` — UI cấu hình; `frontend/src/lib/system-config.ts` — default/normalize phía client.

## Xác minh

Chạy tại repo root:

```bash
bun run typecheck
cd frontend && bun run lint
bun test tests/channel-routing.test.ts tests/channel-cache.test.ts tests/telegram-config.test.ts
bun test tests
```

Kỳ vọng:

- `channel-routing.test.ts` pass toàn bộ; `telegram-config.test.ts` pass dù POST body không có `routing` (chứng minh tương thích ngược).
- `channel-cache.test.ts`: số lần query `channel_config` vẫn là 1 cho nhiều request; config trả về đã normalize.

Kiểm tra UI thủ công:

```bash
bun run dev
```

Mở Settings, đổi strategy sang `weighted`, `maxRetries` = 5, `cooldownMs` = 60000, status codes = `429,500,503`; reload trang và xác nhận giá trị được giữ. Đặt status codes rỗng, lưu, mở lại và xác nhận vẫn rỗng.

## Giả định

- Giữ nguyên per-channel `weight` (0..5), `auto_retry`, `auto_rotate`; không thêm override retry riêng từng channel.
- `priority` là default để không đổi hành vi hiện có; `weighted`/`round-robin` do admin chọn.
- Cooldown và round-robin là state per-isolate (best-effort), không đồng bộ giữa các isolate/colo; khi tất cả channel đang cooldown, hệ thống vẫn chọn trong toàn bộ danh sách thay vì trả lỗi.
- Không thêm timeout cho upstream request trong phạm vi này; retry chỉ xử lý HTTP status cấu hình và exception từ `fetch`.
