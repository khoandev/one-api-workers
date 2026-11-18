# Vendored Airlock modules

Protocol conversion engine, copied verbatim from [Airlock](https://github.com/airlock/airlock) (MIT) at commit
`1f55991394cdd08fd5cb56405c753104d43b414c`, `packages/{protocols,canonical,providers,request-shaping,shared}`.

Vendored modules:

- `protocols/` — inbound Zod schemas for OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini.
- `canonical/` — canonical request/response IR, normalizers, client encoders, stream reassembly, stream error encoders.
  `capabilities.ts` is intentionally not vendored.
- `providers/` — OpenAI (chat + Responses modes), Anthropic Messages, Gemini transport adapters.
- `request-shaping/` — header/auth application and `buildRequestUrl`.
- `shared/` — `GatewayError` and provider ids.

Local modifications (keep them when re-syncing upstream):

1. Import specifiers rewritten from `@airlock/*` workspace names to relative paths, `.js` suffixes stripped.
2. `providers/openai-adapter.ts`: `OpenAIProviderAdapterOptions.auth` (`header_bearer` | `header_value`) lets Azure use
   `api-key` instead of `authorization`. Airlock always sends a bearer token.

Nothing else may change without a note here.
