import { Context } from "hono";
import { OpenAPIRoute } from 'chanfana';
import { z } from 'zod';
import { getJsonSetting, saveSetting } from "../utils";
import { CONSTANTS } from "../constants";
import { CommonErrorResponse, CommonSuccessfulResponse } from "../model";
import { sanitizePricingConfig } from "../pricing-config";
import { buildPricingSyncPreview } from "../pricing-sync";

const pricingBillingModeSchema = z.enum(["volume", "request"]);

const pricingModelSchema = z.object({
    billingMode: pricingBillingModeSchema.optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    cache: z.number().optional(),
    request: z.number().optional(),
});

// Pricing 获取配置 API
export class PricingGetEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['Admin API'],
        summary: 'Get global pricing configuration',
        responses: {
            ...CommonSuccessfulResponse(z.record(z.string(), pricingModelSchema)),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const pricingConfig = await getJsonSetting<Record<string, ModelPricing>>(
            c,
            CONSTANTS.MODEL_PRICING_KEY
        );

        return {
            success: true,
            data: sanitizePricingConfig(pricingConfig)
        } as CommonResponse;
    }
}

// Pricing 预览 models.dev 同步建议 API
export class PricingSyncPreviewEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['Admin API'],
        summary: 'Preview pricing suggestions from models.dev',
        responses: {
            ...CommonSuccessfulResponse(z.object({
                suggestions: z.record(z.string(), z.object({
                    input: z.number(),
                    output: z.number(),
                    cache: z.number().optional(),
                    provider: z.string(),
                })),
                unmatched: z.array(z.string()),
                targetCount: z.number(),
                providerCount: z.number(),
                fetchedAt: z.string(),
            })),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        try {
            return {
                success: true,
                data: await buildPricingSyncPreview(c),
            } as CommonResponse;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to fetch models.dev pricing";
            return c.text(message, 502);
        }
    }
}

// Pricing 更新配置 API
export class PricingUpdateEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['Admin API'],
        summary: 'Update global pricing configuration',
        request: {
            body: {
                content: {
                    'application/json': {
                        schema: z.record(z.string(), pricingModelSchema),
                    }
                }
            }
        },
        responses: {
            ...CommonSuccessfulResponse(),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const body = await c.req.json<Record<string, Partial<ModelPricing>>>();
        const normalizedConfig = sanitizePricingConfig(body);

        await saveSetting(
            c,
            CONSTANTS.MODEL_PRICING_KEY,
            JSON.stringify(normalizedConfig)
        );

        return {
            success: true,
            message: "Pricing config updated successfully"
        } as CommonResponse;
    }
}
