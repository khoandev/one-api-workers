import { Context, Hono } from "hono"
import { contentJson, fromHono, OpenAPIRoute } from 'chanfana';
import { z } from "zod";

import db from "../db"
import {
    isGeminiModelsPath,
    parseGeminiRouteTarget,
    resolveRouteId,
} from "./shared/route-policy"
import { resolveChannel } from "./shared/channel-resolver"
import { executeWithFallbackChannels } from "./shared/upstream-retry"
import { buildGeminiErrorResponse, wrapGeminiErrorResponse } from "./shared/gemini-errors"
import { ModelsEndpoint } from "./models"

export const api = fromHono(new Hono<HonoCustomType>())

const ensureDatabaseReady = async (c: Context<HonoCustomType>, next: () => Promise<void>) => {
    await db.ensureReady(c);
    await next();
}

api.use("/v1/*", ensureDatabaseReady)
api.use("/v1beta/*", ensureDatabaseReady)

class UnifiedProxyEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['OpenAI Proxy'],
        request: {
            headers: z.object({
                'Authorization': z.string().optional().describe("Token for authentication (OpenAI format)"),
                'x-api-key': z.string().optional().describe("API key for authentication (Claude format)"),
                'x-goog-api-key': z.string().optional().describe("API key for authentication (Gemini format)"),
            }),
            body: contentJson(z.any()),
        },
        responses: {
            200: {
                description: 'Successful response',
            },
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const pathname = new URL(c.req.url).pathname
        const routeId = resolveRouteId(pathname)
        if (!routeId) {
            return isGeminiModelsPath(pathname)
                ? buildGeminiErrorResponse(404, `Unsupported Gemini route: ${pathname}`)
                : c.text("Unknown route", 404)
        }

        const geminiTarget = routeId === "gemini-generate-content"
            ? parseGeminiRouteTarget(pathname)
            : null

        const result = await resolveChannel(
            c,
            routeId,
            geminiTarget ? { model: geminiTarget.model, stream: geminiTarget.stream } : undefined,
        )
        if (result instanceof Response) {
            return geminiTarget ? wrapGeminiErrorResponse(result) : result
        }

        const { channels, initialChannel, requestBody, saveUsage, logFailure, trackingState, setActiveChannel, routing } = result

        return executeWithFallbackChannels(
            c,
            channels,
            initialChannel,
            requestBody,
            saveUsage,
            logFailure,
            trackingState,
            setActiveChannel,
            routeId,
            routing,
        )
    }
}

api.post("/v1/chat/completions", UnifiedProxyEndpoint)
api.post("/v1/messages", UnifiedProxyEndpoint)
api.post("/v1/responses", UnifiedProxyEndpoint)
api.post("/v1/audio/speech", UnifiedProxyEndpoint)
api.post("/v1beta/models/*", UnifiedProxyEndpoint)
api.get("/v1/models", ModelsEndpoint)
