const trimSlashes = (value: string): string => {
    return value.replace(/^\/+|\/+$/g, "");
};

const joinPath = (...segments: string[]): string => {
    const cleanedSegments = segments
        .map((segment) => trimSlashes(segment))
        .filter((segment) => segment.length > 0);

    return `/${cleanedSegments.join("/")}`;
};

export const buildAzureTargetUrlFromPath = (
    endpoint: string,
    path: string
): URL => {
    const targetUrl = new URL(endpoint.replace(/#$/, ""));

    if (endpoint.endsWith("#")) {
        return targetUrl;
    }

    const requestPath = path.replace(/^\/v1/, "");
    const currentBasePath = trimSlashes(targetUrl.pathname);
    // A trailing slash only means "endpoint already includes the base path" when a
    // path is present; "https://resource.openai.azure.com/" is a bare host.
    const explicitBasePath = endpoint.endsWith("/") && currentBasePath.length > 0;
    const azureBasePath = currentBasePath.endsWith("openai/v1")
        ? currentBasePath
        : currentBasePath.endsWith("openai")
            ? explicitBasePath
                ? currentBasePath
                : joinPath(currentBasePath, "v1")
            : explicitBasePath
                ? joinPath(currentBasePath, "openai")
                : joinPath(currentBasePath, "openai/v1");

    targetUrl.pathname = joinPath(azureBasePath, requestPath);

    return targetUrl;
};
