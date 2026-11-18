import { normalizeGeminiNativeBaseUrl } from "./protocol-registry"

export type GeminiGenerateContentAction =
    | "generateContent"
    | "streamGenerateContent"

/**
 * Builds `/models/{model}:{action}` on top of the Gemini native base.
 * Endpoint query parameters are preserved; the caller adds `alt=sse` for streams.
 */
export const buildGeminiTargetUrl = (
    endpoint: string,
    model: string,
    action: GeminiGenerateContentAction,
): URL => {
    const base = normalizeGeminiNativeBaseUrl(endpoint)
    const targetUrl = new URL(`${base}/models/${encodeURIComponent(model)}:${action}`)

    new URL(endpoint).searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value)
    })

    return targetUrl
}
