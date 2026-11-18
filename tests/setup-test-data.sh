#!/bin/bash
# Setup test data in local D1 for mock upstream testing
# All channels point to http://localhost:9999

MOCK="http://localhost:9999"
API_URL="${API_URL:-http://localhost:8787}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.local.jsonc}"
DB_NAME="${DB_NAME:-one-api}"
DB_EXEC=(npx wrangler d1 execute "$DB_NAME" --local --config "$WRANGLER_CONFIG" --command)

echo "Setting up test channels and tokens..."

# Warm up the worker so schema migrations run against the same local D1 database.
curl -s "$API_URL/api/admin/channel" > /dev/null 2>&1 || true
"${DB_EXEC[@]}" "DELETE FROM admin_rate_limit; DELETE FROM admin_login_challenge; DELETE FROM admin_session; DELETE FROM settings WHERE key = 'SYSTEM_CONFIG'" > /dev/null 2>&1 || true

# Channel: openai type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-openai', '{\"name\":\"test-openai\",\"type\":\"openai\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"gpt-4o\":\"gpt-4o\",\"gpt-4\":\"gpt-4\"}}')"

# Channel: azure-openai type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-azure', '{\"name\":\"test-azure\",\"type\":\"azure-openai\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"api_version\":\"2024-02-01\",\"deployment_mapper\":{\"gpt-4o-azure\":\"gpt-4o-deployment\"}}')"

# Channel: claude type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-claude', '{\"name\":\"test-claude\",\"type\":\"claude\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"claude-3-opus\":\"claude-3-opus-20240229\"}}')"

# Channel: openai-responses type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-responses', '{\"name\":\"test-responses\",\"type\":\"openai-responses\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"gpt-4o-resp\":\"gpt-4o\"}}')"

# Channel: azure-openai-responses type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-azure-resp', '{\"name\":\"test-azure-resp\",\"type\":\"azure-openai-responses\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"api_version\":\"2025-01-01\",\"deployment_mapper\":{\"gpt-4o-azure-resp\":\"gpt-4o-deployment\"}}')"

# Channel: gemini-native type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-gemini-native', '{\"name\":\"test-gemini-native\",\"type\":\"gemini-native\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"gemini-native-model\":\"gemini-2.0-flash\"}}')"

# Channel: exact URL (trailing #) openai type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-exact', '{\"name\":\"test-exact\",\"type\":\"openai\",\"endpoint\":\"$MOCK/exact/chat/completions#\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"gpt-4o-exact\":\"gpt-4o\"}}')"

# Channel: openai-audio type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-audio', '{\"name\":\"test-audio\",\"type\":\"openai-audio\",\"endpoint\":\"$MOCK\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"tts-1\":\"tts-1\"}}')"

# Channel: azure-openai-audio type
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO channel_config (key, value) VALUES ('test-azure-audio', '{\"name\":\"test-azure-audio\",\"type\":\"azure-openai-audio\",\"endpoint\":\"$MOCK/\",\"api_key\":\"mock-key\",\"deployment_mapper\":{\"azure-tts\":\"tts-1\"}}')"

# Token: access to all test channels only
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO api_token (key, value, usage) VALUES ('sk-mock-all', '{\"name\":\"mock-all\",\"channel_keys\":[\"test-openai\",\"test-azure\",\"test-claude\",\"test-responses\",\"test-azure-resp\",\"test-gemini-native\",\"test-exact\",\"test-audio\",\"test-azure-audio\"],\"total_quota\":99999999}', 0)"

# Token: limited to openai only
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO api_token (key, value, usage) VALUES ('sk-mock-openai', '{\"name\":\"mock-openai\",\"channel_keys\":[\"test-openai\"],\"total_quota\":99999999}', 0)"

# Token: quota almost full
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO api_token (key, value, usage) VALUES ('sk-mock-quota', '{\"name\":\"mock-quota\",\"channel_keys\":[\"test-openai\"],\"total_quota\":100}', 99)"

# Seeding writes straight to D1, bypassing the admin APIs that invalidate KV.
for key in \
  "oaw:cache:v1:channel_config:all" \
  "oaw:cache:v1:setting:json:SYSTEM_CONFIG" \
  "oaw:cache:v1:setting:json:BILLING_CONFIG" \
  "oaw:cache:v1:setting:json:MODEL_PRICING_CONFIG" \
  "oaw:cache:v1:analytics:columns:usage_events_by_token" \
  "oaw:cache:v1:analytics:dashboard:24h" \
  "oaw:cache:v1:analytics:dashboard:7d" \
  "oaw:cache:v1:analytics:dashboard:30d" \
  "oaw:cache:v1:analytics:dashboard:90d"; do
  npx wrangler kv key delete "$key" --local --binding KV --config "$WRANGLER_CONFIG" \
    > /dev/null 2>&1 || true
done

echo "Test data setup complete!"
