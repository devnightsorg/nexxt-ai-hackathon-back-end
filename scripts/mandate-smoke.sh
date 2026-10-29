#!/usr/bin/env bash
# End-to-end check of the agent mandate flow, playing the part of claude.ai (no LLM calls):
# OAuth discovery -> register -> authorize -> customer signs in the app -> token -> MCP actions under the mandate
# (auto-executed, needs approval, external payment) -> customer approves / rejects -> revoke -> agent refused.
# Usage: ./scripts/mandate-smoke.sh [BASE_URL] [PERSONA_EMAIL]   (default http://localhost:3000, ion.georgescu@demo.ro)
# Moves real demo money (1,500 + 5,000 lei) on the persona. Needs only curl and node.
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
EMAIL="${2:-ion.georgescu@demo.ro}"
PASSWORD='Demo1234!'
REDIRECT='https://claude.ai/api/mcp/auth_callback'
EXTERNAL_IBAN='RO49AAAA1B31007593840000'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STEP=''
fail() {
  echo "MANDATE SMOKE FAIL at step: $STEP${1:+ — $1}" >&2
  if [ -s "$TMP/body" ]; then head -c 600 "$TMP/body" >&2; echo >&2; fi
  exit 1
}
step() { STEP="$1"; echo "-> $1"; }

# js EXPR — evaluates EXPR with `b` = the JSON in $TMP/body and prints the result.
js() {
  node -e '
    const fs = require("fs");
    const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$TMP/body" "$1"
}

# call METHOD PATH [JSON_BODY] [BEARER] — body to $TMP/body, headers to $TMP/headers, HTTP status to $CODE.
CODE=''
call() {
  local method="$1" path="$2" data="${3:-}" token="${4:-}"
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$method" --max-time 60 -H 'content-type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ] && args+=(-d "$data")
  CODE="$(curl "${args[@]}" "$BASE_URL$path")" || fail "curl failed"
}

# tool NAME ARGS_JSON — MCP tools/call with the mandate key; the tool's text to $TMP/body, isError to $TOOL_ERROR.
TOOL_ERROR=''
tool() {
  curl -s -o "$TMP/rpc" -X POST --max-time 60 "$BASE_URL/mcp" -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" || fail "curl failed"
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
    fs.writeFileSync(process.argv[2], r.content[0].text);
    process.stdout.write(r.isError ? "true" : "false");
  ' "$TMP/rpc" "$TMP/body" > "$TMP/err" || fail "bad MCP response: $(head -c 300 "$TMP/rpc")"
  TOOL_ERROR="$(cat "$TMP/err")"
}

step "MCP without a token answers 401 with OAuth discovery"
call POST /mcp '{}'
[ "$CODE" = 401 ] || fail "expected 401, got $CODE"
grep -qi 'www-authenticate: Bearer resource_metadata=' "$TMP/headers" || fail "no WWW-Authenticate resource_metadata"

step "OAuth metadata"
call GET /.well-known/oauth-protected-resource
[ "$(js 'b.authorization_servers.length')" = 1 ] || fail
call GET /.well-known/oauth-authorization-server
[ -n "$(js 'b.registration_endpoint')" ] || fail

step "dynamic client registration"
call POST /oauth/register "{\"client_name\":\"Claude\",\"redirect_uris\":[\"$REDIRECT\"]}"
[ "$CODE" = 201 ] || fail "expected 201, got $CODE"
CLIENT_ID="$(js 'b.client_id')"

step "authorize hands the browser to the PWA mandate screen"
call GET "/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT&state=s1&code_challenge=x&code_challenge_method=S256"
[ "$CODE" = 302 ] || fail "expected 302, got $CODE"
grep -qi '^location: .*/connect/authorize?.*client_id=' "$TMP/headers" || fail "unexpected redirect"

step "customer signs the mandate in the app ($EMAIL)"
call POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
JWT="$(js 'b.accessToken')"
[ -n "$JWT" ] || fail "login failed"
call POST /mandates/authorize "{\"clientId\":\"$CLIENT_ID\",\"redirectUri\":\"$REDIRECT\",\"state\":\"s1\",\"permissions\":{\"read\":true,\"deposits\":true,\"ownTransfers\":true,\"externalPayments\":true}}" "$JWT"
[ "$CODE" = 200 ] || fail "sign returned $CODE"
AUTH_CODE="$(js 'new URL(b.redirectTo).searchParams.get("code")')"
[ "$(js 'new URL(b.redirectTo).searchParams.get("state")')" = s1 ] || fail "state not returned"

step "token exchange (code is single-use)"
curl -s -o "$TMP/body" -X POST "$BASE_URL/oauth/token" --data-urlencode grant_type=authorization_code \
  --data-urlencode "code=$AUTH_CODE" --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "client_id=$CLIENT_ID" || fail
KEY="$(js 'b.access_token')"
[ -n "$KEY" ] || fail "no access_token"
call POST /oauth/token "{\"grant_type\":\"authorization_code\",\"code\":\"$AUTH_CODE\"}"
[ "$CODE" = 400 ] || fail "reused code accepted"

step "mandate key is refused on the REST API"
call GET /accounts '' "$KEY"
[ "$CODE" = 401 ] || fail "expected 401, got $CODE"

step "agent reads accounts and goals"
call GET /accounts '' "$JWT"
FROM="$(js 'b.filter(a=>["current","savings"].includes(a.type)&&a.status==="active").sort((x,y)=>y.balance-x.balance)[0].id')"
[ -n "$FROM" ] || fail "no source account"
tool list_goals '{}'
[ "$TOOL_ERROR" = false ] || fail
GOAL="$(js 'b[0] ? b[0].id : ""')"
GOAL_ARG=''
[ -n "$GOAL" ] && GOAL_ARG=",\"goalId\":\"$GOAL\""

step "1,500 lei savings account executes at once under the mandate"
tool propose_action "{\"type\":\"open_product\",\"productSlug\":\"cont-economii-super-acces-plus\",\"fromAccountId\":\"$FROM\",\"amount\":1500$GOAL_ARG}"
[ "$TOOL_ERROR" = false ] || fail
[ "$(js 'b.status')" = executed ] || fail "expected executed"
[ "$(js 'b.mandate.decision')" = executed_under_mandate ] || fail

step "5,000 lei deposit needs the customer's approval"
tool propose_action "{\"type\":\"open_product\",\"productSlug\":\"depozit-termen-lei\",\"termMonths\":12,\"fromAccountId\":\"$FROM\",\"amount\":5000}"
[ "$TOOL_ERROR" = false ] || fail
[ "$(js 'b.status')" = pending ] || fail "expected pending"
case "$(js 'b.mandate.approvalUrl')" in */approve/*) ;; *) fail "no approvalUrl" ;; esac
DEPOSIT="$(js 'b.id')"

step "200 lei to an external IBAN always needs approval"
tool propose_action "{\"type\":\"transfer\",\"fromAccountId\":\"$FROM\",\"toIban\":\"$EXTERNAL_IBAN\",\"beneficiaryName\":\"Factura urgenta SRL\",\"amount\":200}"
[ "$TOOL_ERROR" = false ] || fail
[ "$(js 'b.status')" = pending ] || fail "expected pending"
EXTERNAL="$(js 'b.id')"

step "agent cannot approve its own request"
tool confirm_action "{\"proposalId\":\"$DEPOSIT\"}"
[ "$TOOL_ERROR" = true ] || fail "confirm_action should be refused"

step "customer approves the deposit and rejects the external payment in the app"
call POST "/actions/$DEPOSIT/confirm" '' "$JWT"
[ "$(js 'b.status')" = executed ] || fail "deposit not executed ($CODE)"
call POST "/actions/$EXTERNAL/reject" '' "$JWT"
[ "$(js 'b.status')" = rejected ] || fail "external not rejected ($CODE)"
tool get_action_status "{\"proposalId\":\"$DEPOSIT\"}"
[ "$(js 'b.status')" = executed ] || fail

step "connected agent page data"
call GET /mandates '' "$JWT"
[ "$(js 'b[0].status')" = active ] || fail
[ "$(js 'b[0].used')" = 6500 ] || fail "used should be 6500, got $(js 'b[0].used')"
[ "$(js 'b[0].recentActions.length')" = 3 ] || fail
MANDATE="$(js 'b[0].id')"

step "revoke: the agent is refused from its next call"
call POST "/mandates/$MANDATE/revoke" '' "$JWT"
[ "$(js 'b.status')" = revoked ] || fail
tool get_financial_snapshot '{}'
[ "$TOOL_ERROR" = true ] || fail "revoked mandate still works"
grep -q MANDATE_REVOKED "$TMP/body" || fail "no MANDATE_REVOKED"

echo "MANDATE SMOKE OK"
