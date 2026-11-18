#!/bin/bash
# E2E tests against mock upstream
# Prerequisites: mock-upstream running on :9999, wrangler dev on :8787

API="${API:-http://localhost:8787}"
MOCK_API="${MOCK_API:-http://localhost:9999}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.local.jsonc}"
DB_NAME="${DB_NAME:-one-api}"
DB_EXEC=(npx wrangler d1 execute "$DB_NAME" --local --config "$WRANGLER_CONFIG" --command)
PASS=0
FAIL=0
TOTAL=0

assert() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅ #$TOTAL $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ #$TOTAL $name"
    echo "     expected: $expected"
    echo "     actual:   $(echo "$actual" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local name="$1" unexpected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$unexpected"; then
    echo "  ❌ #$TOTAL $name"
    echo "     unexpected: $unexpected"
    echo "     actual:     $(echo "$actual" | head -1)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ #$TOTAL $name"
    PASS=$((PASS + 1))
  fi
}

assert_http() {
  local name="$1" expected_code="$2" expected_body="$3" actual="$4"
  local code=$(echo "$actual" | tail -1)
  local body=$(echo "$actual" | sed '$d')
  TOTAL=$((TOTAL + 1))
  if [[ "$code" == "$expected_code" ]] && echo "$body" | grep -q "$expected_body"; then
    echo "  ✅ #$TOTAL $name [HTTP $code]"
    PASS=$((PASS + 1))
  else
    echo "  ❌ #$TOTAL $name [HTTP $code]"
    echo "     expected: HTTP $expected_code + '$expected_body'"
    echo "     actual:   $(echo "$body" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

assert_between() {
  local name="$1" actual="$2" min="$3" max="$4"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && [[ "$actual" -ge "$min" ]] && [[ "$actual" -le "$max" ]]; then
    echo "  ✅ #$TOTAL $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ #$TOTAL $name"
    echo "     expected: [$min, $max]"
    echo "     actual:   ${actual:-<empty>}"
    FAIL=$((FAIL + 1))
  fi
}

do_get() { curl -s -w "\n%{http_code}" "$@"; }
do_post() { curl -s -w "\n%{http_code}" -X POST "$@"; }
reset_mock_inspection() { curl -s -X POST "$MOCK_API/__reset" > /dev/null; }
get_mock_inspection() { curl -sG "$MOCK_API/__inspect" --data-urlencode "key=$1"; }
json_field() {
  local path="$1"
  node -e "let raw=''; const path = process.argv[1].split('.'); process.stdin.on('data', (chunk) => raw += chunk); process.stdin.on('end', () => { const payload = JSON.parse(raw); let current = payload; for (const segment of path) { current = current?.[segment]; } process.stdout.write(current == null ? '' : String(current)); });" "$path"
}
ttl_seconds_until_iso() {
  node -e "const expiresAt = Date.parse(process.argv[1]); process.stdout.write(Number.isFinite(expiresAt) ? String(Math.round((expiresAt - Date.now()) / 1000)) : '');" "$1"
}
set_system_config_disabled() {
  "${DB_EXEC[@]}" "INSERT OR REPLACE INTO settings (key, value) VALUES ('SYSTEM_CONFIG', '{\"displayDecimals\":6,\"adminSecurity\":{\"enabled\":false,\"telegramBotToken\":\"\",\"telegramChatId\":\"\",\"verifiedFingerprint\":\"\",\"verifiedAt\":null},\"apiDocs\":{\"enabled\":true}}')" > /dev/null 2>&1
}
set_system_config_with_telegram() {
  local bot_token="$1" chat_id="$2" fingerprint
  fingerprint=$(node -e "const source = process.argv[1] + '::' + process.argv[2]; let hash = 2166136261; for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16777619); } process.stdout.write(source ? 'tgv1-' + ((hash >>> 0).toString(16)) : '');" "$bot_token" "$chat_id")
  "${DB_EXEC[@]}" "INSERT OR REPLACE INTO settings (key, value) VALUES ('SYSTEM_CONFIG', '{\"displayDecimals\":6,\"adminSecurity\":{\"enabled\":true,\"telegramBotToken\":\"$bot_token\",\"telegramChatId\":\"$chat_id\",\"verifiedFingerprint\":\"$fingerprint\",\"verifiedAt\":\"2026-04-14T00:00:00.000Z\"},\"apiDocs\":{\"enabled\":true}}')" > /dev/null 2>&1
}
seed_login_challenge() {
  local challenge_id="$1" code="$2" request_ip="$3" code_hash expires_at
  code_hash=$(node -e "const crypto = require('node:crypto'); process.stdout.write(crypto.createHash('sha256').update(process.argv[1]).digest('hex'))" "$code")
  expires_at=$(date -u -d "+5 minutes" +"%Y-%m-%dT%H:%M:%SZ")
  "${DB_EXEC[@]}" "INSERT OR REPLACE INTO admin_login_challenge (id, code_hash, expires_at, attempts, max_attempts, request_ip, request_country, request_region, request_city, request_colo, request_timezone) VALUES ('$challenge_id', '$code_hash', '$expires_at', 0, 5, '$request_ip', '', '', '', '', 'Asia/Shanghai')" > /dev/null 2>&1
}
seed_blocked_rate_limit() {
  local category="$1" bucket_id="$2" attempts="$3" blocked_until="$4" now_iso
  now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  "${DB_EXEC[@]}" "INSERT OR REPLACE INTO admin_rate_limit (bucket_key, category, bucket_id, window_started_at, attempts, blocked_until, last_event_at) VALUES ('$category:$bucket_id', '$category', '$bucket_id', '$now_iso', $attempts, '$blocked_until', '$now_iso')" > /dev/null 2>&1
}

if [[ -f ".dev.vars" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".dev.vars"
  set +a
fi

LOGIN_PAYLOAD=$(printf '{"token":"%s"}' "$ADMIN_TOKEN")

echo ""
echo "========================================="
echo "  E2E Tests with Mock Upstream"
echo "========================================="

# ---- /v1/models ----
echo ""
echo "--- GET /v1/models ---"

R=$(do_get "$API/v1/models")
assert_http "no key → empty list" "200" '"data":\[\]' "$R"

R=$(do_get -H "Authorization: Bearer bad" "$API/v1/models")
assert_http "invalid key → 401" "401" "Invalid API key" "$R"

R=$(do_get -H "Authorization: Bearer sk-mock-all" "$API/v1/models")
assert_http "full token → has gpt-4o" "200" "gpt-4o" "$R"

R=$(do_get -H "x-api-key: sk-mock-openai" "$API/v1/models")
assert_http "limited token → has gpt-4 only" "200" "gpt-4" "$R"

# ---- /v1/chat/completions errors ----
echo ""
echo "--- POST /v1/chat/completions (errors) ---"

R=$(do_post "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
assert_http "no auth → 401" "401" "Authorization header" "$R"

R=$(do_post -H "Authorization: Bearer bad" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
assert_http "invalid key → 401" "401" "Invalid API key" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d 'not-json')
assert_http "invalid JSON → 400" "400" "Invalid JSON body" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"messages":[]}')
assert_http "no model → 400" "400" "Model is required" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"nonexistent","messages":[]}')
assert_http "unmapped model → 400" "400" "Model not supported" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-openai" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"claude-3-opus","messages":[]}')
assert_http "limited token, wrong model → 400" "400" "Model not supported" "$R"

# ---- /v1/chat/completions via openai provider (non-stream) ----
echo ""
echo "--- POST /v1/chat/completions (openai, non-stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-openai" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
assert_http "openai non-stream → 200 + usage" "200" "Mock response" "$R"

# ---- /v1/chat/completions via openai provider (stream) ----
echo ""
echo "--- POST /v1/chat/completions (openai, stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-openai" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}')
assert_http "openai stream → 200 + SSE" "200" "data:" "$R"

reset_mock_inspection
R=$(do_post \
  -H "Authorization: Bearer sk-mock-openai" \
  -H "x-api-key: leaked-client-key" \
  -H "Cookie: session=leak-me" \
  -H "X-Forwarded-For: 203.0.113.10" \
  "$API/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"header check"}]}')
assert_http "openai header whitelist → 200" "200" "Mock response" "$R"
INSPECT=$(get_mock_inspection "chat-completions")
assert "openai upstream auth replaced with channel key" "\"authorization\":\"Bearer mock-key\"" "$INSPECT"
assert_not_contains "openai upstream strips client x-api-key" "leaked-client-key" "$INSPECT"
assert_not_contains "openai upstream strips cookie" "\"cookie\":" "$INSPECT"
assert_not_contains "openai upstream strips x-forwarded-for" "\"x-forwarded-for\":" "$INSPECT"

# ---- /v1/chat/completions via azure-openai (non-stream) ----
echo ""
echo "--- POST /v1/chat/completions (azure-openai, non-stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o-azure","messages":[{"role":"user","content":"hi"}]}')
assert_http "azure non-stream → 200" "200" "Mock response" "$R"

# ---- /v1/chat/completions via azure-openai (stream) ----
echo ""
echo "--- POST /v1/chat/completions (azure-openai, stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o-azure","stream":true,"messages":[{"role":"user","content":"hi"}]}')
assert_http "azure stream → 200 + SSE" "200" "data:" "$R"

# ---- /v1/messages via claude (non-stream) ----
echo ""
echo "--- POST /v1/messages (claude, non-stream) ---"

R=$(do_post -H "x-api-key: sk-mock-all" "$API/v1/messages" -H "Content-Type: application/json" -d '{"model":"claude-3-opus","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
assert_http "claude non-stream → 200" "200" "Mock Claude response" "$R"

# ---- /v1/messages via claude (stream) ----
echo ""
echo "--- POST /v1/messages (claude, stream) ---"

R=$(do_post -H "x-api-key: sk-mock-all" "$API/v1/messages" -H "Content-Type: application/json" -d '{"model":"claude-3-opus","stream":true,"max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
assert_http "claude stream → 200 + SSE" "200" "event:" "$R"

reset_mock_inspection
R=$(do_post \
  -H "x-api-key: sk-mock-all" \
  -H "Cookie: session=leak-me" \
  -H "X-Forwarded-For: 203.0.113.11" \
  "$API/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-opus","max_tokens":100,"messages":[{"role":"user","content":"header check"}]}')
assert_http "claude header whitelist → 200" "200" "Mock Claude response" "$R"
INSPECT=$(get_mock_inspection "messages")
assert "claude upstream x-api-key replaced with channel key" "\"x-api-key\":\"mock-key\"" "$INSPECT"
assert_not_contains "claude upstream strips client token value" "sk-mock-all" "$INSPECT"
assert_not_contains "claude upstream strips cookie" "\"cookie\":" "$INSPECT"
assert_not_contains "claude upstream strips x-forwarded-for" "\"x-forwarded-for\":" "$INSPECT"

# ---- /v1/messages via claude-to-openai (non-stream) ----
echo ""
echo "--- POST /v1/messages (claude-to-openai, non-stream) ---"

R=$(do_post -H "x-api-key: sk-mock-all" "$API/v1/messages" -H "Content-Type: application/json" -d '{"model":"claude-via-openai","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
assert_http "c2o non-stream → 200" "200" "message" "$R"

# ---- /v1/responses errors ----
echo ""
echo "--- POST /v1/responses (errors) ---"

R=$(do_post "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o-resp","input":"hi"}')
assert_http "no auth → 401" "401" "Authorization header" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"does-not-exist","input":"hi"}')
assert_http "unmapped model → 400" "400" "Model not supported" "$R"

# ---- /v1/responses via openai-responses (non-stream) ----
echo ""
echo "--- POST /v1/responses (openai-responses, non-stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o-resp","input":"hi"}')
assert_http "responses non-stream → 200 + usage" "200" "Mock responses output" "$R"

# ---- /v1/responses via openai-responses (stream) ----
echo ""
echo "--- POST /v1/responses (openai-responses, stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o-resp","stream":true,"input":"hi"}')
assert_http "responses stream → 200 + SSE" "200" "event:" "$R"

# ---- /v1/responses via azure-openai-responses (non-stream) ----
echo ""
echo "--- POST /v1/responses (azure-openai-responses, non-stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o-azure-resp","input":"hi"}')
assert_http "azure responses non-stream → 200" "200" "Mock responses output" "$R"

# ---- /v1/responses via azure-openai-responses (stream) ----
echo ""
echo "--- POST /v1/responses (azure-openai-responses, stream) ---"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o-azure-resp","stream":true,"input":"hi"}')
assert_http "azure responses stream → 200 + SSE" "200" "event:" "$R"

# ---- Cross-protocol conversion ----
echo ""
echo "--- Cross-protocol conversion ---"

R=$(do_post -H "x-api-key: sk-mock-all" "$API/v1/messages" -H "Content-Type: application/json" -d '{"model":"gpt-4o","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}')
assert_http "messages → openai chat" "200" "Mock response from gpt-4o" "$R"
assert "messages → openai chat returns anthropic envelope" '"type":"message"' "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"claude-3-opus","messages":[{"role":"user","content":"hi"}]}')
assert_http "chat → claude" "200" "Mock Claude response" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"claude-3-opus","input":"hi"}')
assert_http "responses → claude" "200" "Mock Claude response" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o-resp","messages":[{"role":"user","content":"hi"}]}')
assert_http "chat → openai responses" "200" "Mock responses output" "$R"

reset_mock_inspection
R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gemini-native-model","messages":[{"role":"user","content":"hi"}]}')
assert_http "chat → gemini native" "200" "Mock Gemini native" "$R"
INSPECT=$(get_mock_inspection "gemini-native")
assert "gemini native upstream path uses generateContent" "models/gemini-2.0-flash:generateContent" "$INSPECT"
assert "gemini native upstream auth uses x-goog-api-key" "\"x-goog-api-key\":\"mock-key\"" "$INSPECT"
assert "gemini native upstream body uses contents" "\"contents\":" "$INSPECT"

R=$(do_post -H "x-api-key: sk-mock-all" "$API/v1/messages" -H "Content-Type: application/json" -d '{"model":"gpt-4o","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}')
assert_http "messages → openai chat stream" "200" "event: message_start" "$R"

R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/responses" -H "Content-Type: application/json" -d '{"model":"gpt-4o","stream":true,"input":"hi"}')
assert_http "responses → openai chat stream" "200" "event: response.output_text.delta" "$R"

# ---- Gemini native inbound ----
echo ""
echo "--- Gemini native inbound (/v1beta/models) ---"

GEMINI_CONTENTS='{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gemini-native-model:generateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound → gemini-native raw" "200" "Mock Gemini native" "$R"
assert "gemini inbound returns gemini envelope" '"candidates"' "$R"

reset_mock_inspection
R=$(do_post \
  -H "x-goog-api-key: sk-mock-all" \
  -H "Authorization: Bearer client-token" \
  -H "Cookie: session=leak-me" \
  -H "X-Forwarded-For: 203.0.113.12" \
  "$API/v1beta/models/gemini-native-model:generateContent" \
  -H "Content-Type: application/json" \
  -d "$GEMINI_CONTENTS")
assert_http "gemini header whitelist → 200" "200" "Mock Gemini native" "$R"
INSPECT=$(get_mock_inspection "gemini-native")
assert "gemini upstream auth uses channel key" "\"x-goog-api-key\":\"mock-key\"" "$INSPECT"
assert_not_contains "gemini upstream strips client token" "sk-mock-all" "$INSPECT"
assert_not_contains "gemini upstream strips cookie" "\"cookie\":" "$INSPECT"
assert_not_contains "gemini upstream strips x-forwarded-for" "\"x-forwarded-for\":" "$INSPECT"
assert "gemini raw upstream keeps contents" "\"contents\":" "$INSPECT"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gemini-native-model:streamGenerateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound stream → 200 + SSE" "200" "data:" "$R"
assert "gemini inbound stream uses sse frames" '"candidates"' "$R"
assert_not_contains "gemini inbound stream has no DONE sentinel" "\[DONE\]" "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gpt-4o:generateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound → openai chat conversion" "200" "Mock response from gpt-4o" "$R"
assert "gemini conversion returns gemini envelope" '"candidates"' "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/claude-3-opus:generateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound → claude conversion" "200" "Mock Claude response" "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gpt-4o-resp:generateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound → responses conversion" "200" "Mock responses output" "$R"

R=$(do_post "$API/v1beta/models/gemini-native-model:generateContent?key=sk-mock-all" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound accepts ?key=" "200" "Mock Gemini native" "$R"

R=$(do_post "$API/v1beta/models/gemini-native-model:generateContent?key=bad-key" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini inbound invalid ?key= → 401" "401" "Invalid API key" "$R"
assert "gemini 401 uses gemini error shape" '"status":"UNAUTHENTICATED"' "$R"

R=$(do_post "$API/v1/chat/completions?key=sk-mock-openai" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
assert_http "?key= is gemini-only → 401" "401" "Authorization header" "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gpt-4o:predict" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini unsupported action → 404" "404" '"error"' "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/does-not-exist:generateContent" -H "Content-Type: application/json" -d "$GEMINI_CONTENTS")
assert_http "gemini unmapped model → 400" "400" '"status":"INVALID_ARGUMENT"' "$R"

R=$(do_post -H "x-goog-api-key: sk-mock-all" "$API/v1beta/models/gpt-4o:generateContent" -H "Content-Type: application/json" -d '{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"image/png","data":"AAAA"}}]}]}')
assert_http "gemini unsupported image part → 400" "400" '"status":"INVALID_ARGUMENT"' "$R"

# ---- Raw passthrough fidelity ----
echo ""
echo "--- Raw passthrough fidelity ---"

reset_mock_inspection
R=$(do_post -H "Authorization: Bearer sk-mock-openai" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}')
assert_http "same-protocol multimodal → 200" "200" "Mock response" "$R"
assert "same-protocol image part forwarded verbatim" "image_url" "$(get_mock_inspection "chat-completions")"

reset_mock_inspection
R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o-exact","messages":[{"role":"user","content":"hi"}]}')
assert_http "exact endpoint channel → 200" "200" "Mock response" "$R"
assert "exact endpoint uses the configured path" "\"path\":\"/exact/chat/completions\"" "$(get_mock_inspection "exact-chat")"

R=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST "$API/v1/audio/speech" -H "Authorization: Bearer sk-mock-all" -H "Content-Type: application/json" -d '{"model":"tts-1","input":"hello world","voice":"alloy"}')
assert "audio speech → 200 audio/mpeg" "200 audio/mpeg" "$R"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/v1/audio/speech" -H "Content-Type: application/json" -d '{"model":"tts-1","input":"hello world","voice":"alloy"}')
assert "audio speech without auth → 401" "401" "$R"

# ---- Quota ----
echo ""
echo "--- Quota check ---"

# Paid-model gating only applies when pricing exists; seed gpt-4o as paid for this check.
"${DB_EXEC[@]}" "INSERT OR REPLACE INTO settings (key, value) VALUES ('MODEL_PRICING_CONFIG', '{\"gpt-4o\":{\"input\":1,\"output\":1}}')" > /dev/null 2>&1
"${DB_EXEC[@]}" "UPDATE api_token SET usage = 99999999 WHERE key = 'sk-mock-all'" > /dev/null 2>&1
R=$(do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[]}')
assert_http "quota exceeded → 402" "402" "Quota exceeded" "$R"
"${DB_EXEC[@]}" "UPDATE api_token SET usage = 0 WHERE key = 'sk-mock-all'" > /dev/null 2>&1
"${DB_EXEC[@]}" "DELETE FROM settings WHERE key = 'MODEL_PRICING_CONFIG'" > /dev/null 2>&1

# ---- Admin cookie session ----
echo ""
echo "--- Admin session cookie ---"

set_system_config_disabled
COOKIE_JAR=$(mktemp)

R=$(do_post "$API/api/admin/auth/login" -H "Content-Type: application/json" -c "$COOKIE_JAR" -d "$LOGIN_PAYLOAD")
assert_http "admin login → 200" "200" "\"requiresVerification\":false" "$R"
assert "admin login response keeps session token out of body" "\"sessionToken\":null" "$R"
assert "admin login sets session cookie" "oaw_admin_session" "$(cat "$COOKIE_JAR")"
LOGIN_BODY=$(echo "$R" | sed '$d')
LOGIN_SESSION_EXPIRES_AT=$(printf '%s' "$LOGIN_BODY" | json_field "data.sessionExpiresAt")
LOGIN_SESSION_TTL_SECONDS=$(ttl_seconds_until_iso "$LOGIN_SESSION_EXPIRES_AT")
assert_between "admin session ttl without Telegram → about 7 days" "$LOGIN_SESSION_TTL_SECONDS" 604200 605400
LOGIN_COOKIE_EXPIRY=$(awk 'NF >= 7 && $6 == "oaw_admin_session" {print $5}' "$COOKIE_JAR")
LOGIN_COOKIE_TTL_SECONDS=$((LOGIN_COOKIE_EXPIRY - $(date +%s)))
assert_between "admin session cookie ttl without Telegram → about 7 days" "$LOGIN_COOKIE_TTL_SECONDS" 604200 605400

R=$(do_get -b "$COOKIE_JAR" "$API/api/admin/channel")
assert_http "admin cookie grants access" "200" "\"success\":true" "$R"

R=$(do_post -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API/api/admin/auth/logout")
assert_http "admin logout → 200" "200" "\"success\":true" "$R"

R=$(do_get -b "$COOKIE_JAR" "$API/api/admin/channel")
assert_http "admin cookie invalid after logout" "401" "Unauthorized" "$R"

rm -f "$COOKIE_JAR"

# ---- Admin cookie session with Telegram ----
echo ""
echo "--- Admin session cookie with Telegram ---"

set_system_config_with_telegram "dummy-bot-token" "123456"
COOKIE_JAR=$(mktemp)
VERIFY_IP="203.0.113.72"
VERIFY_CHALLENGE_ID="challenge-e2e-telegram"
VERIFY_CODE="123456"
seed_login_challenge "$VERIFY_CHALLENGE_ID" "$VERIFY_CODE" "$VERIFY_IP"

R=$(do_post "$API/api/admin/auth/verify" -H "Content-Type: application/json" -H "CF-Connecting-IP: $VERIFY_IP" -c "$COOKIE_JAR" -d "{\"challengeId\":\"$VERIFY_CHALLENGE_ID\",\"code\":\"$VERIFY_CODE\"}")
assert_http "admin verify login → 200" "200" "\"requiresVerification\":false" "$R"
assert "admin verify sets session cookie" "oaw_admin_session" "$(cat "$COOKIE_JAR")"
VERIFY_BODY=$(echo "$R" | sed '$d')
VERIFY_SESSION_EXPIRES_AT=$(printf '%s' "$VERIFY_BODY" | json_field "data.sessionExpiresAt")
VERIFY_SESSION_TTL_SECONDS=$(ttl_seconds_until_iso "$VERIFY_SESSION_EXPIRES_AT")
assert_between "admin session ttl with Telegram → about 30 days" "$VERIFY_SESSION_TTL_SECONDS" 2591400 2592600
VERIFY_COOKIE_EXPIRY=$(awk 'NF >= 7 && $6 == "oaw_admin_session" {print $5}' "$COOKIE_JAR")
VERIFY_COOKIE_TTL_SECONDS=$((VERIFY_COOKIE_EXPIRY - $(date +%s)))
assert_between "admin session cookie ttl with Telegram → about 30 days" "$VERIFY_COOKIE_TTL_SECONDS" 2591400 2592600

R=$(do_get -b "$COOKIE_JAR" "$API/api/admin/channel")
assert_http "admin Telegram session cookie grants access" "200" "\"success\":true" "$R"

R=$(do_post -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$API/api/admin/auth/logout")
assert_http "admin Telegram session logout → 200" "200" "\"success\":true" "$R"

rm -f "$COOKIE_JAR"

# ---- Admin anti-bruteforce ----
echo ""
echo "--- Admin anti-bruteforce ---"

set_system_config_disabled
LIMIT_IP="203.0.113.70"
"${DB_EXEC[@]}" "DELETE FROM admin_rate_limit" > /dev/null 2>&1
for attempt in 1 2 3 4 5; do
  R=$(do_post "$API/api/admin/auth/login" -H "Content-Type: application/json" -H "CF-Connecting-IP: $LIMIT_IP" -d '{"token":"bad-token"}')
  assert_http "admin invalid token attempt $attempt → 401" "401" "管理员令牌无效" "$R"
done
R=$(do_post "$API/api/admin/auth/login" -H "Content-Type: application/json" -H "CF-Connecting-IP: $LIMIT_IP" -d '{"token":"bad-token"}')
assert_http "admin invalid token freeze → 429" "429" "管理员登录失败次数过多" "$R"

# ---- Telegram notification throttle ----
echo ""
echo "--- Telegram notification throttle ---"

THROTTLE_IP="203.0.113.71"
THROTTLE_UNTIL=$(date -u -d "+15 minutes" +"%Y-%m-%dT%H:%M:%SZ")
set_system_config_with_telegram "dummy-bot-token" "123456"
"${DB_EXEC[@]}" "DELETE FROM admin_rate_limit" > /dev/null 2>&1
seed_blocked_rate_limit "admin-telegram-code:ip" "$THROTTLE_IP" 99 "$THROTTLE_UNTIL"
R=$(do_post "$API/api/admin/auth/login" -H "Content-Type: application/json" -H "CF-Connecting-IP: $THROTTLE_IP" -d "$LOGIN_PAYLOAD")
assert_http "telegram code notification throttle → 429" "429" "验证码发送过于频繁" "$R"

# ---- Error recovery ----
echo ""
echo "--- Error recovery ---"

do_post -H "Authorization: Bearer sk-mock-all" "$API/v1/chat/completions" -H "Content-Type: application/json" -d 'bad' > /dev/null 2>&1
R=$(do_post -H "Authorization: Bearer sk-mock-openai" "$API/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
assert_http "recover after error → 200" "200" "Mock response" "$R"

# ---- Summary ----
echo ""
echo "========================================="
echo "  Results: $PASS/$TOTAL PASS, $FAIL FAIL"
echo "========================================="

# Cleanup test data
echo ""
echo "Cleaning up test data..."
for key in test-openai test-azure test-claude test-c2o test-responses test-azure-resp test-gemini-native; do
  "${DB_EXEC[@]}" "DELETE FROM channel_config WHERE key = '$key'" > /dev/null 2>&1
done
for key in sk-mock-all sk-mock-openai sk-mock-quota; do
  "${DB_EXEC[@]}" "DELETE FROM api_token WHERE key = '$key'" > /dev/null 2>&1
done
"${DB_EXEC[@]}" "DELETE FROM admin_rate_limit; DELETE FROM admin_login_challenge; DELETE FROM admin_session; DELETE FROM settings WHERE key = 'SYSTEM_CONFIG'" > /dev/null 2>&1
echo "Cleanup done."

exit $FAIL
