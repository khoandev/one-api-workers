import { Context } from "hono";
import { OpenAPIRoute } from "chanfana";
import { z } from "zod";

import { CACHE_KEYS } from "../cache-keys";
import { cachedKvValue } from "../kv-cache";
import { CommonErrorResponse, CommonSuccessfulResponse } from "../model";
import { getSystemConfig } from "../system-config";
import {
    AnalyticsQueryUpstreamError,
    AnalyticsQueryValidationError,
    normalizeAnalyticsRange,
    queryUsageOverview,
    queryUsageTrend,
    queryUsageBreakdown,
    queryUsageEvents,
    queryUsageLogRecords,
} from "../analytics/query";

const rangeSchema = z.enum(["24h", "7d", "30d", "90d"]).optional();
const DASHBOARD_CACHE_MAX_AGE_MS = 10_000;
type AnalyticsErrorStatus = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 504;

const toAnalyticsErrorStatus = (error: unknown): AnalyticsErrorStatus => {
    if (error instanceof AnalyticsQueryValidationError) {
        return 400;
    }

    if (error instanceof AnalyticsQueryUpstreamError) {
        switch (error.statusCode) {
            case 401:
            case 403:
            case 404:
            case 429:
            case 504:
                return error.statusCode;
            default:
                return 502;
        }
    }

    return 500;
};

const toErrorResponse = (
    c: Context<HonoCustomType>,
    error: unknown,
    fallbackMessage: string
) => {
    const message = error instanceof Error ? error.message : fallbackMessage;
    return c.text(message, toAnalyticsErrorStatus(error));
};

export class AnalyticsDashboardEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Get the complete usage analytics dashboard payload",
        request: {
            query: z.object({
                range: rangeSchema,
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const range = normalizeAnalyticsRange(c.req.query("range"));
            const data = await cachedKvValue(
                c,
                CACHE_KEYS.analyticsDashboard(range),
                DASHBOARD_CACHE_MAX_AGE_MS,
                async () => {
                    const [overview, trend, token, channel, model, provider, systemConfig] = await Promise.all([
                        queryUsageOverview(c, range),
                        queryUsageTrend(c, range),
                        queryUsageBreakdown(c, range, "token"),
                        queryUsageBreakdown(c, range, "channel"),
                        queryUsageBreakdown(c, range, "model"),
                        queryUsageBreakdown(c, range, "provider"),
                        getSystemConfig(c),
                    ]);

                    return {
                        range: overview.range,
                        displayDecimals: systemConfig.displayDecimals,
                        overview,
                        trend,
                        breakdowns: { token, channel, model, provider },
                    };
                },
            );

            return {
                success: true,
                data,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query analytics dashboard");
        }
    }
}

export class AnalyticsOverviewEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Get usage analytics overview",
        request: {
            query: z.object({
                range: rangeSchema,
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const result = await queryUsageOverview(c, c.req.query("range"));
            return {
                success: true,
                data: result,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query analytics overview");
        }
    }
}

export class AnalyticsTrendEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Get usage analytics time series",
        request: {
            query: z.object({
                range: rangeSchema,
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const result = await queryUsageTrend(c, c.req.query("range"));
            return {
                success: true,
                data: result,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query analytics trend");
        }
    }
}

export class AnalyticsBreakdownEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Get usage analytics breakdown",
        request: {
            query: z.object({
                range: rangeSchema,
                dimension: z.enum(["token", "channel", "model", "provider"]).optional(),
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const result = await queryUsageBreakdown(
                c,
                c.req.query("range"),
                c.req.query("dimension")
            );
            return {
                success: true,
                data: result,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query analytics breakdown");
        }
    }
}

export class AnalyticsEventsEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Get recent usage analytics samples",
        request: {
            query: z.object({
                range: rangeSchema,
                limit: z.coerce.number().min(1).max(100).optional(),
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const result = await queryUsageEvents(
                c,
                c.req.query("range"),
                c.req.query("limit")
            );
            return {
                success: true,
                data: result,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query analytics events");
        }
    }
}

export class UsageLogSearchEndpoint extends OpenAPIRoute {
    schema = {
        tags: ["Admin API"],
        summary: "Search usage logs with custom filters",
        request: {
            query: z.object({
                start: z.string().optional(),
                end: z.string().optional(),
                dimension: z.enum([
                    "route",
                    "token",
                    "channel",
                    "model",
                    "provider",
                    "requestId",
                    "traceId",
                    "clientIp",
                    "userAgent",
                    "country",
                    "region",
                    "city",
                    "colo",
                    "timezone",
                    "result",
                    "errorCode",
                    "errorSummary",
                ]).optional(),
                keyword: z.string().optional(),
                result: z.enum(["all", "success", "failure"]).optional(),
                page: z.coerce.number().int().min(1).max(1000).optional(),
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.any()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            const result = await queryUsageLogRecords(c, {
                start: c.req.query("start"),
                end: c.req.query("end"),
                dimension: c.req.query("dimension"),
                keyword: c.req.query("keyword"),
                result: c.req.query("result"),
                page: c.req.query("page"),
            });
            return {
                success: true,
                data: result,
            } as CommonResponse;
        } catch (error) {
            return toErrorResponse(c, error, "Failed to query usage logs");
        }
    }
}
