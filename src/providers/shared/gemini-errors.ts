const GEMINI_STATUS_BY_HTTP: Record<number, string> = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    402: "RESOURCE_EXHAUSTED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    409: "ABORTED",
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    502: "UNAVAILABLE",
    503: "UNAVAILABLE",
    504: "DEADLINE_EXCEEDED",
}

export type GeminiErrorPayload = {
    error: {
        code: number
        message: string
        status: string
    }
}

/**
 * Gemini clients expect `{ error: { code, message, status } }` with a numeric HTTP code,
 * including for gateway-side failures (auth, model resolution, payload validation).
 */
export const buildGeminiErrorPayload = (
    httpStatus: number,
    message: string,
): GeminiErrorPayload => {
    return {
        error: {
            code: httpStatus,
            message,
            status: GEMINI_STATUS_BY_HTTP[httpStatus] ?? "INTERNAL",
        },
    }
}

export const buildGeminiErrorResponse = (
    httpStatus: number,
    message: string,
): Response => {
    return new Response(
        JSON.stringify(buildGeminiErrorPayload(httpStatus, message)),
        {
            status: httpStatus,
            headers: { "content-type": "application/json; charset=utf-8" },
        },
    )
}

/**
 * Re-wraps a plain-text rejection (for example from channel resolution) into the
 * Gemini error envelope while keeping the original status code.
 */
export const wrapGeminiErrorResponse = async (
    response: Response,
): Promise<Response> => {
    if (response.ok) {
        return response
    }

    let message = ""
    try {
        message = (await response.text()).trim()
    } catch {
        message = ""
    }

    return buildGeminiErrorResponse(
        response.status,
        message || "Upstream request failed",
    )
}
