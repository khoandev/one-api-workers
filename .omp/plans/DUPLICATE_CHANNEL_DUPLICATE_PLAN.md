# Duplicate channel (one-click clone)

## Context

User wants duplicate-channel support. The Channels page currently offers only Edit and Delete per row (`frontend/src/pages/Channels.tsx`), and channel creation already exists as `POST /api/admin/channel/:key` (`ChannelUpsertEndpoint`). Chosen behavior: one-click clone with no form — copy the source channel config, generate a collision-free key `<key>-copy` (`-copy-2`, `-copy-3`, …), append ` (Copy)` to the name, save through the existing API, then toast and refresh the list. No backend change: the save endpoint already accepts a full config and the client already has `saveChannel`.

## Approach

### 1. Pure key generator + test

Create `frontend/src/lib/channel-duplicate.ts` (no equivalent exists; `frontend/src/lib/channel-models.ts` only filters channels):

```ts
export const DUPLICATE_CHANNEL_KEY_SUFFIX = "-copy";

export const buildDuplicateChannelKey = (sourceKey: string, existingKeys: Iterable<string>): string => {
  const takenKeys = new Set(existingKeys);
  let candidate = `${sourceKey}${DUPLICATE_CHANNEL_KEY_SUFFIX}`;
  let index = 2;

  while (takenKeys.has(candidate)) {
    candidate = `${sourceKey}${DUPLICATE_CHANNEL_KEY_SUFFIX}-${index}`;
    index += 1;
  }

  return candidate;
};
```

Create `tests/channel-duplicate.test.ts` (bun transpiles the frontend TS import; root typecheck excludes `tests`):

```ts
import { expect, test } from "bun:test";
import { buildDuplicateChannelKey } from "../frontend/src/lib/channel-duplicate";

test("appends -copy when the key is free", () => {
    expect(buildDuplicateChannelKey("azure-gpt4", ["azure-gpt4", "openai"])).toBe("azure-gpt4-copy");
});

test("increments the suffix until the key is free", () => {
    expect(buildDuplicateChannelKey("chan", ["chan", "chan-copy"])).toBe("chan-copy-2");
    expect(buildDuplicateChannelKey("chan", ["chan", "chan-copy", "chan-copy-2"])).toBe("chan-copy-3");
});
```

Edge: an empty `existingKeys` iterable yields `<key>-copy`; the loop is bounded by the number of taken keys, so it always terminates.

### 2. Duplicate mutation and handler

`frontend/src/pages/Channels.tsx`:

- Add `Copy` to the existing `lucide-react` import list (line 19–34).
- Add `import { buildDuplicateChannelKey } from "@/lib/channel-duplicate";` beside the other `@/lib` imports.
- After `deleteMutation` (line 662–673), add:

```tsx
const duplicateMutation = useMutation({
  mutationFn: async ({ key, config }: { key: string; config: ChannelConfig }) => {
    return apiClient.saveChannel(key, config);
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["channels"] });
    addToast(t("channels.duplicateSuccess"), "success");
  },
  onError: (error: Error) => {
    addToast(t("channels.duplicateFailed", { message: error.message }), "error");
  },
});
```

- Next to `handleDelete` (line 808–812), add:

```tsx
const handleDuplicate = (channel: Channel) => {
  const sourceConfig = normalizeChannelFormConfig(parseChannelValue(channel));
  const nextKey = buildDuplicateChannelKey(channel.key, (data ?? []).map((item) => item.key));
  const nextConfig: ChannelConfig = {
    ...sourceConfig,
    name: t("channels.duplicateName", { name: sourceConfig.name || channel.key }),
  };

  duplicateMutation.mutate({ key: nextKey, config: nextConfig });
};
```

`normalizeChannelFormConfig` already strips legacy `api_key`, `supported_models`, `deployment_mapper` and preserves `models`, `model_pricing`, `api_keys`, `weight`, `enabled`, `auto_retry`, `auto_rotate`, `type`, `endpoint`. The generated key comes from the already-loaded `data` list, so no extra fetch. `invalidateQueries({ queryKey: ["channels"] })` also refreshes Pricing's `["channels", "pricing"]` query by prefix match.

### 3. Wire the two row action surfaces

`frontend/src/pages/Channels.tsx`:

- Mobile dropdown (line 1243–1260): between the Edit and Delete buttons, insert

```tsx
<button
  className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
  disabled={duplicateMutation.isPending}
  onClick={() => handleDuplicate(channel)}
>
  <Copy className="h-4 w-4" />
  {t("channels.duplicateChannel")}
</button>
```

The existing document-level click listener closes the dropdown, so no explicit `setOpenMenu(null)` is needed.

- Desktop action group (line 1332–1344): between the Edit and Delete `Button`s, insert

```tsx
<Button
  variant="ghost"
  className="w-8 h-8"
  size="sm"
  disabled={duplicateMutation.isPending}
  aria-label={t("channels.duplicateChannel")}
  onClick={() => handleDuplicate(channel)}
>
  <Copy className="h-4 w-4" />
</Button>
```

`duplicateMutation.isPending` disables duplicate controls in all rows, which prevents a double click from computing the same `<key>-copy` twice before the list refetches (the second insert would overwrite the first via `ON CONFLICT`).

### 4. Locale keys

Add four keys inside the `"channels"` object of each locale, immediately after `"deleteConfirm"`:

- `frontend/src/i18n/locales/en.json` (line 130):
  `"duplicateChannel": "Duplicate Channel"`, `"duplicateName": "{{name}} (Copy)"`, `"duplicateSuccess": "Channel duplicated"`, `"duplicateFailed": "Failed to duplicate channel: {{message}}"`.
- `frontend/src/i18n/locales/zh-CN.json`: `"复制渠道"`, `"{{name}}（副本）"`, `"渠道复制成功"`, `"复制渠道失败：{{message}}"`.
- `frontend/src/i18n/locales/zh-TW.json`: `"複製渠道"`, `"{{name}}（副本）"`, `"渠道複製成功"`, `"複製渠道失敗：{{message}}"`.

The key suffix `-copy` stays literal (technical identifier); only the display name is localized.

## Critical files & anchors

- `frontend/src/pages/Channels.tsx` — module helpers (before line 559), mutations (line 662), `handleDelete` neighborhood (line 808), mobile menu (line 1243), desktop actions (line 1332).
- `frontend/src/lib/channel-duplicate.ts` — new pure key generator.
- `frontend/src/i18n/locales/en.json`, `zh-CN.json`, `zh-TW.json` — `channels` object.
- `tests/channel-duplicate.test.ts` — new test.

## Verification

1. `bun test tests/channel-duplicate.test.ts` → 2 tests pass (`azure-gpt4-copy`; `chan-copy-2`; `chan-copy-3`).
2. `bun run typecheck` → worker and frontend TypeScript pass.
3. `cd frontend && bun run lint` → no new warnings/errors.
4. `bun run build` → frontend bundle builds.
5. Manual UI check (instant-clone behavior):
   - `bun run dev` (Vite + local Worker), log into the admin UI, open Channels.
   - Desktop: click the new copy icon on channel `X` → toast "Channel duplicated"; the list gains key `X-copy`, name `X (Copy)`; open it with Edit and confirm endpoint, type, weight, API keys, models, and model pricing match the source.
   - Click copy on `X` again → new key `X-copy-2` (existing `X-copy` is skipped).
   - Mobile layout (or narrow viewport): open the row ⋯ menu → "Duplicate Channel" produces the same result.
   - Failure path: duplicate a channel whose config lacks API keys (if one exists) → error toast "Failed to duplicate channel: At least one API key is required", no row added.
   - Delete the created copies afterwards.

## Assumptions & contingencies

- Clone is immediate, as chosen; there is no review form and no new `POST .../duplicate` endpoint. If a review step is later wanted, reuse `/channels/new` with prefilled state instead of changing this flow.
- The copy keeps the source `enabled` value: an enabled copy participates in routing immediately with the same API keys. If copying disabled would be required, set `enabled: false` in `nextConfig`.
- Channels with an invalid/incomplete stored config fail server-side with the existing 400 message; the UI only surfaces `duplicateFailed` and adds no client-side pre-validation.
