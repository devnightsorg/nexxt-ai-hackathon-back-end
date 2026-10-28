# Raiffeisen Agent — Backend Design

Date: 2026-10-28 · Status: draft for approval

## 1. Intent

Hackathon project. We build a **simulated Raiffeisen Bank România environment** with an
**AI agent that makes users money according to their financial objectives** by steering them
to the right real Raiffeisen products and services (which account to keep money in, when a
term deposit beats a savings account, when a private pension or housing-savings plan fits a
goal, etc.).

The agent is reachable two ways:

1. **Chat** from a web app that imitates the Raiffeisen site (built later, React — out of scope
   here). The web app also shows balances, payments, history, statistics.
2. **MCP** so that an AI agent acting for a customer can talk to the Raiffeisen agent and
   receive personalised offers. For now the MCP server is **not public**: it is reachable only
   with per-user API keys issued for our synthetic clients; no open onboarding of arbitrary
   agents, no OAuth, no public URL. A2A is dropped.

A visible **security middle layer** between the outside world (users, external agents, the LLM)
and the bank core is a deliberate presentation highlight — the jury should be able to *see* it
working (blocked injections, confirmations, audit trail).

This repo is **backend only**: NestJS API + Postgres (with pgvector for RAG), orchestrated with
Docker Compose. The frontend team will consume it later, so the API must be documented
(OpenAPI) and frontend-friendly.

## 2. Goals

- G1. Banking simulation: users, accounts, balances, payments/transfers, transaction history
  with categories, spending/cash-flow statistics.
- G2. Financial objectives (goals) per user, which the agent uses.
- G3. Product catalog of **real** Raiffeisen România retail products (seeded from research of
  raiffeisen.ro; see §8).
- G4. RAG knowledge base: product docs, terms & conditions, fee lists, rules (deposit guarantee,
  investment suitability, KYC/AML, GDPR, complaints) — stored in Postgres/pgvector.
- G5. Agent: chat endpoint where the LLM reads the user's data, searches the KB, computes
  projections via tools, and **suggests** what to do with money; money movement happens only
  through **action proposals the user confirms**.
- G6. Personalised ("custom") offers engine: produces concrete offers for a user (product +
  suggested amount/term + projected gain + why + citations).
- G7. MCP server exposing the agent and offers to customer-side agents, authenticated with
  scoped, per-user API keys (private — not publicly exposed yet).
- G8. Security middle layer (§6) that can be demonstrated.
- G9. `docker compose up` yields a running, migrated, seeded system with demo personas.

## 3. Non-goals

- Real bank integration, real money, PSD2/open banking connectivity.
- The frontend.
- Production-grade identity (OAuth server, MFA, password reset). Auth is real but simple.
- Bank-staff admin UI, multi-bank support, fine-tuning models.
- Live scraping at runtime — product data is captured once and seeded.
- **A2A** (dropped by decision), a **public MCP** endpoint, OAuth for MCP, onboarding of
  external profiles, and a demo persona agent — not now.
- **Simulated time.** The bank is static after seeding: no clock, no interest accrual, no
  maturities, no recurring salaries. The agent shows deterministic **projections** instead.
- **Opening credit products.** Loans, mortgages and credit cards are advice-only: the agent
  can explain them and run an indicative affordability pre-check, but no proposal opens a
  credit product or disburses money. *(Builder's call.)*

## 4. Anti-goals (failure even if it "works")

- The agent recommends a product that is not in the catalog, or quotes a rate/fee that the
  catalog/KB does not contain.
- Money moves without an explicit confirmation by an authorised party.
- Financial numbers (interest, projections, totals) computed by the LLM instead of code.
- Raw sensitive identifiers (full IBANs, CNP, card numbers) sent to the external LLM.
- The demo dies when the LLM is slow or down: balances, payments, stats and rule-based offers
  must keep working without the LLM; agent calls have timeouts and a graceful error message.

## 5. Architecture

```
            ┌──────────────┐   ┌───────────────────┐
 Web app ──▶│  REST (JWT)  │   │ MCP /mcp (API key)│◀── customer-side agents (private)
            └──────┬───────┘   └─────────┬─────────┘
                   └─── Security layer (§6) ───┘
                     authn/authz · rate limit · AI guardrails · policy engine · audit
                                        │
        ┌───────────────┬───────────────┼────────────────┬─────────────────┐
     Banking core    Goals         Agent service      Offers engine     Knowledge (RAG)
  (accounts, txns,                (LLM loop + tools)  (rules + calc,    (ingest, chunk,
   payments, stats)                                    LLM explains)     embed, search)
        └───────────────┴──────── Postgres 16 + pgvector ───────────────┴─────────┘
                                        │
                              Featherless.ai (OpenAI-compatible)
```

### 5.1 Stack (decided)

- **NestJS** (TypeScript) on Node 22.
- **Postgres 16 with pgvector** (`pgvector/pgvector:pg16` image) — one database for banking data
  and RAG vectors.
- **LLM provider: Featherless.ai**, OpenAI-compatible API at `https://api.featherless.ai/v1`,
  key in `.env` (`FEATHERLESS_API_KEY`, never committed). Verified on 2026-10-28 with the real
  key (plan "Request Pricing", concurrency 100, $25 credits):
  - Agent model: **`Qwen/Qwen3-32B`** — native tool calling works on Featherless (returns
    `tool_calls`).
  - Fast "system one" model: **`Qwen/Qwen3-8B`** — for cheap classification (intent,
    injection detection); `/no_think` in the prompt gives short JSON answers.
  - Embeddings: **`Qwen/Qwen3-Embedding-0.6B`** via `POST /v1/embeddings` → **1024-dim**
    vectors.
  - All three are configurable via env (`AGENT_MODEL`, `FAST_MODEL`, `EMBEDDING_MODEL`,
    `EMBEDDING_DIM`). `Qwen/Qwen3-30B-A3B-Instruct-2507` returned a server error in testing —
    don't default to it. `moonshotai/Kimi-K2.6` is available as a stronger fallback agent model.
- **Docker Compose** services: `db` (pgvector), `api` (NestJS, multi-stage Dockerfile). API
  container runs migrations and an idempotent seed on start.
- OpenAPI/Swagger UI at `/docs`.

### 5.2 Modules

| Module | Responsibility |
|---|---|
| `auth` | Login (email + password, seeded demo users), JWT issuing; API-key management for external agents. |
| `security` | Guards, scopes, rate limiting, AI guardrails pipeline, policy engine, hash-chained audit log, security events feed. |
| `users` | Profile + persona attributes (age, occupation, monthly income, risk profile). |
| `banking` | Accounts, transactions, payments/transfers, statistics. |
| `goals` | Financial objectives CRUD + progress. |
| `products` | Product catalog (real Raiffeisen products). |
| `knowledge` | RAG: document ingestion, chunking, embeddings, vector search. |
| `offers` | Personalised offers engine. |
| `agent` | Conversations, LLM tool loop, tools, action proposals. |
| `mcp` | MCP server (Streamable HTTP) at `/mcp`. |
| `llm` | Thin Featherless client (chat, tool calls, embeddings), timeouts, retries, token caps. |
| `seed` | Synthetic personas + transactions, catalog, KB ingestion. |

## 6. Security middle layer (presentation highlight)

Every request from any channel passes through the same layer:

1. **Authentication.**
   - Web users: JWT (short-lived access token) from `POST /auth/login`.
   - Customer-side agents (MCP): per-user **API keys** (`rk_live_…`) sent as
     `Authorization: Bearer`, shown once, stored hashed, each with a name, **scopes**, an
     optional **per-action amount limit**, and revocation. A user creates keys for "their"
     agent (delegated access). The seed creates one key per synthetic client and prints it in
     the seed log, so the MCP server can be exercised immediately (e.g. with MCP Inspector).
2. **Authorisation.** Scopes enforced by guards: `profile:read`, `accounts:read`,
   `transactions:read`, `goals:read`, `goals:write`, `offers:read`, `agent:chat`,
   `actions:propose`, `actions:confirm`. Every resource access is ownership-checked (a key or
   token only ever sees its own user's data). Web JWT has all scopes for its user.
3. **Rate limiting** per user/key (stricter on agent endpoints), plus helmet, CORS, strict DTO
   validation.
4. **AI guardrails ("AI firewall") around every agent turn.**
   - *Input:* heuristic rules + the fast model classify prompt-injection / jailbreak / off-topic;
     blocked inputs return a safe refusal and emit a security event.
   - *PII redaction:* IBANs, CNP, card numbers, emails, phone numbers are masked before any text
     leaves for the LLM (tool results included); amounts, merchants, categories stay.
   - *Tool layer:* per-channel tool allowlist; tool arguments schema-validated; KB content is
     passed as quoted data, never as instructions.
   - *Output:* product mentions are checked against the catalog (unknown product → stripped /
     regenerated); recommendations carry citations; a short disclaimer for investment products.
5. **Policy engine for money movement.** The agent never moves money. It calls
   `propose_*` tools, which create an `ActionProposal` (status `pending`) after policy checks:
   sufficient balance, per-action and daily limits, the key's amount limit, new external IBAN
   flagged as higher risk, investment products require a risk profile compatible with the
   product's risk level. Execution requires **confirmation** by the user (web JWT) or by an API
   key holding `actions:confirm` within its amount limit. Proposals expire (e.g. 15 min).
6. **Tamper-evident audit log.** Append-only table; each row stores `prevHash` and
   `hash = sha256(prevHash + row)`. Logged: logins, key usage, every agent turn (redacted),
   every tool call and its verdict, guardrail blocks, proposals, confirmations, executions.
   An endpoint verifies the chain (demo: "the log has not been tampered with").
7. **Security events feed** (`GET /security/events`) for a dashboard: blocked injections,
   policy denials, rate-limit hits, confirmations — the frontend can show it live.

## 7. Domain model (sketch — builder may refine)

- **User**: id, email, passwordHash, fullName, age, occupation, monthlyIncome, riskProfile
  (`conservative | balanced | dynamic`, from a simplified MiFID-style questionnaire),
  createdAt.
- **Account**: id, userId, type (`current | savings | term_deposit | investment | pension |
  housing_savings | credit_card | loan`), productSlug → Product, iban (simulated RO IBAN with
  Raiffeisen bank code `RZBR`), currency (`RON | EUR`), balance (decimal), status, openedAt,
  terms JSON (rate, maturity, term months…).
- **Transaction**: id, accountId, direction (`in | out`), amount, currency, category (`salary,
  groceries, rent, utilities, transport, dining, entertainment, shopping, travel, health,
  subscriptions, education, transfer_internal, savings, cash, other`), counterpartyName,
  counterpartyIban, description, bookedAt, balanceAfter.
- **Goal**: id, userId, name, type (`emergency_fund | vacation | home | car | education |
  retirement | custom`), targetAmount, currency, targetDate, linkedAccountId (optional),
  priority, status; progress derived from the linked account or contributions.
- **Product**: slug, name, category, summary, details JSON (features, rate/return, fees,
  eligibility, min amount, terms, currencies), goodFor tags, riskLevel, sourceUrls.
- **KbDocument / KbChunk**: document (title, category, productSlug?, sourceUrls, content);
  chunk (documentId, index, content, `embedding vector(1024)`).
- **Offer**: id, userId, productSlug, title, personalisedTerms JSON (suggested amount, term,
  projected gain, monthly contribution), reasoning, citations, score, source (`rules | agent`),
  status (`active | accepted | dismissed | expired`), expiresAt.
- **Conversation / Message**: channel (`web | mcp`), userId, apiKeyId?, messages (role,
  content, tool calls, attachments).
- **ActionProposal**: id, userId, conversationId?, type (`transfer | open_product`), payload
  JSON (`open_product` only for deposit/saving/investment/pension/housing-savings products,
  funded by a transfer from the user's current account), policyVerdict JSON, status (`pending | confirmed | rejected |
  executed | failed | expired`), proposedVia, confirmedBy, timestamps.
- **ApiKey**: id, userId, name, prefix, hash, scopes[], maxAmountPerAction?, lastUsedAt,
  revokedAt.
- **AuditLog**: id, ts, actorType (`user | agent | external_agent | system`), actorId, action,
  resource, verdict (`allowed | blocked`), details JSON, prevHash, hash.

## 8. Product catalog & knowledge base

- Research of raiffeisen.ro (and Raiffeisen Asset Management, Raiffeisen Banca pentru
  Locuințe) — done in this session before implementation — produces `products.json`
  (structured catalog) and one markdown document per product and per general topic (FGDB
  deposit guarantee, investment suitability, general banking conditions, fee list highlights,
  KYC/AML, GDPR, complaints). Content is mostly Romanian (source language). These files live
  in the repo under `seed/knowledge/` and are the single source for both the `Product` table
  and the KB. `products.json` item schema: `slug, name, category, summary, key_features[],
  interest_rate_or_return {value, unit, conditions, as_of} | null, fees[{name, value, notes}],
  eligibility[], min_amount {value, currency} | null, currencies[], terms[], risk_level
  (1–7) | null, good_for[] (goal tags), source_urls[], retrieved_at`.
- Figures that research could not confirm are `null` — the agent must say it doesn't know
  rather than invent.
- Ingestion: markdown → chunks (≈ 800–1200 chars with overlap, split on headings) → embeddings
  (batched) → `KbChunk`. Ingestion is idempotent (content hash), so restarts don't re-embed or
  re-spend credits. An authenticated `POST /knowledge/documents` endpoint adds documents later.
- Search: cosine similarity over pgvector (HNSW index), optionally combined with Postgres
  full-text for hybrid ranking; filter by category/product.

## 9. Agent

- **Loop:** OpenAI-style tool calling against `AGENT_MODEL`, max ~6 tool iterations per turn,
  per-call timeout, token caps. Conversation history persisted.
- **System prompt essentials:** acts as Raiffeisen's financial assistant; answers in the
  user's language (Romanian or English); recommends only catalog products; grounds rules/fees
  in KB results and cites them; numbers come from tools; any money movement goes through
  `propose_*` tools and the user is told it needs confirmation.
- **Tools:**
  - Read: `get_financial_snapshot` (balances, avg monthly income/spend, idle cash, savings
    rate), `get_transactions` (filters), `get_spending_stats` (by category/period),
    `list_goals`, `list_products` (by category / goal tag), `search_knowledge_base`,
    `get_personalised_offers`.
  - Calculate: `simulate_product` (deterministic projection for a product, amount, term —
    interest, tax on interest where applicable, goal reach date).
  - Write (via policy engine): `create_goal`, `propose_transfer`, `propose_open_product`.
- **Response shape** (so the frontend can render cards): `{ reply, recommendations:
  [{productSlug, title, why, projection}], proposals: [{id, type, summary, expiresAt}],
  citations: [{title, sourceUrl}], guardrail: {blocked, reason?} }`.

## 10. Offers engine ("custom offers")

- **Rules + calculation in code** decide *which* products fit and *with what numbers*, e.g.:
  idle cash in the current account above N× monthly spend → savings account / term deposit;
  goal with a date ≥ 12 months and conservative profile → term deposit ladder; home goal →
  housing savings / mortgage pre-check; retirement gap → voluntary pension (with tax-deduction
  note); recurring card debt → cheaper credit option; high subscription spend → spending tip.
- Each offer gets a score, suggested amount/term, projected gain and the citations backing it.
- **The LLM only writes the explanation text** (optional; without the LLM a template text is
  used, so offers work offline).
- Exposed via REST (`GET /offers`, accept/dismiss), the agent tool and MCP. Accepting an
  offer for a deposit/saving/investment/pension/housing-savings product creates an
  `open_product` proposal (same confirmation flow); accepting a credit-product offer only
  records interest and returns the indicative pre-check result.

## 11. Channels / API surface

- **REST (JWT)** — indicative: `POST /auth/login`, `GET /me`, `GET /accounts`,
  `GET /accounts/:id/transactions`, `POST /payments` (user-initiated transfer between own
  accounts or to an external IBAN, executed immediately after validation), `GET /stats/spending`,
  `GET /stats/cashflow`, `/goals` CRUD, `GET /products`, `GET /products/:slug`, `GET /offers`,
  `POST /offers/:id/accept|dismiss`, `POST /agent/chat`, `GET /agent/conversations[/:id]`,
  `GET /actions?status=pending`, `POST /actions/:id/confirm|reject`, `GET /knowledge/search`,
  `POST /knowledge/documents`, `/api-keys` (create/list/revoke), `GET /security/events`,
  `GET /security/audit`, `GET /security/audit/verify`.
- **MCP (`/mcp`, Streamable HTTP, `Authorization: Bearer rk_…`, private)** tools for
  customer-side agents: `get_profile_summary`, `get_financial_snapshot`, `list_goals`,
  `create_goal`, `get_personalised_offers`, `search_knowledge_base`, `list_products`,
  `simulate_product`, `ask_raiffeisen_agent` (free-form conversation with the agent,
  conversation id kept), `propose_action`, `confirm_action` (only with `actions:confirm`),
  `get_action_status`. Each tool requires its matching scope.

## 12. Synthetic data

Deterministic (seeded RNG) generation, ~6 months of history, realistic Romanian merchants
(Kaufland, Lidl, Mega Image, eMAG, Bolt, Uber, Enel, Digi, Netflix, Glovo…), salaries,
rent, utilities, subscriptions. 4 demo personas, each built to trigger a different story:

1. **Andrei, 28, software developer** — high income, ~35k RON idle in the current account,
   dining/travel heavy; goals: Japan trip (15k RON in 8 months) + emergency fund → savings
   account + term deposit, maybe a fund given a dynamic profile.
2. **Maria, 35, teacher** — tight budget, recurring credit-card balance, subscriptions; goal:
   apartment in 3 years → housing savings, spending tips, mortgage pre-check.
3. **Ion, 52, engineer** — large savings, no retirement product; goal: retirement at 65 →
   voluntary pension (tax deduction), conservative funds, deposits.
4. **Elena, 22, student** — small irregular income; goal: laptop / first savings → youth
   account package, small automated savings.

Demo credentials are printed in the README and seed logs.

## 13. Constraints

- `docker compose up --build` must be the only command needed (plus a `.env` with the key).
- Secrets only via env; `.env` git-ignored; `.env.example` committed.
- Credits are limited (request pricing, $25): cap `max_tokens`, cache embeddings, avoid
  re-embedding on restart, no LLM calls in automated tests (mock the LLM client).
- Tests: unit tests for deterministic logic (policy engine, projections, offers rules,
  guardrail heuristics, PII redaction, audit hash chain) and e2e tests for the main REST flows
  with the LLM mocked. A smoke script exercises the running compose stack.

## 14. Timeline & priority (deadline: < 24 h)

Build in this order; each tier must work end-to-end in Docker before the next starts. If time
runs out, cut from the bottom.

1. **P0 — Foundation:** compose + Dockerfile, NestJS skeleton, schema/migrations, seed
   (personas, ~6 months of transactions, catalog, demo API keys), JWT auth, banking REST
   (accounts, transactions, payments, stats), goals, products, Swagger.
2. **P1 — Brain:** Featherless client, RAG ingestion + vector search, agent loop with read
   and calculate tools, `simulate_product`.
3. **P1 — Security:** action proposals + confirm/reject, policy engine, guardrails (heuristic
   + fast-model injection check, PII redaction, catalog check on output), hash-chained audit
   log + verify endpoint, rate limiting, security events feed.
4. **P2 — Offers engine** (rules + projections; LLM explanation optional).
5. **P2 — MCP server** with API-key auth and scopes.
6. **P3 — cut first if late:** hybrid (full-text) search, `POST /knowledge/documents`,
   regenerating answers after a guardrail strip (strip-only is acceptable), SSE streaming.

## 15. Left to the builder

Library choices within NestJS (ORM, MCP/A2A SDKs, validation), folder layout, exact chunking,
hybrid-search weighting, exact rule thresholds, whether chat responses stream (SSE) or return
whole, exact rate-limit numbers, the shape of seed merchants and amounts.
