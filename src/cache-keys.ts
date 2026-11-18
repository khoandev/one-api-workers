/**
 * Cache keys shared by the isolate cache (L1) and the KV cache (L2). Logical
 * keys match the historical isolate keys so versioning stays explicit in
 * `kv-cache.ts` (`KV_CACHE_VERSION`) rather than in each caller.
 */
export const CACHE_KEYS = {
    channelCatalog: "channel_config:all",
    setting: (key: string) => `setting:json:${key}`,
    analyticsColumns: (dataset: string) => `analytics:columns:${dataset}`,
    analyticsDashboard: (range: string) => `analytics:dashboard:${range}`,
} as const;
