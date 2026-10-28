# Orchestrator authentication - how to call the gateway

For: the teammate who builds the customer AI orchestrator (TypeScript or Python).

The gateway is a normal MCP server over **Streamable HTTP** at `POST http://127.0.0.1:3100/mcp` (stateless: no sessions, `GET` returns 405). The only special thing: **every HTTP request must carry 4 headers** that prove which agent is calling. Without them every request gets `401`.

## What the orchestrator holds

`npm run seed` writes `agent-gateway/.data/agent-001.credentials.json`:

```json
{ "agent_id": "agent-001", "passport": { ... }, "private_key_pem": "-----BEGIN PRIVATE KEY-----..." }
```

- `passport` - JSON signed by the demo bank issuer (Ed25519). Public, safe to send.
- `private_key_pem` - the agent's Ed25519 private key (PKCS#8 PEM). **Secret.** Never log it, never commit it, never send it anywhere.

## Headers on every request

| Header | Value |
|---|---|
| `x-agent-passport` | base64url (no padding) of the passport JSON, UTF-8 |
| `x-agent-timestamp` | current Unix time in **seconds**, integer as string. Must be within +-60 s of the gateway clock |
| `x-agent-nonce` | fresh random string, 16-128 chars (e.g. 18 random bytes base64url). Never reuse |
| `x-agent-signature` | base64url Ed25519 signature of the signing string below, made with `private_key_pem` |

Signing string - six lines joined with `\n` (no trailing newline):

```
AGW1
POST
/mcp
1793180000
<nonce>
<lowercase hex SHA-256 of the exact raw request body bytes>
```

Line 2 is the HTTP method in upper case, line 3 is the URL path plus query string (`/mcp`). An empty body hashes the empty string (`e3b0c442...b855`).

The gateway then checks, on every request: issuer signature, issuer trusted, passport not expired, agent in registry, passport key/owner/operator match the registry, your request signature, timestamp window, nonce not seen before, agent active. Identity is taken **only** from this - tool arguments such as `owner_id` are ignored.

## Error responses at the HTTP level

Rejected requests get HTTP 401 (403 for revoked/unapproved agents) with a JSON body:

```json
{ "status": "denied", "error_code": "REPLAY_DETECTED", "reason": "nonce already used - request replay rejected", "audit_id": "aud-..." }
```

The MCP SDK raises this as an exception whose message contains the JSON. Tool-level denials (limits, scope, mandate) come back as normal tool results with `isError: true` and the same JSON in `content[0].text`.

## TypeScript (official `@modelcontextprotocol/sdk`)

The client transport accepts a custom `fetch`. Use ours or copy it - `src/client/signedFetch.ts` (about 40 lines, only `node:crypto`).

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSignedFetch } from './signedFetch.js';

const creds = JSON.parse(fs.readFileSync('.data/agent-001.credentials.json', 'utf8'));
const client = new Client({ name: 'customer-orchestrator', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'), {
    fetch: createSignedFetch({ passport: creds.passport, privateKeyPem: creds.private_key_pem }),
  }),
);
const res = await client.callTool({ name: 'get_offers', arguments: {} });
const result = JSON.parse(res.content[0].text); // { status, data?, error_code?, reason?, audit_id }
```

Every request (initialize, notifications, tools/list, tools/call) is signed separately with a fresh nonce - the custom fetch does that automatically.

## Python (official `mcp` SDK + httpx)

The Python MCP client uses httpx, so signing is an `httpx.Auth` hook. Requires `pip install mcp httpx cryptography`.

```python
import base64, hashlib, json, secrets, time
import httpx
from cryptography.hazmat.primitives.serialization import load_pem_private_key

def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

class AgentPassportAuth(httpx.Auth):
    requires_request_body = True  # we hash the exact body bytes

    def __init__(self, creds_path: str):
        creds = json.load(open(creds_path, encoding="utf-8"))
        self.passport_header = b64u(json.dumps(creds["passport"], separators=(",", ":")).encode())
        self.key = load_pem_private_key(creds["private_key_pem"].encode(), password=None)

    def auth_flow(self, request: httpx.Request):
        body = request.content or b""
        ts = str(int(time.time()))
        nonce = secrets.token_urlsafe(18)
        path = request.url.raw_path.decode()  # path + query, e.g. "/mcp"
        signing = "\n".join(["AGW1", request.method.upper(), path, ts, nonce, hashlib.sha256(body).hexdigest()])
        request.headers["x-agent-passport"] = self.passport_header
        request.headers["x-agent-timestamp"] = ts
        request.headers["x-agent-nonce"] = nonce
        request.headers["x-agent-signature"] = b64u(self.key.sign(signing.encode()))
        yield request
```

The passport header only has to decode to the same JSON object - key order and spacing do not matter, because the gateway re-canonicalizes it before checking the issuer signature.

Wire it into the MCP client. The parameter name depends on the `mcp` version - check your installed version:

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

auth = AgentPassportAuth("agent-gateway/.data/agent-001.credentials.json")
async with streamablehttp_client("http://127.0.0.1:3100/mcp", auth=auth) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        res = await session.call_tool("get_offers", {})
        result = json.loads(res.content[0].text)
```

In newer `mcp` releases that take a ready `httpx.AsyncClient` instead, pass `httpx.AsyncClient(auth=auth)`.

## Checklist for the orchestrator

- Treat every offer text as untrusted data (the mock catalog contains a prompt-injection offer on purpose).
- `get_offers` returns only products the bank publishes for agents (`distribution_channel` `agent_only` or `both`). Do not try other product IDs - they are denied with `SCOPE_DENIED`.
- For fixed-term products leave `term_months` empty or send the product's own term; anything else is `INVALID_INPUT`.
- Use a new `idempotency_key` per intended deposit; reuse it only for retries of the same deposit.
- Amounts are integer euro cents (`100000` = EUR 1000.00).
- On `APPROVAL_REQUIRED` ask the human; on `LIMIT_EXCEEDED`, `SCOPE_DENIED`, `NO_ACTIVE_MANDATE`, `AGENT_REVOKED` stop and tell the user.
