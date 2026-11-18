import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, FileText, Shield, Shuffle, SlidersHorizontal } from "lucide-react";

import { apiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { BILLING_CONFIG_QUERY_KEY } from "@/hooks/use-billing-config";
import { SYSTEM_CONFIG_QUERY_KEY, useSystemConfig } from "@/hooks/use-system-config";
import { PageContainer } from "@/components/ui/page-container";
import {
  DEFAULT_CHANNEL_ROUTING_CONFIG,
  DEFAULT_SYSTEM_CONFIG,
  PRECISION_OPTIONS,
  clearTelegramSecurityVerification,
  isTelegramSecurityVerified,
  normalizeChannelRoutingConfig,
  normalizeSystemConfig,
} from "@/lib/system-config";
import type { ChannelRoutingConfig, SystemConfig } from "@/types";
import { useTranslation } from "react-i18next";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const AUTO_SAVE_DELAY_MS = 800;

type SaveSource = "auto" | "manual";
type SaveState = "idle" | "saving" | "saved" | "error";

const buildAbsoluteUrl = (pathname: string): string => {
  if (typeof window === "undefined") {
    return pathname;
  }

  const baseUrl = API_BASE_URL ? new URL(API_BASE_URL, window.location.origin) : new URL(window.location.origin);
  return new URL(pathname, baseUrl).toString();
};

const buildSystemConfigSignature = (config: SystemConfig): string => {
  return JSON.stringify(normalizeSystemConfig(config));
};

const formatSaveTime = (value: Date | null): string => {
  if (!value) {
    return "--:--:--";
  }

  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

type NumberSettingProps = {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
};

function NumberSetting({ id, label, hint, value, min, max, step = 1, onChange }: NumberSettingProps) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function SystemSettings() {
  const { t } = useTranslation();
  const [systemConfig, setSystemConfig] = useState(DEFAULT_SYSTEM_CONFIG);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [retryCodesText, setRetryCodesText] = useState(() =>
    DEFAULT_CHANNEL_ROUTING_CONFIG.retryStatusCodes.join(", "),
  );

  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const systemConfigQuery = useSystemConfig();
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasHydratedRef = useRef(false);
  const hasHydratedRetryCodesRef = useRef(false);
  const lastSavedSignatureRef = useRef(buildSystemConfigSignature(DEFAULT_SYSTEM_CONFIG));
  const currentSignatureRef = useRef(buildSystemConfigSignature(DEFAULT_SYSTEM_CONFIG));

  const normalizedSystemConfig = useMemo(() => normalizeSystemConfig(systemConfig), [systemConfig]);
  const currentSignature = useMemo(() => buildSystemConfigSignature(normalizedSystemConfig), [normalizedSystemConfig]);

  useEffect(() => {
    currentSignatureRef.current = currentSignature;
  }, [currentSignature]);

  useEffect(() => {
    if (!systemConfigQuery.isFetched || !systemConfigQuery.data) {
      return;
    }

    const normalized = normalizeSystemConfig(systemConfigQuery.data);
    lastSavedSignatureRef.current = buildSystemConfigSignature(normalized);
    hasHydratedRef.current = true;
    setSaveState("idle");
    setLastSavedAt(new Date());
    setSystemConfig(normalized);
  }, [systemConfigQuery.data, systemConfigQuery.isFetched]);

  // Hydrate the status code text once so later auto-saves never rewrite what the
  // user is still typing.
  useEffect(() => {
    if (hasHydratedRetryCodesRef.current || !systemConfigQuery.isFetched || !systemConfigQuery.data) {
      return;
    }

    hasHydratedRetryCodesRef.current = true;
    setRetryCodesText(
      normalizeChannelRoutingConfig(systemConfigQuery.data.routing).retryStatusCodes.join(", "),
    );
  }, [systemConfigQuery.data, systemConfigQuery.isFetched]);

  const updateRouting = (patch: Partial<ChannelRoutingConfig>) => {
    setSystemConfig((current) => ({
      ...current,
      routing: normalizeChannelRoutingConfig({ ...current.routing, ...patch }),
    }));
  };

  const handleRetryCodesChange = (value: string) => {
    setRetryCodesText(value);
    updateRouting({
      retryStatusCodes: value
        .split(/[,\s]+/)
        .map((part) => Number(part))
        .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599),
    });
  };

  const saveSystemConfigMutation = useMutation({
    mutationFn: async ({ config }: { config: SystemConfig; source: SaveSource; signature: string }) =>
      apiClient.saveSystemConfig(config),
    onMutate: ({ source }) => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      if (source === "auto") {
        setSaveState("saving");
      }
    },
    onSuccess: (response, variables) => {
      const savedConfig = normalizeSystemConfig((response.data as SystemConfig | undefined) ?? variables.config);
      const savedSignature = buildSystemConfigSignature(savedConfig);

      lastSavedSignatureRef.current = savedSignature;
      queryClient.setQueryData(SYSTEM_CONFIG_QUERY_KEY, savedConfig);
      queryClient.setQueryData(BILLING_CONFIG_QUERY_KEY, {
        displayDecimals: savedConfig.displayDecimals,
      });

      if (variables.signature === currentSignatureRef.current) {
        setSystemConfig(savedConfig);
      }

      setSaveState("saved");
      setLastSavedAt(new Date());

      if (variables.source === "manual") {
        addToast(t('settings.configSaved'), "success");
      }
    },
    onError: (error: Error, variables) => {
      setSaveState("error");
      if (variables.source === "manual") {
        addToast(t('common.saveFailed', { message: error.message }), "error");
      }
    },
  });

  const telegramTestMutation = useMutation({
    mutationFn: async () =>
      apiClient.sendTelegramTestMessage({
        telegramBotToken: normalizedSystemConfig.adminSecurity.telegramBotToken,
        telegramChatId: normalizedSystemConfig.adminSecurity.telegramChatId,
      }),
    onSuccess: (response) => {
      const verification = response.data;
      setSystemConfig((current) => ({
        ...current,
        adminSecurity: {
          ...current.adminSecurity,
          verifiedFingerprint: verification?.verifiedFingerprint || "",
          verifiedAt: verification?.verifiedAt || null,
        },
      }));
      addToast(t('settings.testMessageSent'), "success");
    },
    onError: (error: Error) => {
      addToast(t('settings.testFailed', { message: error.message }), "error");
    },
  });

  useEffect(() => {
    if (!hasHydratedRef.current) {
      return;
    }

    if (saveSystemConfigMutation.isPending) {
      return;
    }

    if (currentSignature === lastSavedSignatureRef.current) {
      if (saveState === "saving") {
        setSaveState("saved");
      }
      return;
    }

    autoSaveTimerRef.current = setTimeout(() => {
      saveSystemConfigMutation.mutate({
        config: normalizedSystemConfig,
        source: "auto",
        signature: currentSignature,
      });
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [currentSignature, normalizedSystemConfig, saveState, saveSystemConfigMutation]);

  const docsLinks = useMemo(
    () => [
      { label: "Swagger UI", href: buildAbsoluteUrl("/api/docs") },
      { label: "ReDoc", href: buildAbsoluteUrl("/api/redocs") },
      { label: "OpenAPI JSON", href: buildAbsoluteUrl("/api/openapi.json") },
    ],
    [],
  );

  const telegramConfigComplete =
    normalizedSystemConfig.adminSecurity.telegramBotToken.trim().length > 0 &&
    normalizedSystemConfig.adminSecurity.telegramChatId.trim().length > 0;
  const telegramSecurityVerified = isTelegramSecurityVerified(normalizedSystemConfig.adminSecurity);

  const saveHint = (() => {
    switch (saveState) {
      case "saving":
        return t('common.autoSaving');
      case "error":
        return t('common.autoSaveFailed');
      default:
        return t('common.savedAt', { time: formatSaveTime(lastSavedAt) });
    }
  })();

  const updateTelegramField = (field: "telegramBotToken" | "telegramChatId", value: string) => {
    setSystemConfig((current) => {
      const previousValue = current.adminSecurity[field];
      if (previousValue === value) {
        return current;
      }

      return {
        ...current,
        adminSecurity: clearTelegramSecurityVerification({
          ...current.adminSecurity,
          [field]: value,
        }),
      };
    });
  };

  const handleManualSave = () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    saveSystemConfigMutation.mutate({
      config: normalizedSystemConfig,
      source: "manual",
      signature: currentSignature,
    });
  };

  return (
    <PageContainer
      title={t('settings.title')}
      description={t('settings.description')}
      actions={
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{saveHint}</span>
          <Button
            size="sm"
            onClick={handleManualSave}
            disabled={saveSystemConfigMutation.isPending || systemConfigQuery.isLoading}
          >
            <Check className="mr-1 h-4 w-4" />
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <Card className="space-y-6 border-0 p-6">
        <section className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-muted-foreground/10 p-2 text-muted-foreground">
              <Shield className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold tracking-tight">{t('settings.telegramSecurity')}</h3>
                  {!normalizedSystemConfig.adminSecurity.enabled && telegramConfigComplete ? (
                    <p className="text-sm text-amber-600 dark:text-amber-300">
                      {t('settings.telegramNeedTest')}
                    </p>
                  ) : telegramSecurityVerified ? (
                    <p className="text-sm text-green-600 dark:text-green-300">{t('settings.telegramVerified')}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('settings.telegramNotVerified')}</p>
                  )}
                </div>
                <Switch
                  checked={normalizedSystemConfig.adminSecurity.enabled}
                  disabled={!telegramConfigComplete || !telegramSecurityVerified}
                  onCheckedChange={(checked) =>
                    setSystemConfig((current) => ({
                      ...current,
                      adminSecurity: {
                        ...current.adminSecurity,
                        enabled: checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="telegramBotToken">
                Bot Token
              </label>
              <Input
                id="telegramBotToken"
                type="password"
                placeholder="123456789:AA..."
                autoComplete="new-password"
                value={normalizedSystemConfig.adminSecurity.telegramBotToken}
                onChange={(event) => updateTelegramField("telegramBotToken", event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="telegramChatId">
                Chat ID
              </label>
              <Input
                id="telegramChatId"
                placeholder="-1001234567890"
                value={normalizedSystemConfig.adminSecurity.telegramChatId}
                onChange={(event) => updateTelegramField("telegramChatId", event.target.value)}
              />
            </div>
          </div>

          <div className="rounded-md border bg-muted/50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Bot className="h-4 w-4" />
                  {t('settings.sendTestMessage')}
                </div>
                <p className="text-xs text-muted-foreground/60">
                  {!telegramConfigComplete
                    ? t('settings.fillBotTokenFirst')
                    : telegramSecurityVerified
                      ? t('settings.lastVerified', { time: normalizedSystemConfig.adminSecurity.verifiedAt || "--" })
                      : t('settings.testUnlockHint')}
                </p>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={() => telegramTestMutation.mutate()}
                disabled={telegramTestMutation.isPending || !telegramConfigComplete}
              >
                {telegramTestMutation.isPending ? t('settings.sendTestMessageSending') : t('settings.sendTestMessage')}
              </Button>
            </div>
          </div>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-muted-foreground/10 p-2 text-muted-foreground">
              <Shuffle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold tracking-tight">{t('settings.routing')}</h3>
              <p className="text-sm text-muted-foreground">{t('settings.routingDesc')}</p>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium text-foreground">{t('settings.routingStrategy')}</span>
            <div>
              <ButtonGroup
                aria-label={t('settings.routingStrategy')}
                value={normalizedSystemConfig.routing.strategy}
                options={[
                  { label: t('settings.routingStrategyPriority'), value: "priority" as const },
                  { label: t('settings.routingStrategyWeighted'), value: "weighted" as const },
                  { label: t('settings.routingStrategyRoundRobin'), value: "round-robin" as const },
                ]}
                onValueChange={(value) => updateRouting({ strategy: value })}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.routingStrategyHint')}</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <NumberSetting
              id="routingMaxRetries"
              label={t('settings.maxRetries')}
              hint={t('settings.maxRetriesHint')}
              value={normalizedSystemConfig.routing.maxRetries}
              min={0}
              max={10}
              onChange={(value) => updateRouting({ maxRetries: value })}
            />
            <NumberSetting
              id="routingMaxFallbacks"
              label={t('settings.maxFallbacks')}
              hint={t('settings.maxFallbacksHint')}
              value={normalizedSystemConfig.routing.maxFallbacks}
              min={0}
              max={10}
              onChange={(value) => updateRouting({ maxFallbacks: value })}
            />
            <NumberSetting
              id="routingRetryBackoffMs"
              label={t('settings.retryBackoff')}
              hint={t('settings.retryBackoffHint')}
              value={normalizedSystemConfig.routing.retryBackoffMs}
              min={0}
              max={5000}
              step={50}
              onChange={(value) => updateRouting({ retryBackoffMs: value })}
            />
            <NumberSetting
              id="routingCooldownMs"
              label={t('settings.failureCooldown')}
              hint={t('settings.failureCooldownHint')}
              value={normalizedSystemConfig.routing.cooldownMs}
              min={0}
              max={300000}
              step={1000}
              onChange={(value) => updateRouting({ cooldownMs: value })}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="routingRetryStatusCodes">
              {t('settings.retryStatusCodes')}
            </label>
            <Input
              id="routingRetryStatusCodes"
              value={retryCodesText}
              placeholder="429, 500, 503"
              onChange={(event) => handleRetryCodesChange(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('settings.retryStatusCodesHint')}</p>
          </div>
        </section>

        <div className="h-px bg-border" />

        <section className="flex items-center gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-muted-foreground/10 p-2 text-muted-foreground">
              <SlidersHorizontal className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold tracking-tight">{t('settings.displayPrecision')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('settings.displayPrecisionDesc', {
                  decimals: normalizedSystemConfig.displayDecimals,
                  example: (0.123456789).toFixed(normalizedSystemConfig.displayDecimals),
                })}
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <ButtonGroup
            aria-label={t('settings.displayPrecision')}
            value={normalizedSystemConfig.displayDecimals}
            options={PRECISION_OPTIONS}
            onValueChange={(value) =>
              setSystemConfig((current) => ({
                ...current,
                displayDecimals: value,
              }))
            }
          />
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-muted-foreground/10 p-2 text-muted-foreground">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold tracking-tight">{t('settings.apiDocs')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.apiDocsDesc')}
                  </p>
                </div>
                <Switch
                  checked={normalizedSystemConfig.apiDocs.enabled}
                  onCheckedChange={(checked) =>
                    setSystemConfig((current) => ({
                      ...current,
                      apiDocs: {
                        ...current.apiDocs,
                        enabled: checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          </div>

          {normalizedSystemConfig.apiDocs.enabled ? (
            <div className="grid gap-3 lg:grid-cols-3">
              {docsLinks.map((item) => (
                <div
                  key={item.href}
                  className="flex flex-col gap-3 rounded-md border px-4 py-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{item.label}</div>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.href}</div>
                  </div>
                  <Button asChild variant="outline" className="h-8 px-3">
                    <a href={item.href} target="_blank" rel="noreferrer">
                      {t('common.open')}
                    </a>
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </Card>
    </PageContainer>
  );
}
