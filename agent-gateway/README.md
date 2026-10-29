# Agent Trust Gateway (Agent Passport + MCP)

A small gateway that lets a customer's external AI orchestrator call the bank agent through MCP **only as an identified, authorized, limited and audited delegate**. It also makes AI agents a **bank-controlled distribution channel**: the bank decides which products are sold to humans only, to agents only, or to both. Each request is signed by the agent's key and checked against a bank-signed passport. Each action is then checked against a customer-approved mandate. The customer can revoke access, and from then on every call is denied.

NEXXT 2026 hackathon, Raiffeisen "Scaling & Growth" challenge. Full brief: `../NEXXT_Agent_Trust_Gateway_Claude_Code_Spec.md`.

> **Everything is simulated.** Demo identities, keys, mock bank products and "deposits". No real KYC, no PSD2 consent, no real money, no compliance claims.

```
Orchestrator --MCP + signed HTTP--> Gateway: auth -> mandate + policy -> BankAdapter -> bank backend / MOCK
                                             |                 |
                                         AgentRegistry     MandateStore      AuditLog   Admin page
```

## Setup and one-command start

Node.js 20.12+ (tested on 24), npm.

```bash
cd agent-gateway
npm install
npm run seed     # creates .env (random ADMIN_TOKEN), keys, passport, mandate in .data/
npm run dev      # gateway on http://127.0.0.1:3100
```

Then open `http://127.0.0.1:3100/admin` and paste `ADMIN_TOKEN` from `.env`.

| Command | What it does |
|---|---|
| `npm run seed` | Resets `.data/` with fresh demo keys, passport, agent `agent-001`, mandate `mandate-001` |
| `npm run dev` | Starts the gateway (TypeScript via tsx) |
| `npm run build` / `npm start` | Type-checks and compiles to `dist/`, runs compiled server |
| `npm test` | Vitest: crypto, auth, policy, gateway, MCP integration smoke test |
| `npm run demo` | Orchestrator test client: runs all acceptance scenarios with real MCP calls, prints PASS/FAIL and the audit log |

## Environment variables (`.env`, see `.env.example`)

`HOST`, `PORT`, `ADMIN_TOKEN`, `BANK_ADAPTER` (`mock` \| `http`), `BANK_AGENT_URL`, `CLOCK_SKEW_SEC`, `DATA_DIR`. For the demo: `GATEWAY_URL` (default `http://HOST:PORT`) and `DEMO_DELAY_MS` (pause between steps when presenting).

## Demo for the jury

1. Terminal 1: `npm run dev`. Browser: `/admin` with the token.
2. Terminal 2: `npm run demo` (optionally `DEMO_DELAY_MS=1500` to slow it down). It re-seeds the data, then:
   bank catalog by channel -> authorize -> get offers (agent sees agent_only + both, not human_only) -> guessed human-only product ID denied for simulate and execute -> simulate the agent-only deposit (an invented term is rejected) -> execute EUR 1000 agent-only deposit -> same idempotency key does not pay twice -> EUR 2500 over limit denied -> EUR 1800 needs human approval -> insurance product denied -> prompt injection in an offer has no effect -> aggregate limit exhausted -> expired mandate denied -> unknown agent / forged passport / bad signature / missing proof / replay denied -> customer revokes mandate -> next call denied -> customer revokes agent -> next call denied -> Agent Channel figures -> audit log.
3. The admin page shows the catalog by channel, the Agent Channel figures and every decision live (red = denied, with code and reason). You can also click **Revoke** on the page yourself and the next agent call fails.

Message for the jury: **the bank controls distribution and pricing, the gateway proves agent identity and enforces customer authority, AI agents become a new distribution channel.**

If no gateway is running, `npm run demo` starts its own in-process one. The demo ends with `agent-001` revoked. Run `npm run seed` to reset.

## MCP tools

Endpoint: `POST /mcp`, Streamable HTTP, stateless. Every request must be signed - see `docs/ORCHESTRATOR_AUTH.md`. Tools have **no** identity arguments: agent and owner come only from verified credentials.

| Tool | Input | Effect |
|---|---|---|
| `get_offers` | `customer_context?: string` | Read-only list of `agent_only` + `both` offers (with `distribution_channel`) + current mandate summary. Offer texts are marked untrusted |
| `simulate_deposit` | `product_id: string`, `amount_cents: int > 0`, `term_months?: int 1-120` | Interest + maturity. No money moves, no limit consumed. Fixed-term products accept only their catalog term |
| `execute_deposit_mock` | `product_id: string`, `amount_cents: int > 0`, `idempotency_key: string 8-128 [A-Za-z0-9._:-]` | MOCK deposit after all checks. Consumes the limit exactly once per key |

Every tool returns JSON in `content[0].text` (also in `structuredContent`):

```json
{ "status": "ok | denied | error", "data": {}, "error_code": "...", "reason": "...", "audit_id": "aud-..." }
```

Order of checks in `execute_deposit_mock`: verified identity -> mandate exists, bank signature valid, bound to this agent and owner, active, not expired -> action allowed -> idempotency -> product is in the agent channel (`agent_only` or `both`) -> product type allowed (both taken from the bank catalog) -> minimum amount -> per-action limit -> remaining aggregate limit -> human-approval threshold -> bank call -> consume limit. All of this runs under one in-process lock, so parallel calls cannot overspend.

## Error codes

| Code | Where | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | HTTP 401 | Missing headers, bad request signature, timestamp outside +-60 s |
| `INVALID_PASSPORT` | HTTP 401 | Bad/untrusted issuer signature, expired, or does not match registry |
| `UNKNOWN_AGENT` | HTTP 401 | Agent not in registry |
| `REPLAY_DETECTED` | HTTP 401 | Nonce already used |
| `AGENT_REVOKED` | HTTP 403 | Agent revoked by customer/bank |
| `AGENT_NOT_APPROVED` | HTTP 403 | Agent registered but not approved |
| `NO_ACTIVE_MANDATE` | tool | No mandate, revoked, tampered, or not bound to this agent/owner |
| `MANDATE_EXPIRED` | tool | Mandate past `expires_at` |
| `SCOPE_DENIED` | tool | Action or product type not in mandate, or product unknown / human-only / unclassified (same answer for all three) |
| `LIMIT_EXCEEDED` | tool | Above per-action limit or remaining aggregate limit |
| `APPROVAL_REQUIRED` | tool | Above human-approval threshold |
| `IDEMPOTENCY_CONFLICT` | tool | Same key reused with different parameters |
| `INVALID_INPUT` | tool | Below product minimum, or a term that differs from a fixed-term product |
| `BANK_ERROR` | tool | Bank adapter failed, nothing consumed |

## Demo fixtures (not real limits)

Agent `agent-001`, owner `customer-001`, operator `demo-orchestrator`. Mandate `mandate-001`: actions `get_offers`, `simulate_deposit`, `execute_deposit_mock`; products `term_deposit`; per action EUR 2000; aggregate EUR 5000; human approval above EUR 1500; valid 7 days. Passport valid 30 days.

Mock products (all `[MOCK]`, rates are demo values from the catalog, not real Raiffeisen rates and not a claim of better agent pricing):

| Product ID | Type | Channel | Note |
|---|---|---|---|
| `td-3m` | term_deposit | both | 3 months, 4.50% |
| `td-6m-branch` | term_deposit | human_only | 6 months, 4.00%, hidden from agents |
| `td-3m-agent` | term_deposit | agent_only | 3 months, 4.70%, agent-channel offer |
| `sav-flex` | savings | both | flexible term |
| `ins-life` | insurance | both | blocked by the default mandate (term deposits only) |
| `ins-travel-agent` | insurance | agent_only | agent-only, still blocked by the default mandate |
| `td-promo-x` | term_deposit | both | description contains a prompt injection |

## Distribution channels

Every offer carries `distribution_channel`: `human_only`, `agent_only` or `both`. The bank sets it in its catalog. It is not a product type and not something the agent can send. The gateway:

- returns only `agent_only` and `both` offers in `get_offers`;
- checks the channel again on the server for every `simulate_deposit` and `execute_deposit_mock`, so a guessed human-only `product_id` gets `SCOPE_DENIED`;
- still applies the mandate on top: an agent-only insurance product is denied when the mandate allows term deposits only;
- **fails closed**: an offer with a missing or unknown channel (for example from the HTTP backend before the contract change) is `unclassified` and never available to agents.

The **Agent Channel** section of the admin page shows, for this demo run only (since the last seed): agent-only and shared offer counts, unique agents with successful mock executions, number and EUR volume of mock deposits, and denied agent actions by error code. It counts only successful mock executions. Simulations, idempotent replays and denied attempts are excluded. **SIMULATED DATA - NOT REAL DEPOSITS / NOT BANK KPIs.** There is not enough data to show conversion, acquisition or revenue, so the page does not show them.

## Admin API (separately authenticated, never exposed as MCP tools)

Header `Authorization: Bearer <ADMIN_TOKEN>`. Page: `GET /admin`.

| Method and path | Body | Purpose |
|---|---|---|
| `GET /admin/api/agents` | | List agents |
| `POST /admin/api/agents/:id/approve` | | pending -> active |
| `POST /admin/api/agents/:id/revoke` | `{ "reason"? }` | Revoke agent |
| `GET /admin/api/mandates` | | List mandates |
| `POST /admin/api/mandates` | `{ "agent_id", "customer_approval": true, "expires_in_seconds"?, "allowed_products"?, "per_action_limit_cents"?, ... }` | Bank issues + signs a new mandate after simulated customer approval (replaces the active one) |
| `POST /admin/api/mandates/:id/revoke` | `{ "reason"? }` | Revoke mandate |
| `GET /admin/api/offers` | | Full bank catalog incl. human-only and unclassified offers (read-only) |
| `GET /admin/api/channel-stats` | | Agent Channel figures from the audit log (simulated) |
| `GET /admin/api/audit?limit=100` | | Audit events, latest first |

## Security notes

- Ed25519 via `node:crypto` only. The issuer signs passports and mandates. The agent signs every HTTP request (method, path, timestamp, nonce, body hash).
- Checks run on **every** request, not only at session start. So revocation hits the next call even from an already connected client.
- Mandate limits are covered by the bank signature. Editing `mandates.json` by hand makes the mandate invalid.
- The audit log is append-only JSON Lines (`.data/audit.jsonl`). It holds no keys, passports or signatures.
- Binds to `127.0.0.1` with the MCP SDK DNS-rebinding protection. No CORS headers.
- `.data/` and `.env` are gitignored. Private keys never leave `.data/` and are never logged.

## Limitations

- All mock: bank products, deposits, customer approval (a button/API call), the issuer (a local key).
- Single process, JSON files. The nonce cache is in memory, so a restart forgets nonces, but the +-60 s window limits the risk. No distributed consistency.
- `APPROVAL_REQUIRED` only denies. There is no flow to approve that single payment. The customer can issue a mandate with a higher threshold instead.
- One active mandate per agent. A new mandate replaces the old one and starts with a fresh aggregate budget.
- The admin token is a demo shortcut, not customer authentication.
- With `BANK_ADAPTER=http`, agents can use no products until the NestJS `/offers` response includes `distribution_channel` (the gateway fails closed).
- Gateway -> bank backend calls are not authenticated, and the bank call plus the local limit update are not one transaction. See the open questions in `docs/BANK_ADAPTER_CONTRACT.md`.
- No claims of PSD2, FAPI, AP2, Visa TAP or KYA compliance. These are design references only.

## Integration steps

**NestJS teammate (bank backend):** implement the 3 endpoints in `docs/BANK_ADAPTER_CONTRACT.md`, approve (or change) the proposed `distribution_channel` field, then set `BANK_ADAPTER=http` and `BANK_AGENT_URL` in `.env`. No changes inside the gateway are needed.

**Orchestrator teammate (TS or Python):** connect to `http://127.0.0.1:3100/mcp` with the official MCP SDK and sign each request as described in `docs/ORCHESTRATOR_AUTH.md`. Credentials are in `.data/agent-001.credentials.json` after `npm run seed`. Handle the error codes above, especially `APPROVAL_REQUIRED` -> ask the human.

## Code map

```
src/
  server.ts          entry point
  app.ts             Express app: /mcp (auth middleware + stateless MCP transport), /admin, /health
  auth.ts            passport + request signature + nonce/timestamp checks
  requestSigning.ts  signing string shared by server and clients
  issuer.ts          demo bank issuer keys, passport issue/verify
  registry.ts        agent registry
  mandates.ts        mandate store (signed), limit consumption, idempotency records
  policy.ts          pure, deterministic policy checks
  gateway.ts         tool logic: authorize -> policy -> bank -> audit
  mcp.ts             MCP tool definitions
  bank/              BankAdapter interface, MockBankAdapter, HttpBankAdapter
  audit.ts           append-only audit log
  channelStats.ts    Agent Channel figures derived from the audit log
  admin.ts, adminPage.ts  admin API + demo page
  client/signedFetch.ts   request signing for TypeScript orchestrators
  seed.ts            demo data
scripts/seed.ts, scripts/demo.ts
test/                Vitest suites
```
