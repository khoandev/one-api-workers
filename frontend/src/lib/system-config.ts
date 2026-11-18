import {
  type AdminSecurityConfig,
  type ApiDocsConfig,
  type ChannelRoutingConfig,
  type ChannelRoutingStrategy,
  type SystemConfig,
} from "@/types";
import {
  DEFAULT_BILLING_DISPLAY_DECIMALS,
  normalizeBillingDisplayDecimals,
} from "@/lib/billing";

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
  max: number,
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

export const normalizeChannelRoutingConfig = (
  value?: Partial<ChannelRoutingConfig> | null,
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
      10,
    ),
    maxFallbacks: normalizeRangedInteger(
      value?.maxFallbacks,
      DEFAULT_CHANNEL_ROUTING_CONFIG.maxFallbacks,
      0,
      10,
    ),
    retryBackoffMs: normalizeRangedInteger(
      value?.retryBackoffMs,
      DEFAULT_CHANNEL_ROUTING_CONFIG.retryBackoffMs,
      0,
      5000,
    ),
    cooldownMs: normalizeRangedInteger(
      value?.cooldownMs,
      DEFAULT_CHANNEL_ROUTING_CONFIG.cooldownMs,
      0,
      300_000,
    ),
    retryStatusCodes: normalizeRetryStatusCodes(value?.retryStatusCodes),
  };
};

export const PRECISION_OPTIONS = [
  { label: "2", value: 2 },
  { label: "4", value: 4 },
  { label: "6", value: 6 },
] as const;

const normalizeString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

export const normalizeAdminSecurityConfig = (value?: Partial<AdminSecurityConfig> | null): AdminSecurityConfig => {
  return {
    enabled: value?.enabled === true,
    telegramBotToken: normalizeString(value?.telegramBotToken),
    telegramChatId: normalizeString(value?.telegramChatId),
    verifiedFingerprint: normalizeString(value?.verifiedFingerprint),
    verifiedAt: typeof value?.verifiedAt === "string" && value.verifiedAt.trim().length > 0
      ? value.verifiedAt.trim()
      : null,
  };
};

export const normalizeApiDocsConfig = (value?: Partial<ApiDocsConfig> | null): ApiDocsConfig => {
  return {
    enabled: value?.enabled ?? DEFAULT_API_DOCS_CONFIG.enabled,
  };
};

export const normalizeSystemConfig = (value?: Partial<SystemConfig> | null): SystemConfig => {
  return {
    displayDecimals: normalizeBillingDisplayDecimals(value?.displayDecimals),
    adminSecurity: normalizeAdminSecurityConfig(value?.adminSecurity),
    apiDocs: normalizeApiDocsConfig(value?.apiDocs),
    routing: normalizeChannelRoutingConfig(value?.routing),
  };
};

export const isTelegramSecurityEnabled = (config?: Partial<AdminSecurityConfig> | null): boolean => {
  return config?.enabled === true
    && typeof config.telegramBotToken === "string"
    && config.telegramBotToken.trim().length > 0
    && typeof config.telegramChatId === "string"
    && config.telegramChatId.trim().length > 0;
};

export const isTelegramSecurityVerified = (config?: Partial<AdminSecurityConfig> | null): boolean => {
  return typeof config?.verifiedFingerprint === "string"
    && config.verifiedFingerprint.trim().length > 0
    && typeof config?.verifiedAt === "string"
    && config.verifiedAt.trim().length > 0;
};

export const clearTelegramSecurityVerification = (
  config: AdminSecurityConfig,
): AdminSecurityConfig => {
  return {
    ...config,
    enabled: false,
    verifiedFingerprint: "",
    verifiedAt: null,
  };
};
