import { Context } from "hono";
import { CACHE_KEYS } from "./cache-keys";
import { normalizeChannelConfig } from "./channel-config";
import { cachedKvValue, invalidateCachedKvValue } from "./kv-cache";

const SETTING_CACHE_MAX_AGE_MS = 5 * 60_000;

const getJsonObjectValue = <T = any>(
    value: string | any
): T | null => {
    if (value == undefined || value == null) {
        return null;
    }
    if (typeof value === "object") {
        return value as T;
    }
    if (typeof value !== "string") {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`GetJsonValue: Failed to parse ${value}`, e);
    }
    return null;
}


export const getJsonSetting = async <T = any>(
    c: Context<HonoCustomType>, key: string
): Promise<T | null> => {
    const value = await cachedKvValue(
        c,
        CACHE_KEYS.setting(key),
        SETTING_CACHE_MAX_AGE_MS,
        () => getSetting(c, key)
    );
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`GetJsonSetting: Failed to parse ${key}`, e);
    }
    return null;
}

export const getSetting = async (
    c: Context<HonoCustomType>, key: string
): Promise<string | null> => {
    try {
        const value = await c.env.DB.prepare(
            `SELECT value FROM settings where key = ?`
        ).bind(key).first<string>("value");
        return value;
    } catch (error) {
        console.error(`GetSetting: Failed to get ${key}`, error);
    }
    return null;
}

export const saveSetting = async (
    c: Context<HonoCustomType>,
    key: string, value: string
) => {
    await c.env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)`
        + ` ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
    ).bind(key, value, value).run();
    await invalidateCachedKvValue(c, CACHE_KEYS.setting(key));
    return true;
}

/**
 * 通配符匹配函数
 * 支持 * 匹配任意字符
 * 例如: "claude-*" 匹配 "claude-opus-4", "*claude*" 匹配 "my-claude-model"
 */
export const wildcardMatch = (pattern: string, str: string): boolean => {
    // 精确匹配优先
    if (pattern === str) return true;
    // 没有通配符则不匹配
    if (!pattern.includes('*')) return false;

    // 将通配符模式转换为正则表达式
    const regexPattern = pattern
        .split('*')
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(str);
}

/**
 * 从 deployment_mapper 中查找匹配的部署名称
 * 支持精确匹配和通配符匹配
 * 返回 { pattern, deployment } 或 null
 */
export const findDeploymentMapping = (
    deploymentMapper: Record<string, string> | undefined,
    model: string
): { pattern: string; deployment: string } | null => {
    if (!deploymentMapper) return null;

    // 1. 精确匹配优先（大小写不敏感）
    const normalizedModel = model.toLowerCase();
    for (const [pattern, deployment] of Object.entries(deploymentMapper)) {
        if (pattern.toLowerCase() === normalizedModel) {
            return { pattern, deployment };
        }
    }

    // 2. 通配符匹配
    for (const pattern of Object.keys(deploymentMapper)) {
        if (pattern.includes('*') && wildcardMatch(pattern, model)) {
            return { pattern, deployment: deploymentMapper[pattern] };
        }
    }

    return null;
}

export const getChannelModels = (
    config: Partial<Pick<ChannelConfig, "models" | "supported_models" | "deployment_mapper">>
): ChannelModelMapping[] => {
    return normalizeChannelConfig(config as Partial<ChannelConfig>).models
        .filter((channelModel) => channelModel.enabled !== false);
}

/**
 * Looks up an enabled model mapping on an already-normalized model list. Exact
 * matches win over wildcards; disabled mappings never match.
 */
export const findModelMapping = (
    models: ChannelModelMapping[],
    model: string,
): ChannelModelMapping | null => {
    const normalizedModel = model.toLowerCase();
    for (const channelModel of models) {
        if (channelModel.enabled === false) {
            continue;
        }
        if (channelModel.name.toLowerCase() === normalizedModel) {
            return channelModel;
        }
    }

    for (const channelModel of models) {
        if (channelModel.enabled === false) {
            continue;
        }
        if (channelModel.name.includes('*') && wildcardMatch(channelModel.name, model)) {
            return channelModel;
        }
    }

    return null;
}

export const findChannelModelMapping = (
    config: Partial<Pick<ChannelConfig, "models" | "supported_models" | "deployment_mapper">>,
    model: string
): ChannelModelMapping | null => {
    return findModelMapping(getChannelModels(config), model);
}

export const findSupportedModel = (
    supportedModels: string[] | undefined,
    model: string
): string | null => {
    if (!supportedModels || supportedModels.length === 0) return null;

    // 精确匹配（大小写不敏感）
    const normalizedModel = model.toLowerCase();
    for (const supportedModel of supportedModels) {
        if (supportedModel.toLowerCase() === normalizedModel) {
            return supportedModel;
        }
    }

    for (const pattern of supportedModels) {
        if (pattern.includes('*') && wildcardMatch(pattern, model)) {
            return pattern;
        }
    }

    return null;
}

export const getSupportedModels = (
    config: Pick<ChannelConfig, "models" | "supported_models" | "deployment_mapper">
): string[] => {
    return getChannelModels(config).map((channelModel) => channelModel.name);
}
