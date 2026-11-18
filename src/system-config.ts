import { Context } from "hono";

import {
    DEFAULT_BILLING_DISPLAY_DECIMALS,
    normalizeBillingDisplayDecimals,
} from "./billing";
import { CONSTANTS } from "./constants";
import { getJsonSetting, saveSetting } from "./utils";

export const DEFAULT_ADMIN_SECURITY_CONFIG: AdminSecurityConfig = {
    enabled: false,
    telegramBotToken: "",
    telegramChatId: "",
    verifiedFingerprint: "",
    verifiedAt: null,
};

export const DEFAULT_API_DOCS_CONFIG: ApiDocsConfig = {
    enabled: true,
};

export const DEFAULT_CHANNEL_ROUTING_CONFIG: ChannelRoutingConfig = {
    strategy: "priority",
    maxRetries: 3,
    maxFallbacks: 3,
    retryBackoffMs: 200,
    cooldownMs: 30_000,
    retryStatusCodes: [401, 403, 408, 409, 429, 500, 502, 503, 504, 529],
};

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
    displayDecimals: DEFAULT_BILLING_DISPLAY_DECIMALS,
    adminSecurity: DEFAULT_ADMIN_SECURITY_CONFIG,
    apiDocs: DEFAULT_API_DOCS_CONFIG,
    routing: DEFAULT_CHANNEL_ROUTING_CONFIG,
};

const ROUTING_STRATEGIES: ChannelRoutingStrategy[] = ["priority", "weighted", "round-robin"];

const normalizeRangedInteger = (
    value: unknown,
    fallback: number,
    min: number,
    max: number
): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
};

const normalizeRetryStatusCodes = (value: unknown): number[] => {
    if (!Array.isArray(value)) {
        return [...DEFAULT_CHANNEL_ROUTING_CONFIG.retryStatusCodes];
    }

    const codes = new Set<number>();
    for (const entry of value) {
        if (typeof entry === "number" && Number.isFinite(entry)) {
            const code = Math.trunc(entry);
            if (code >= 100 && code <= 599) {
                codes.add(code);
            }
        }
    }

    return [...codes].sort((left, right) => left - right);
};

const normalizeBoolean = (value: unknown, fallback = false): boolean => {
    return typeof value === "boolean" ? value : fallback;
};

const normalizeString = (value: unknown): string => {
    return typeof value === "string" ? value.trim() : "";
};

const normalizeNullableString = (value: unknown): string | null => {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
};

export const buildTelegramVerificationFingerprint = (
    telegramBotToken: string,
    telegramChatId: string
): string => {
    const source = `${telegramBotToken.trim()}::${telegramChatId.trim()}`;
    let hash = 2166136261;

    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return source ? `tgv1-${(hash >>> 0).toString(16)}` : "";
};

export const normalizeAdminSecurityConfig = (
    value: Partial<AdminSecurityConfig> | null | undefined
): AdminSecurityConfig => {
    const telegramBotToken = normalizeString(value?.telegramBotToken);
    const telegramChatId = normalizeString(value?.telegramChatId);
    const expectedFingerprint = buildTelegramVerificationFingerprint(
        telegramBotToken,
        telegramChatId
    );
    const verifiedFingerprint = normalizeString(value?.verifiedFingerprint);
    const verifiedAt = normalizeNullableString(value?.verifiedAt);
    const isVerified = Boolean(
        expectedFingerprint
        && verifiedFingerprint
        && verifiedFingerprint === expectedFingerprint
        && verifiedAt
    );

    return {
        enabled: normalizeBoolean(value?.enabled) && isVerified,
        telegramBotToken,
        telegramChatId,
        verifiedFingerprint: isVerified ? verifiedFingerprint : "",
        verifiedAt: isVerified ? verifiedAt : null,
    };
};

export const normalizeApiDocsConfig = (
    value: Partial<ApiDocsConfig> | null | undefined
): ApiDocsConfig => {
    return {
        enabled: normalizeBoolean(value?.enabled, DEFAULT_API_DOCS_CONFIG.enabled),
    };
};

export const normalizeChannelRoutingConfig = (
    value: Partial<ChannelRoutingConfig> | null | undefined
): ChannelRoutingConfig => {
    const strategy = ROUTING_STRATEGIES.includes(value?.strategy as ChannelRoutingStrategy)
        ? value?.strategy as ChannelRoutingStrategy
        : DEFAULT_CHANNEL_ROUTING_CONFIG.strategy;

    return {
        strategy,
        maxRetries: normalizeRangedInteger(
            value?.maxRetries,
            DEFAULT_CHANNEL_ROUTING_CONFIG.maxRetries,
            0,
            10
        ),
        maxFallbacks: normalizeRangedInteger(
            value?.maxFallbacks,
            DEFAULT_CHANNEL_ROUTING_CONFIG.maxFallbacks,
            0,
            10
        ),
        retryBackoffMs: normalizeRangedInteger(
            value?.retryBackoffMs,
            DEFAULT_CHANNEL_ROUTING_CONFIG.retryBackoffMs,
            0,
            5000
        ),
        cooldownMs: normalizeRangedInteger(
            value?.cooldownMs,
            DEFAULT_CHANNEL_ROUTING_CONFIG.cooldownMs,
            0,
            300_000
        ),
        retryStatusCodes: normalizeRetryStatusCodes(value?.retryStatusCodes),
    };
};

export const normalizeSystemConfig = (
    value: Partial<SystemConfig> | null | undefined
): SystemConfig => {
    return {
        displayDecimals: normalizeBillingDisplayDecimals(value?.displayDecimals),
        adminSecurity: normalizeAdminSecurityConfig(value?.adminSecurity),
        apiDocs: normalizeApiDocsConfig(value?.apiDocs),
        routing: normalizeChannelRoutingConfig(value?.routing),
    };
};

export const isTelegramSecurityEnabled = (
    value: AdminSecurityConfig | SystemConfig | null | undefined
): boolean => {
    const security = value && "adminSecurity" in value
        ? value.adminSecurity
        : value;

    if (!security) {
        return false;
    }

    return security.enabled
        && security.telegramBotToken.length > 0
        && security.telegramChatId.length > 0;
};

export const getSystemConfig = async (
    c: Context<HonoCustomType>
): Promise<SystemConfig> => {
    const systemConfig = await getJsonSetting<SystemConfig>(
        c,
        CONSTANTS.SYSTEM_CONFIG_KEY
    );

    if (systemConfig) {
        return normalizeSystemConfig(systemConfig);
    }

    const legacyBillingConfig = await getJsonSetting<BillingConfig>(
        c,
        CONSTANTS.BILLING_CONFIG_KEY
    );

    return normalizeSystemConfig({
        displayDecimals: legacyBillingConfig?.displayDecimals,
    });
};

export const saveSystemConfig = async (
    c: Context<HonoCustomType>,
    value: Partial<SystemConfig> | null | undefined
): Promise<SystemConfig> => {
    const config = normalizeSystemConfig(value);

    await saveSetting(
        c,
        CONSTANTS.SYSTEM_CONFIG_KEY,
        JSON.stringify(config)
    );

    await saveSetting(
        c,
        CONSTANTS.BILLING_CONFIG_KEY,
        JSON.stringify({
            displayDecimals: config.displayDecimals,
        } satisfies BillingConfig)
    );

    return config;
};
