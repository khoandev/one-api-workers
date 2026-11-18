import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/api/client";
import {
  AnalyticsDashboardData,
  AnalyticsRange,
  AnalyticsBreakdownDimension,
} from "@/types";
import { BreakdownChartCard } from "@/components/analytics/BreakdownChartCard";
import { TrendBarChart } from "@/components/analytics/TrendBarChart";
import { PageContainer } from "@/components/ui/page-container";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DEFAULT_BILLING_DISPLAY_DECIMALS } from "@/lib/billing";
import { readScopedCache, writeScopedCache } from "@/lib/local-cache";
import { cn, formatCompactNumber, formatCurrency } from "@/lib/utils";
import { Activity, CircleDollarSign, Clock3, DatabaseZap, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const formatDuration = (value: number): string => {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} s`;
  }
  return `${Math.round(value)} ms`;
};

const ANALYTICS_RANGE_CACHE_KEY = "analytics:selected-range";

const RANGE_VALUES: AnalyticsRange[] = ["24h", "7d", "30d", "90d"];

const getInitialAnalyticsRange = (): AnalyticsRange => {
  const cachedRange = readScopedCache<AnalyticsRange>(ANALYTICS_RANGE_CACHE_KEY)?.data;

  return (cachedRange && RANGE_VALUES.includes(cachedRange)) ? cachedRange : "24h";
};

export function Analytics() {
  const { t } = useTranslation();
  const [range, setRange] = useState<AnalyticsRange>(getInitialAnalyticsRange);

  const RANGE_OPTIONS: Array<{ value: AnalyticsRange; label: string }> = [
    { value: "24h", label: t('analytics.range24h') },
    { value: "7d", label: t('analytics.range7d') },
    { value: "30d", label: t('analytics.range30d') },
    { value: "90d", label: t('analytics.range90d') },
  ];

  const BREAKDOWN_CHARTS: Array<{
    dimension: AnalyticsBreakdownDimension;
    title: string;
    description: string;
    barClassName: string;
    badgeClassName: string;
  }> = [
    {
      dimension: "model",
      title: t('analytics.modelRanking'),
      description: t('analytics.modelRankingDesc'),
      barClassName: "from-amber-500 to-orange-400",
      badgeClassName: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
    },
    {
      dimension: "channel",
      title: t('analytics.channelRanking'),
      description: t('analytics.channelRankingDesc'),
      barClassName: "from-emerald-500 to-teal-400",
      badgeClassName: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    },
    {
      dimension: "token",
      title: t('analytics.tokenRanking'),
      description: t('analytics.tokenRankingDesc'),
      barClassName: "from-sky-500 to-cyan-400",
      badgeClassName: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
    },
    {
      dimension: "provider",
      title: t('analytics.providerRanking'),
      description: t('analytics.providerRankingDesc'),
      barClassName: "from-rose-500 to-pink-400",
      badgeClassName: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
    },
  ];

  const dashboardCacheEntry = useMemo(
    () => readScopedCache<AnalyticsDashboardData>(`analytics:dashboard:${range}`),
    [range],
  );

  useEffect(() => {
    writeScopedCache(ANALYTICS_RANGE_CACHE_KEY, range);
  }, [range]);

  const dashboardQuery = useQuery({
    queryKey: ["analytics", "dashboard", range],
    queryFn: async () => {
      const response = await apiClient.getAnalyticsDashboard(range);
      const data = response.data as AnalyticsDashboardData;
      writeScopedCache(`analytics:dashboard:${range}`, data);
      return data;
    },
    initialData: dashboardCacheEntry?.data,
    initialDataUpdatedAt: dashboardCacheEntry?.updatedAt,
    staleTime: 60_000,
  });

  const dashboard = dashboardQuery.data;
  const overview = dashboard?.overview;
  const trend = dashboard?.trend;
  const displayDecimals = dashboard?.displayDecimals ?? DEFAULT_BILLING_DISPLAY_DECIMALS;
  const isFetching = dashboardQuery.isFetching;

  const handleRefresh = async () => {
    await dashboardQuery.refetch();
  };

  return (
    <PageContainer
      title={t('analytics.title')}
      description={t('analytics.description')}
      actions={
        <div className="flex items-center gap-2">
          <div className="w-28">
            <Select className="h-9" value={range} onChange={(event) => setRange(event.target.value as AnalyticsRange)}>
              {RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          <Card className="border-0">
            <CardHeader className="pb-3">
              <CardDescription>{t('analytics.totalRequests')}</CardDescription>
              <CardTitle className="text-3xl">{formatCompactNumber(overview?.totals.requests || 0)}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t('analytics.successCount', { count: formatCompactNumber(overview?.totals.successes || 0) })}</span>
              <Activity className="h-4 w-4 text-sky-500" />
            </CardContent>
          </Card>

          <Card className="border-0">
            <CardHeader className="pb-3">
              <CardDescription>{t('analytics.successRate')}</CardDescription>
              <CardTitle className="text-3xl">{formatPercent(overview?.totals.successRate || 0)}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t('analytics.failureCount', { count: formatCompactNumber(overview?.totals.failures || 0) })}</span>
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            </CardContent>
          </Card>

          <Card className="border-0">
            <CardHeader className="pb-3">
              <CardDescription>{t('analytics.inputTokens')}</CardDescription>
              <CardTitle className="text-3xl">{formatCompactNumber(overview?.totals.promptTokens || 0)}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t('analytics.totalTokensCount', { count: formatCompactNumber(overview?.totals.totalTokens || 0) })}</span>
              <DatabaseZap className="h-4 w-4 text-violet-500" />
            </CardContent>
          </Card>

          <Card className="border-0">
            <CardHeader className="pb-3">
              <CardDescription>{t('analytics.outputTokens')}</CardDescription>
              <CardTitle className="text-3xl">{formatCompactNumber(overview?.totals.completionTokens || 0)}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{formatCurrency(overview?.totals.totalCost || 0, displayDecimals)}</span>
              <CircleDollarSign className="h-4 w-4 text-amber-500" />
            </CardContent>
          </Card>

          <Card className="border-0">
            <CardHeader className="pb-3">
              <CardDescription>{t('analytics.avgLatency')}</CardDescription>
              <CardTitle className="text-3xl">{formatDuration(overview?.totals.avgLatencyMs || 0)}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{RANGE_OPTIONS.find((option) => option.value === range)?.label}</span>
              <Clock3 className="h-4 w-4 text-slate-500" />
            </CardContent>
          </Card>
        </div>

        {!trend || trend.points.length === 0 ? (
          <Card className="border-0 flex flex-col items-center justify-center py-16">
            <p className="text-sm font-medium">{t('analytics.noTrendData')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('analytics.noTrendDataHint')}</p>
          </Card>
        ) : (
          <TrendBarChart points={trend.points} range={range} displayDecimals={displayDecimals} />
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {BREAKDOWN_CHARTS.map((chart) => (
            <BreakdownChartCard
              key={chart.dimension}
              title={chart.title}
              description={chart.description}
              items={dashboard?.breakdowns?.[chart.dimension]?.items}
              isLoading={dashboardQuery.isPending}
              isError={dashboardQuery.isError}
              barClassName={chart.barClassName}
              badgeClassName={chart.badgeClassName}
              displayDecimals={displayDecimals}
            />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
