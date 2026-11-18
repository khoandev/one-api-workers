import type { Context } from "hono";

import { CONSTANTS } from "./constants";
import { sanitizeChannelConfig } from "./channel-config";
import { sanitizePricingConfig } from "./pricing-config";
import { getChannelModels, getJsonSetting, saveSetting } from "./utils";

export const MODELS_DEV_PRICING_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 20_000;

const OFFICIAL_PROVIDER_IDS: Record<string, true> = {
    "openai": true, "azure": true, "anthropic": true, "google": true,
    "google-vertex": true, "google-vertex-anthropic": true, "deepseek": true,
    "mistral": true, "xai": true, "meta": true, "cohere": true,
    "amazon-bedrock": true, "groq": true, "cerebras": true,
    "fireworks-ai": true, "togetherai": true,
};

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

type Candidate = {
    provider: string;
    modelKey: string;
    input: number;
    output: number;
    cache?: number;
};

type ModelsDevIndex = {
    index: Map<string, Candidate[]>;
    providerCount: number;
};

export type PricingSyncMergeResult = {
    config: Record<string, Partial<ModelPricing>>;
    updated: string[];
    skipped: string[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readCostValue = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export const normalizePricingModelKey = (value: string): string =>
    value.trim().toLowerCase()
        .replace(/[_.\s]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-|-$/g, "");

const addIndexEntry = (
    index: Map<string, Candidate[]>,
    rawKey: unknown,
    candidate: Candidate,
) => {
    if (typeof rawKey !== "string") {
        return;
    }

    const trimmedKey = rawKey.trim();
    if (!trimmedKey) {
        return;
    }

    const keys = [trimmedKey];
    const slashIndex = trimmedKey.lastIndexOf("/");
    if (slashIndex >= 0 && slashIndex < trimmedKey.length - 1) {
        keys.push(trimmedKey.slice(slashIndex + 1));
    }

    keys.map(normalizePricingModelKey).filter(Boolean).forEach((key) => {
        const bucket = index.get(key);
        if (!bucket) {
            index.set(key, [candidate]);
            return;
        }

        const duplicate = bucket.some(
            (entry) => entry.provider === candidate.provider && entry.modelKey === candidate.modelKey,
        );
        if (!duplicate) {
            bucket.push(candidate);
        }
    });
};

export const buildModelsDevIndex = (payload: unknown): ModelsDevIndex => {
    if (!isPlainObject(payload)) {
        throw new Error("Invalid models.dev response");
    }

    const index = new Map<string, Candidate[]>();
    let providerCount = 0;

    Object.entries(payload).forEach(([providerKey, providerValue]) => {
        if (!isPlainObject(providerValue) || !isPlainObject(providerValue.models)) {
            return;
        }

        providerCount += 1;
        const providerId = providerKey
            || (typeof providerValue.id === "string" ? providerValue.id.trim() : "");

        Object.entries(providerValue.models).forEach(([modelKey, modelValue]) => {
            if (!isPlainObject(modelValue)) {
                return;
            }

            const cost = isPlainObject(modelValue.cost) ? modelValue.cost : null;
            const input = cost ? readCostValue(cost.input) : 0;
            const output = cost ? readCostValue(cost.output) : 0;
            const cacheRead = cost ? readCostValue(cost.cache_read) : 0;

            // 免费模型无法在 pricing config 里表达，直接跳过。
            if (input <= 0 && output <= 0) {
                return;
            }

            const modelId = typeof modelValue.id === "string" && modelValue.id.trim()
                ? modelValue.id
                : modelKey;

            const candidate: Candidate = {
                provider: providerId || modelKey,
                modelKey: modelId,
                input,
                output,
            };
            if (cacheRead > 0) {
                candidate.cache = cacheRead;
            }

            addIndexEntry(index, modelValue.id, candidate);
            addIndexEntry(index, modelKey, candidate);
            addIndexEntry(index, modelValue.canonical_model_id, candidate);
            addIndexEntry(index, modelValue.name, candidate);
        });
    });

    if (providerCount === 0) {
        throw new Error("Invalid models.dev response");
    }

    return { index, providerCount };
};

export const collectPricingSyncTargets = (
    channels: Array<{ value?: unknown }>,
    existingPricing: Record<string, Partial<ModelPricing>> | null | undefined,
): PricingSyncTarget[] => {
    const targets = new Map<string, Set<string>>();

    const addTarget = (model: string, channelType?: string) => {
        const normalizedModel = model.trim();
        if (!normalizedModel) {
            return;
        }

        const types = targets.get(normalizedModel) ?? new Set<string>();
        if (channelType) {
            types.add(channelType);
        }
        targets.set(normalizedModel, types);
    };

    channels.forEach((channel) => {
        const rawConfig = isPlainObject(channel) && isPlainObject(channel.value)
            ? channel.value as Partial<ChannelConfig>
            : null;
        if (!rawConfig) {
            return;
        }

        const normalized = sanitizeChannelConfig(rawConfig);
        if (normalized.enabled === false) {
            return;
        }

        const channelType = typeof normalized.type === "string" ? normalized.type.trim() : "";
        getChannelModels(normalized).forEach((model) => {
            addTarget(model.name, channelType || undefined);
        });
    });

    Object.keys(isPlainObject(existingPricing) ? existingPricing : {})
        .forEach((model) => addTarget(model));

    return Array.from(targets.entries())
        .map(([model, types]) => ({
            model,
            channelTypes: Array.from(types).sort((left, right) => left.localeCompare(right)),
        }))
        .sort((left, right) => left.model.localeCompare(right.model));
};

const getLookupKeys = (model: string): string[] => {
    const keys: string[] = [];
    const addKey = (value: string) => {
        const normalized = normalizePricingModelKey(value);
        if (normalized && !keys.includes(normalized)) {
            keys.push(normalized);
        }
    };

    addKey(model);

    const slashIndex = model.lastIndexOf("/");
    const tail = slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
    addKey(tail);

    const withoutRegion = tail.replace(/@.*$/, "");
    addKey(withoutRegion);

    addKey(withoutRegion.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, ""));

    return keys;
};

const pickCandidate = (candidates: Candidate[], channelTypes: string[]): Candidate => {
    const preferred: string[] = [];
    channelTypes.forEach((type) => {
        (CHANNEL_TYPE_PROVIDER_IDS[type] ?? []).forEach((providerId) => {
            if (!preferred.includes(providerId)) {
                preferred.push(providerId);
            }
        });
    });

    const rankOf = (candidate: Candidate): number => {
        const preferredIndex = preferred.indexOf(candidate.provider);
        if (preferredIndex >= 0) {
            return preferredIndex;
        }

        return OFFICIAL_PROVIDER_IDS[candidate.provider] === true
            ? preferred.length
            : preferred.length + 1;
    };

    const priceOrInfinity = (value: number): number =>
        value > 0 ? value : Number.POSITIVE_INFINITY;

    return [...candidates].sort((left, right) => {
        const rankDiff = rankOf(left) - rankOf(right);
        if (rankDiff !== 0) {
            return rankDiff;
        }

        const inputDiff = priceOrInfinity(left.input) - priceOrInfinity(right.input);
        if (inputDiff !== 0) {
            return inputDiff;
        }

        const outputDiff = priceOrInfinity(left.output) - priceOrInfinity(right.output);
        if (outputDiff !== 0) {
            return outputDiff;
        }

        const providerDiff = left.provider.localeCompare(right.provider);
        return providerDiff !== 0 ? providerDiff : left.modelKey.localeCompare(right.modelKey);
    })[0];
};

export const buildPricingSuggestions = (
    payload: unknown,
    targets: PricingSyncTarget[],
): PricingSyncPreview => {
    const { index, providerCount } = buildModelsDevIndex(payload);
    const suggestions: Record<string, PricingSyncSuggestion> = {};
    const unmatched: string[] = [];

    targets.forEach((target) => {
        const candidates: Candidate[] = [];
        getLookupKeys(target.model).forEach((key) => {
            (index.get(key) ?? []).forEach((candidate) => {
                const duplicate = candidates.some(
                    (entry) => entry.provider === candidate.provider && entry.modelKey === candidate.modelKey,
                );
                if (!duplicate) {
                    candidates.push(candidate);
                }
            });
        });

        if (candidates.length === 0) {
            unmatched.push(target.model);
            return;
        }

        const picked = pickCandidate(candidates, target.channelTypes);
        const suggestion: PricingSyncSuggestion = {
            input: picked.input,
            output: picked.output,
            provider: picked.provider,
        };
        if (picked.cache !== undefined) {
            suggestion.cache = picked.cache;
        }
        suggestions[target.model] = suggestion;
    });

    return {
        suggestions,
        unmatched: unmatched.sort((left, right) => left.localeCompare(right)),
        targetCount: targets.length,
        providerCount,
        fetchedAt: new Date().toISOString(),
    };
};

const hasExistingPricing = (pricing: Partial<ModelPricing> | undefined): boolean => {
    if (!pricing || typeof pricing !== "object") {
        return false;
    }

    const isPositive = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value > 0;

    return isPositive(pricing.input)
        || isPositive(pricing.output)
        || isPositive(pricing.cache)
        || isPositive(pricing.request)
        || pricing.billingMode === "request";
};

export const mergePricingSuggestions = (
    existing: Record<string, Partial<ModelPricing>> | null | undefined,
    suggestions: Record<string, PricingSyncSuggestion>,
    overwrite: boolean,
): PricingSyncMergeResult => {
    const config: Record<string, Partial<ModelPricing>> = {
        ...(isPlainObject(existing) ? existing : {}),
    };
    const updated: string[] = [];
    const skipped: string[] = [];

    Object.entries(suggestions).forEach(([model, suggestion]) => {
        if (!overwrite && hasExistingPricing(config[model])) {
            skipped.push(model);
            return;
        }

        const entry: Partial<ModelPricing> = { billingMode: "volume" };
        if (suggestion.input > 0) {
            entry.input = suggestion.input;
        }
        if (suggestion.output > 0) {
            entry.output = suggestion.output;
        }
        if (suggestion.cache !== undefined && suggestion.cache > 0) {
            entry.cache = suggestion.cache;
        }

        if (entry.input === undefined && entry.output === undefined && entry.cache === undefined) {
            skipped.push(model);
            return;
        }

        config[model] = entry;
        updated.push(model);
    });

    return {
        config: sanitizePricingConfig(config),
        updated: updated.sort((left, right) => left.localeCompare(right)),
        skipped: skipped.sort((left, right) => left.localeCompare(right)),
    };
};

const loadPricingSyncInputs = async (c: Context<HonoCustomType>) => {
    const rows = await c.env.DB.prepare(`SELECT key, value FROM channel_config`).all<{
        key: string;
        value: string;
    }>();

    const channels: Array<{ value?: unknown }> = [];
    (rows.results ?? []).forEach((row) => {
        if (typeof row?.value !== "string") {
            return;
        }

        try {
            const parsed = JSON.parse(row.value);
            if (isPlainObject(parsed)) {
                channels.push({ value: parsed });
            }
        } catch {
            // Malformed channel rows cannot contribute models.
        }
    });

    const storedPricing = await getJsonSetting<Record<string, Partial<ModelPricing>>>(
        c,
        CONSTANTS.MODEL_PRICING_KEY,
    );

    return { targets: collectPricingSyncTargets(channels, storedPricing) };
};

const fetchModelsDevPricing = async (): Promise<unknown> => {
    const response = await fetch(MODELS_DEV_PRICING_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`);
    }

    return await response.json();
};

export const buildPricingSyncPreview = async (
    c: Context<HonoCustomType>,
): Promise<PricingSyncPreview> => {
    const { targets } = await loadPricingSyncInputs(c);

    if (targets.length === 0) {
        return {
            suggestions: {},
            unmatched: [],
            targetCount: 0,
            providerCount: 0,
            fetchedAt: new Date().toISOString(),
        };
    }

    return buildPricingSuggestions(await fetchModelsDevPricing(), targets);
};

export const applyPricingSync = async (
    c: Context<HonoCustomType>,
    suggestions: Record<string, PricingSyncSuggestion>,
    overwrite: boolean,
): Promise<{ updated: string[]; skipped: string[] }> => {
    const storedPricing = await getJsonSetting<Record<string, Partial<ModelPricing>>>(
        c,
        CONSTANTS.MODEL_PRICING_KEY,
    );

    const { config, updated, skipped } = mergePricingSuggestions(storedPricing, suggestions, overwrite);

    if (updated.length > 0) {
        await saveSetting(c, CONSTANTS.MODEL_PRICING_KEY, JSON.stringify(config));
    }

    return { updated, skipped };
};

export const runScheduledPricingSync = async (c: Context<HonoCustomType>) => {
    const preview = await buildPricingSyncPreview(c);
    const { updated, skipped } = await applyPricingSync(c, preview.suggestions, false);

    return {
        targetCount: preview.targetCount,
        matched: Object.keys(preview.suggestions).length,
        updated: updated.length,
        skipped: skipped.length,
        unmatched: preview.unmatched.length,
    };
};
