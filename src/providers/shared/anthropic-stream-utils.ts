import { estimateUsageFromBodies } from "./usage-utils"

export type AnthropicMessagesResponse = {
    usage?: {
        input_tokens: number
        output_tokens: number
    }
}

type AnthropicStreamEvent = {
    type?: string
    message?: AnthropicMessagesResponse
    usage?: {
        input_tokens?: number
        output_tokens?: number
    }
    delta?: {
        type?: string
        text?: string
    }
}

type AnthropicStreamState = {
    inputTokens: number
    outputTokens: number
    saved: boolean
    outputText: string
}

const toUsage = (inputTokens: number, outputTokens: number): Usage => ({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
})

const saveMessageUsage = async (
    message: AnthropicMessagesResponse | undefined,
    state: AnthropicStreamState,
    saveUsage: (usage: Usage) => Promise<void>,
): Promise<boolean> => {
    if (!message?.usage) {
        return false
    }

    state.saved = true
    await saveUsage(toUsage(message.usage.input_tokens, message.usage.output_tokens))
    return true
}

const processStreamLines = async (
    lines: string[],
    state: AnthropicStreamState,
    saveUsage: (usage: Usage) => Promise<void>,
): Promise<void> => {
    for (const line of lines) {
        const trimmedLine = line.trim()
        if (!trimmedLine.startsWith("data:")) {
            continue
        }

        const jsonContent = trimmedLine.slice("data:".length).trim()
        if (!jsonContent || jsonContent === "{}") {
            continue
        }

        let event: AnthropicStreamEvent
        try {
            event = JSON.parse(jsonContent) as AnthropicStreamEvent
        } catch {
            console.warn("Skipping unparseable Anthropic stream event:", jsonContent)
            continue
        }

        if (event.type === "message_start" && event.message?.usage) {
            state.inputTokens = event.message.usage.input_tokens
            continue
        }

        if (event.type === "content_block_delta" && typeof event.delta?.text === "string") {
            state.outputText += event.delta.text
            continue
        }

        if (event.type === "message_delta" && event.usage?.output_tokens != null) {
            state.outputTokens = event.usage.output_tokens
            continue
        }

        if (event.type === "message_complete" && !state.saved) {
            await saveMessageUsage(event.message, state, saveUsage)
            continue
        }

        if (event.type === "message_stop" && !state.saved) {
            const savedFromMessage = await saveMessageUsage(event.message, state, saveUsage)
            if (!savedFromMessage) {
                state.saved = true
                await saveUsage(toUsage(state.inputTokens, state.outputTokens))
            }
        }
    }
}

/**
 * Anthropic reports input tokens on `message_start` and output tokens on `message_delta`,
 * so the accumulator is the fallback when the stream ends without a complete usage block.
 */
export const handleAnthropicStreamResponse = async (
    streamForServer: ReadableStream<Uint8Array> | undefined,
    requestBody: unknown,
    saveUsage: (usage: Usage) => Promise<void>,
): Promise<void> => {
    const state: AnthropicStreamState = {
        inputTokens: 0,
        outputTokens: 0,
        saved: false,
        outputText: "",
    }
    const reader = streamForServer?.getReader()
    const decoder = new TextDecoder("utf-8")
    let buffer = ""

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
            await processStreamLines(lines, state, saveUsage)
        }
    } catch (error) {
        // Upstream close or client disconnect both land here; usage already saved still stands.
        console.warn("Anthropic stream processing interrupted:", error)
    } finally {
        reader?.releaseLock()
        buffer += decoder.decode()
        if (buffer.trim()) {
            await processStreamLines([buffer], state, saveUsage)
        }

        if (!state.saved && state.outputText.length > 0) {
            const estimatedUsage = estimateUsageFromBodies(requestBody, undefined, state.outputText)
            if (estimatedUsage) {
                state.saved = true
                await saveUsage(estimatedUsage)
            }
        }
    }
}

export const checkoutAnthropicUsageData = async (
    saveUsage: (usage: Usage) => Promise<void>,
    response: Response | AnthropicMessagesResponse,
    requestBody?: unknown,
): Promise<void> => {
    try {
        const payload = response instanceof Response
            ? (await response.clone().json() as AnthropicMessagesResponse)
            : response

        if (payload.usage) {
            await saveUsage(toUsage(payload.usage.input_tokens, payload.usage.output_tokens))
            return
        }

        const estimatedUsage = estimateUsageFromBodies(requestBody, payload)
        if (estimatedUsage) {
            await saveUsage(estimatedUsage)
        }
    } catch (error) {
        console.error("Error logging Anthropic usage data:", error)
    }
}
