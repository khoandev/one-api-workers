import { Context } from "hono";
import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import {
    getApiKeyFromHeaders,
    fetchTokenData,
    fetchChannelCatalog,
    filterChannelsForToken,
} from "./shared/auth";
import { getJsonSetting } from "../utils";
import { TokenUtils } from "../admin/token_utils";
import { CONSTANTS } from "../constants";

export class ModelsEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['OpenAI Proxy'],
        summary: 'List available models',
        request: {
            headers: z.object({
                'Authorization': z.string().optional().describe("Token for authentication (OpenAI format)"),
                'x-api-key': z.string().optional().describe("API key for authentication (Claude format)"),
            }),
        },
        responses: {
            200: {
                description: 'List of available models',
                content: {
                    'application/json': {
                        schema: z.object({
                            object: z.string(),
                            data: z.array(z.object({
                                id: z.string(),
                                object: z.string(),
                                created: z.number(),
                                owned_by: z.string(),
                            })),
                        }),
                    },
                },
            },
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const apiKey = getApiKeyFromHeaders(c);
        if (!apiKey) {
            return c.json({ object: "list", data: [] });
        }

        const [tokenResult, catalogResult] = await Promise.allSettled([
            fetchTokenData(c, apiKey),
            fetchChannelCatalog(c),
        ]);

        if (tokenResult.status === "rejected") throw tokenResult.reason;
        if (!tokenResult.value) {
            return c.text("Invalid API key", 401);
        }
        if (catalogResult.status === "rejected") throw catalogResult.reason;

        const tokenInfo = tokenResult.value;
        const channelsResult = filterChannelsForToken(catalogResult.value, tokenInfo.tokenData);

        if (!channelsResult || !channelsResult.results || channelsResult.results.length === 0) {
            return c.json({
                object: "list",
                data: [],
            });
        }

        const modelsSet = new Set<string>();
        const hasRemainingQuota = TokenUtils.hasRemainingQuota(tokenInfo.tokenData.total_quota, tokenInfo.usage);
        // 一次性读取全局定价，避免循环内对每个模型重复查询
        const globalPricing = hasRemainingQuota
            ? null
            : await getJsonSetting<Record<string, ModelPricing>>(c, CONSTANTS.MODEL_PRICING_KEY);

        for (const row of channelsResult.results) {
            const config = row.config;

            if (!config.enabled) {
                continue;
            }
            for (const model of config.models) {
                if (model.enabled === false) {
                    continue;
                }
                if (!hasRemainingQuota && await TokenUtils.modelRequiresPaidQuota(c, model.name, config, globalPricing)) {
                    continue;
                }
                modelsSet.add(model.name);
            }
        }

        const models = Array.from(modelsSet).sort().map((modelId) => ({
            id: modelId,
            object: "model" as const,
            created: 1700000000,
            owned_by: "system",
        }));

        return c.json({
            object: "list",
            data: models,
        });
    }
}
