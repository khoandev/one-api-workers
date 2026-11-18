import { spyOn } from "bun:test"
import { Context } from "hono"

import { getProvider } from "../../src/providers/shared/provider-registry"
import type { RouteId } from "../../src/providers/shared/route-policy"

export type UpstreamCall = {
    request: Request
    url: URL
    body: any
}

export type InstalledUpstream = {
    calls: UpstreamCall[]
    last: () => UpstreamCall
    restore: () => void
}

/**
 * Replaces global fetch with a recorder so passthrough/conversion tests can assert the
 * exact upstream URL, headers, and JSON body without a real network.
 */
export const installUpstream = (
    handler: (request: Request) => Response | Promise<Response>,
): InstalledUpstream => {
    const calls: UpstreamCall[] = []

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        const body = request.method === "POST"
            ? await request.clone().json().catch(() => undefined)
            : undefined

        calls.push({ request, url: new URL(request.url), body })
        return handler(request)
    }) as typeof fetch)

    return {
        calls,
        last: () => {
            const call = calls.at(-1)
            if (!call) throw new Error("No upstream request was made")
            return call
        },
        restore: () => fetchSpy.mockRestore(),
    }
}

const defaultPathForRoute = (routeId: RouteId): string => {
    switch (routeId) {
        case "gemini-generate-content":
            return "/v1beta/models/gemini-2.0-flash:generateContent"
        case "messages":
            return "/v1/messages"
        case "responses":
            return "/v1/responses"
        case "audio-speech":
            return "/v1/audio/speech"
        default:
            return "/v1/chat/completions"
    }
}

export type RunProviderOptions = {
    routeId: RouteId
    type: ChannelType
    config?: Partial<ChannelConfig>
    path?: string
    requestBody?: unknown
    requestHeaders?: Record<string, string>
    saveUsage?: (usage: Usage) => Promise<void>
}

export type ProviderRun = {
    response: Response
    saved: Usage[]
    tasks: Promise<unknown>[]
    trackingState: RequestTrackingState
}

export const runProvider = async (options: RunProviderOptions): Promise<ProviderRun> => {
    const channelConfig = {
        name: "test",
        endpoint: "",
        ...options.config,
        type: options.type,
    } as ChannelConfig
    const provider = getProvider(options.routeId, channelConfig)
    if (!provider) {
        throw new Error(`No provider for route ${options.routeId} and channel type ${options.type}`)
    }

    const tasks: Promise<unknown>[] = []
    const context = new Context<HonoCustomType>(
        new Request(`http://localhost${options.path ?? defaultPathForRoute(options.routeId)}`, {
            method: "POST",
            headers: options.requestHeaders,
        }),
        {
            executionCtx: {
                waitUntil: (task: Promise<unknown>) => {
                    tasks.push(task)
                },
            } as ExecutionContext,
        },
    )

    const saved: Usage[] = []
    const trackingState: RequestTrackingState = { retryCount: 0 }
    const saveUsage = options.saveUsage ?? (async (usage: Usage) => { saved.push(usage) })

    const response = await provider(
        context,
        channelConfig,
        options.requestBody ?? {},
        saveUsage,
        trackingState,
        options.routeId,
    )

    return { response, saved, tasks, trackingState }
}
