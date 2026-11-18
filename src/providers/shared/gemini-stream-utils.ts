import { estimateUsageFromBodies } from "./usage-utils"

type GeminiUsageMetadata = {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
}

type GeminiCandidate = {
    content?: {
        parts?: Array<{ text?: string }>
    }
}

type GeminiPayload = {
    candidates?: GeminiCandidate[]
    usageMetadata?: GeminiUsageMetadata
}

const toUsage = (usage: GeminiUsageMetadata): Usage | null => {
    if (usage.promptTokenCount === undefined && usage.candidatesTokenCount === undefined) {
        return null
    }

    const promptTokens = usage.promptTokenCount ?? 0
    const completionTokens = usage.candidatesTokenCount ?? 0

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage.totalTokenCount ?? promptTokens + completionTokens,
    }
}

const collectCandidateText = (payload: GeminiPayload): string => {
    return (payload.candidates ?? [])
        .flatMap((candidate) => candidate.content?.parts ?? [])
        .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
        .join("")
}

/**
 * Gemini native streams (`alt=sse`) repeat a cumulative `usageMetadata` block.
 * Keep the latest one and persist it when the stream ends.
 */
export const handleGeminiStreamResponse = async (
    streamForServer: ReadableStream<Uint8Array> | undefined,
    requestBody: unknown,
    saveUsage: (usage: Usage) => Promise<void>,
): Promise<void> => {
    const reader = streamForServer?.getReader()
    const decoder = new TextDecoder("utf-8")
    let buffer = ""
    let latestUsage: Usage | null = null
    let outputText = ""

    const processLines = (lines: string[]): void => {
        for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine.startsWith("data:")) {
                continue
            }

            const jsonContent = trimmedLine.slice("data:".length).trim()
            if (!jsonContent || jsonContent === "[DONE]") {
                continue
            }

            let payload: GeminiPayload
            try {
                payload = JSON.parse(jsonContent) as GeminiPayload
            } catch {
                console.warn("Skipping unparseable Gemini stream event:", jsonContent)
                continue
            }

            outputText += collectCandidateText(payload)

            if (payload.usageMetadata) {
                latestUsage = toUsage(payload.usageMetadata) ?? latestUsage
            }
        }
    }

    try {
        if (!reader) {
            throw new Error("No reader found in response body")
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            processLines(lines)
        }
    } catch (error) {
        console.warn("Gemini stream processing interrupted:", error)
    } finally {
        reader?.releaseLock()
        buffer += decoder.decode()
        if (buffer.trim()) {
            processLines([buffer])
        }

        const usage = latestUsage
            ?? estimateUsageFromBodies(requestBody, undefined, outputText)

        if (usage) {
            await saveUsage(usage)
        }
    }
}

export const checkoutGeminiUsageData = async (
    saveUsage: (usage: Usage) => Promise<void>,
    response: Response | GeminiPayload,
    requestBody?: unknown,
): Promise<void> => {
    try {
        const payload = response instanceof Response
            ? (await response.clone().json() as GeminiPayload)
            : response

        const usage = payload.usageMetadata ? toUsage(payload.usageMetadata) : null
        if (usage) {
            await saveUsage(usage)
            return
        }

        const estimatedUsage = estimateUsageFromBodies(
            requestBody,
            payload,
            collectCandidateText(payload),
        )
        if (estimatedUsage) {
            await saveUsage(estimatedUsage)
        }
    } catch (error) {
        console.error("Error logging Gemini usage data:", error)
    }
}
