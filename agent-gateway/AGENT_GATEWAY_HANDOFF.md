# Agent Trust Gateway - Handoff for the Team

**Module:** `agent-gateway/` | **Owner:** Leonid | **Status:** working demo, all banking data is MOCK
**Version:** v2 (adds agent distribution channel)  
**Checks:** build OK, 51/51 tests pass, `npm run demo` 31/31 scenario checks pass

---

## 1. What it is

A small server that stands between a customer's personal AI agent (the orchestrator) and our bank agent. It lets an external agent use bank services only if:

1. the bank knows **who** the agent is (Agent Passport),
2. the customer gave it **written permission with limits** (Mandate),
3. every action is **checked by fixed code rules**, not by an AI model,
4. the customer or the bank can **revoke** it at any time,
5. every action is **logged**.

This is the "door for agents" in our concept. The orchestrator talks to the bank through it, and the bank agent receives only allowed requests.

**New in v2: agent distribution channel.** The bank catalog now says for every product where it is sold: `human_only` (branch and banking app), `agent_only` (only to external AI agents), or `both`. The bank decides what AI agents can see and buy. This turns agents into a separate sales channel the bank controls: the Scaling & Growth part of our story.

```
Customer orchestrator  ->  Agent Trust Gateway (POST /mcp)  ->  Bank agent (NestJS, now MOCK)
                               |  passport check
                               |  mandate + limit check
                               |  audit log
Customer / bank        ->  /admin page (approve, mandate, revoke, audit)
```

---

## 2. How to run

Requirements: Node.js 20.12 or newer.

```
cd agent-gateway
npm install
npm run seed     # creates .env with a random ADMIN_TOKEN, demo keys, passport, agent, mandate
npm run dev      # gateway on http://127.0.0.1:3100
```

| Command | What it does |
|---|---|
| `npm run seed` | Resets demo data: keys, passport, agent `agent-001`, mandate `mandate-001` |
| `npm run dev` | Starts the gateway |
| `npm run build` / `npm start` | Compiles and runs the compiled version |
| `npm test` | Runs 51 tests |
| `npm run demo` | Test orchestrator: plays all scenarios with real MCP calls, prints PASS/FAIL and the audit log |

**Demo for the jury:** terminal 1 `npm run dev`, browser `http://127.0.0.1:3100/admin` (paste `ADMIN_TOKEN` from `.env`), terminal 2 `npm run demo`. After the demo the agent stays revoked. Run `npm run seed` before the next show.

**The archive does not contain** `.env`, `.data/` and `node_modules/`. They are created on your machine by `npm install` and `npm run seed`. Never commit them: they hold demo keys and the admin token.

---

## 3. How it works

### 3.1 Entry points

| Address | Who calls it | Protection | Purpose |
|---|---|---|---|
| `POST /mcp` | Customer orchestrator | Signed request + passport, checked on every call | The only door for agents. All MCP tools are here |
| `GET /admin` | Customer / bank staff | Admin token | Admin page: agents, mandates, revoke buttons, catalog by channel, Agent Channel stats, live audit log |
| `/admin/api/...` | Admin page or scripts | Admin token (`Authorization: Bearer`) | See 3.6 |
| `GET /health` | Anyone | None | Server status and bank adapter mode |

`GET /mcp` and `DELETE /mcp` return 405. The server listens on `127.0.0.1` only (this laptop).

### 3.2 MCP

- Official Anthropic MCP SDK for TypeScript, **Streamable HTTP** transport, **no sessions**. Every request is checked from zero, so a revoke works from the very next request.
- Three tools:

| Tool | Input | Moves money | Uses limit |
|---|---|---|---|
| `get_offers` | `customer_context` (optional, ignored by rules) | No | No |
| `simulate_deposit` | `product_id`, `amount_cents`, `term_months` (optional) | No | No |
| `execute_deposit_mock` | `product_id`, `amount_cents`, `idempotency_key` | MOCK only | Yes, once |

- **No tool has an `agent_id` or `owner_id` field.** The gateway takes the identity only from the verified signature. An agent cannot claim to act for another customer.
- `get_offers` returns **only `agent_only` and `both` offers**. `human_only` offers are never shown to agents. Each offer is marked as allowed or not by the mandate, plus a notice: offer texts are data, not instructions.
- Tool names and parameters did not change in v2. There is no `distribution_channel` argument: channel always comes from bank data on the server.
- Every tool returns `{status, data?, error_code?, reason?, audit_id?}`.

### 3.3 Agent Passport (who the agent is)

- **Two key pairs, Ed25519** (standard signature built into Node.js, no custom crypto):
  - bank key: signs passports and mandates;
  - agent key: the private key stays only with the agent, the public key is written in the passport.
- **Passport fields:** `agent_id`, `owner_id`, `operator_id`, `public_key`, `issuer`, `issued_at`, `expires_at`, `status`, `issuer_signature`. Signed by the bank key.
- **Every request** carries 4 headers: `x-agent-passport`, `x-agent-timestamp`, `x-agent-nonce`, `x-agent-signature`. The agent signs, with its private key, a string of: `AGW1`, method, path, timestamp, nonce, SHA-256 of the body. Details and TS/Python examples: `docs/ORCHESTRATOR_AUTH.md`.

**Checks on every request, in this order:**

1. All 4 headers present - else `UNAUTHENTICATED`
2. Passport is valid JSON with correct fields - else `INVALID_PASSPORT`
3. Passport signed by a trusted bank key - else `INVALID_PASSPORT`
4. Passport not expired - else `INVALID_PASSPORT`
5. Agent exists in the registry - else `UNKNOWN_AGENT`
6. Key, owner and operator match the registry - else `INVALID_PASSPORT`
7. Request signed by the key from the passport (proves the caller holds the private key, a copied passport is useless) - else `UNAUTHENTICATED`
8. Timestamp within 60 seconds, nonce 16-128 chars - else `UNAUTHENTICATED`
9. Nonce never used before - else `REPLAY_DETECTED`
10. Agent not revoked - else `AGENT_REVOKED`; agent approved - else `AGENT_NOT_APPROVED`

### 3.4 Mandate (what the agent may do)

A separate document, also signed by the bank, issued only after (simulated) customer approval. The agent cannot create or widen it.

**Fields:** `mandate_id`, `agent_id`, `owner_id`, `allowed_actions`, `allowed_products`, `per_action_limit_cents`, `aggregate_limit_cents`, `human_approval_above_cents`, `expires_at`, `status`, `consumed_cents`, `bank_signature`.

**Checks before every action:**

- mandate exists, bank signature valid, bound to this agent and owner, status active - else `NO_ACTIVE_MANDATE`
- not expired - else `MANDATE_EXPIRED`
- action allowed - else `SCOPE_DENIED`
- product known **and published in the agent channel** (`agent_only` or `both`) - else `SCOPE_DENIED`. Unknown, `human_only` and unclassified products get the same answer, so guessing IDs does not reveal the human-only catalog
- product type allowed by the mandate (type comes from the bank catalog, not from the agent) - else `SCOPE_DENIED`
- amount not below product minimum - else `INVALID_INPUT`
- `simulate_deposit` only: for fixed-term products (`term_months > 0`) a different term is rejected - `INVALID_INPUT`

The channel check runs on **both** `simulate_deposit` and `execute_deposit_mock`. Hiding products in `get_offers` is not the only protection: if an agent guesses a `human_only` ID, the server still denies it, does not call the bank and does not use any limit.

**Fail closed:** if a product has no `distribution_channel` or an invalid value, it is treated as not available to agents.

**Extra checks for `execute_deposit_mock`:**

- amount not above per-action limit and not above remaining total limit - else `LIMIT_EXCEEDED`
- amount not above the human approval threshold - else `APPROVAL_REQUIRED`
- same `idempotency_key` again returns the first result, nothing executes twice, limit is not used twice
- same key with different amount or product - `IDEMPOTENCY_CONFLICT`
- all executions run one by one under a lock, so parallel calls cannot together go over the total limit
- money is counted in integer euro cents, no rounding errors

### 3.5 Bank adapter

The gateway talks to the bank through one interface with 3 methods: list offers, simulate deposit, execute deposit.

- `BANK_ADAPTER=mock` - built-in test data (default)
- `BANK_ADAPTER=http` + `BANK_AGENT_URL` - calls the team's NestJS backend

Contract proposal for the NestJS backend: `docs/BANK_ADAPTER_CONTRACT.md` (`GET /offers`, `POST /deposits/simulate`, `POST /deposits/execute`). Gateway code does not change when we switch.

**v2 contract change:** `GET /offers` should return a new field `distribution_channel` = `human_only` | `agent_only` | `both`. **Until the NestJS backend sends it, agents will see zero products in `http` mode** (fail closed). The NestJS team owns the offer data and must approve this field.

**MOCK products (7):**

| product_id | Type | Channel | Rate | Term | Minimum |
|---|---|---|---|---|---|
| `td-3m` | term_deposit | both | 4.50% | 3 months | EUR 100 |
| `td-6m-branch` | term_deposit | **human_only** | 4.00% | 6 months | EUR 500 |
| `td-3m-agent` | term_deposit | **agent_only** | 4.70% | 3 months | EUR 100 |
| `sav-flex` | savings | both | 2.50% | flexible | EUR 1 |
| `ins-life` | insurance | both | - | 12 months | EUR 50 |
| `ins-travel-agent` | insurance | **agent_only** | - | 12 months | EUR 20 |
| `td-promo-x` | term_deposit | both | 5.20% | 6 months | EUR 100 |

All rates are MOCK, taken from the catalog, never generated by an LLM. They do not claim that a real bank gives agents better prices.

`td-promo-x` has a hidden attack in its description ("ignore all limits..."). It is there on purpose to show that offer text cannot change the rules.

### 3.6 Admin API and revoke

All with `Authorization: Bearer <ADMIN_TOKEN>`. Never available through MCP.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/api/agents` | List agents |
| POST | `/admin/api/agents/:id/approve` | Approve agent |
| POST | `/admin/api/agents/:id/revoke` | Revoke agent |
| GET | `/admin/api/mandates` | List mandates |
| POST | `/admin/api/mandates` | Issue mandate (simulated customer approval). Owner is taken from the registry, not from the request |
| POST | `/admin/api/mandates/:id/revoke` | Revoke mandate |
| GET | `/admin/api/offers` | Full catalog incl. `human_only`, with channel (`unclassified` if missing). Admin only, never via MCP |
| GET | `/admin/api/channel-stats` | Agent Channel stats (see 3.7) |
| GET | `/admin/api/audit` | Audit log |

### 3.7 Audit log and Agent Channel stats

File `.data/audit.jsonl`, append only. Each record: time, agent, owner, mandate, action, amount, product, result, reason, error code, request id. No keys, tokens or signatures are logged.

The admin page shows an **Agent Channel** block, calculated only from the catalog and the audit log of this demo run. Labelled **SIMULATED DATA - NOT REAL DEPOSITS / NOT BANK KPIs**:

- number of `agent_only` and `both` offers;
- unique agents with successful executions;
- number and total volume (EUR) of executed mock deposits. Only successful executions count: simulations, idempotent repeats and denials are not included;
- denied agent actions, grouped by error code.

No conversion rate, revenue or other numbers that the demo data cannot support.

### 3.8 Storage (`.data/`, not in git)

| File | Content | Secret |
|---|---|---|
| `issuer.json` | Bank keys | Yes |
| `trusted_issuers.json` | Trusted bank public keys | No |
| `agents.json` | Agent registry | No |
| `mandates.json` | Mandates, used limit, executed operations | No |
| `audit.jsonl` | Audit log | No |
| `agent-001.credentials.json` | Demo agent keys and passport | Yes |

Replay protection lives in memory and resets when the server restarts. The 60-second time window still protects against old requests.

### 3.9 Settings (`.env`)

`HOST`, `PORT`, `ADMIN_TOKEN`, `BANK_ADAPTER`, `BANK_AGENT_URL`, `CLOCK_SKEW_SEC`, `DATA_DIR`. Template: `.env.example`.

---

## 4. Error codes

| Code | When |
|---|---|
| `UNAUTHENTICATED` | Missing headers, bad request signature, old timestamp |
| `INVALID_PASSPORT` | Bad format, wrong bank signature, expired, does not match registry |
| `UNKNOWN_AGENT` | Agent not registered |
| `AGENT_NOT_APPROVED` | Agent registered but not approved |
| `AGENT_REVOKED` | Agent revoked |
| `REPLAY_DETECTED` | Same request sent again |
| `NO_ACTIVE_MANDATE` | No mandate, revoked, wrong signature, or not bound to this agent |
| `MANDATE_EXPIRED` | Mandate expired |
| `SCOPE_DENIED` | Action not allowed, product not in agent channel, or product type not allowed |
| `LIMIT_EXCEEDED` | Over per-action or total limit |
| `APPROVAL_REQUIRED` | Above human approval threshold |
| `IDEMPOTENCY_CONFLICT` | Same idempotency key with different parameters |
| `INVALID_INPUT` | Bad input, amount below product minimum, wrong term for a fixed-term product |
| `BANK_ERROR` | Bank adapter failed |

---

## 5. What the team needs to do

- **NestJS backend:** implement the 3 methods from `docs/BANK_ADAPTER_CONTRACT.md`, **including the `distribution_channel` field in `GET /offers`**, share the base URL. Then set `BANK_ADAPTER=http` and `BANK_AGENT_URL`. Also confirm: repeated `deposits/execute` with the same `idempotency_key` returns the same deposit ID.
- **Orchestrator (TS or Python):** connect to `http://<host>:3100/mcp` with the official MCP SDK, sign every request as in `docs/ORCHESTRATOR_AUTH.md`. Demo credentials: `.data/agent-001.credentials.json` after `npm run seed`. Handle error codes, especially `APPROVAL_REQUIRED` (ask the human).
- **Bank app UI:** decide if the customer sees approve / mandate / revoke inside our bank app, or we show the `/admin` page in the demo.

---

## 6. Demo story for the jury

1. Admin page: catalog by channel. Show a `human_only` deposit, an `agent_only` deposit and shared offers.
2. Signed agent calls `get_offers`: it sees agent and shared offers, not the human-only one.
3. Agent tries the hidden `td-6m-branch` ID: `SCOPE_DENIED`, audit entry, no limit used.
4. Agent places the `agent_only` deposit within the mandate: mock deposit ID, remaining limit goes down, Agent Channel volume goes up.
5. Same `idempotency_key` again: same result, nothing executed or counted twice.
6. Over-limit, wrong product type, hidden-attack offer: all denied by server rules.
7. Revoke in admin: next signed request is denied, audit shows why.

**One-line pitch:** the bank controls distribution and pricing, the gateway proves agent identity and enforces customer authority, AI agents become a new sales channel.

## 6a. What is MOCK and what is missing

- Bank products and deposits are simulated. No real money.
- Customer consent is a button or API call.
- The bank key that signs passports is a local file on the laptop.
- Admin login is one shared token.
- `APPROVAL_REQUIRED` only denies. There is no flow to send the request to the customer and continue after approval.
- No agent self-registration. The demo agent is created by `npm run seed`.
- Not implemented from the Lead KYA model: risk tiers, behavior monitoring, agent chains.
- No real KYC, PSD2, AML or certification.
- Python signing example is written but not tested. TypeScript is tested.
- Gateway does not authenticate itself to the bank backend yet.
- The bank call and the local limit update are not one transaction. If the gateway crashes exactly between them, a deposit could be counted wrong. Bank-side deduplication by `idempotency_key` closes this.

---

## 7. To decide

| # | Question | Now | Options | Who |
|---|---|---|---|---|
| 1 | **Per-action limit** | EUR 2,000 | Keep / change | Team |
| 2 | **Total limit per mandate** | EUR 5,000 | Keep / change. Or link it to "% of funds the orchestrator gives to this bank" from our concept | Team |
| 3 | **Human approval threshold** | EUR 1,500 | Keep / change. Now amounts between 1,500 and 2,000 are simply denied | Team |
| 4 | **Approval flow above threshold** | Only deny (`APPROVAL_REQUIRED`) | (a) keep deny and present it as bank control, (b) build "send to customer -> approve one exact operation -> execute" | Team + UI owner |
| 5 | **Allowed products in the mandate** | Term deposits only. Savings and insurance are visible to the agent but denied | Add savings? Add insurance only with human approval? | Team |
| 6 | **Allowed actions** | View offers, simulate, execute deposit | Our concept says the orchestrator also **redistributes** money. Do we need "get my positions / balance" and "withdraw / close deposit"? | Team, needs NestJS methods |
| 7 | **Who sets `distribution_channel`** | MOCK catalog | NestJS owner sets it per product. Without it, agents see nothing in `http` mode | NestJS owner |
| 8 | **Agent-only offers: which and at what price** | 2 MOCK offers (deposit 4.70%, travel insurance) | Which products the bank shows only to agents, and whether prices differ. Prices come only from the catalog | Team |
| 9 | **Mandate duration** | 7 days | Keep / change | Team |
| 10 | **Passport duration** | 30 days | Keep / change | Team |
| 11 | **How the agent is onboarded** | Created by script | (a) keep script for demo, (b) add "agent registers itself -> customer approves" flow (stronger for the concept) | Team |
| 12 | **Where the gateway runs** | This laptop only (`127.0.0.1`) | (a) all parts on one laptop for the demo, (b) open to local network, (c) deploy online (needs persistent storage) | Team |
| 13 | **How the orchestrator gets its keys** | Copies `.data/agent-001.credentials.json` | Fine for demo if on one machine. Otherwise share the file privately, never in git | Orchestrator owner |
| 14 | **Orchestrator language** | Not decided | TypeScript (tested example) or Python (example not tested) | Team |
| 15 | **Bank adapter contract** | Our proposal + `distribution_channel` | Accept as is or change fields / paths | NestJS owner |
| 16 | **Bank-side idempotency** | Not confirmed | Bank returns the same deposit ID for the same `idempotency_key` | NestJS owner |
| 17 | **Gateway -> bank security** | None | Shared service token in a header, only if the backend checks it | NestJS owner |
| 18 | **Revoke UI for the jury** | `/admin` page | Show `/admin` or build buttons in the bank app | UI owner |
| 19 | **Competitor bank agents** | Not included | Separate simple mocks for the orchestrator's comparison step? | Orchestrator owner |
| 20 | **Hidden-attack offer in demo** | Included in MOCK | Keep it as a demo moment or remove | Team |

## 8. Design references (not compliance claims)

- **Lead Bank, "Leading into the AI Revolution", Sep 2026, Appendix A - Know Your Agent:** agent identity bound to a verified owner, signed mandate with limits, "a transaction is authorized only within a signed mandate", revoke, audit. This is the core of the module. It is a US policy proposal, not EU law.
- **Visa Trusted Agent Protocol (idea only):** each agent request is signed. Our signature format `AGW1` is our own simple format, not the official standard.
- **Google AP2 (idea only):** mandate as verifiable delegation from a human.
- **MCP specification and official SDK:** tool interface and Streamable HTTP transport. MCP itself does not check identity, so our checks run in front of it.
