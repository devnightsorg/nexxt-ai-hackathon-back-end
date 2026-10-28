# Bank adapter contract (proposal)

For: the NestJS teammate who owns the banking agent/backend.

The gateway never touches your internals. It calls 3 HTTP endpoints under `BANK_AGENT_URL`. Until they exist the gateway uses `MockBankAdapter` (fixtures in `src/bank/mock.ts`, every title starts with `[MOCK]`). Switch with:

```
BANK_ADAPTER=http
BANK_AGENT_URL=http://127.0.0.1:3000/bank-agent
```

Rules for all endpoints:
- JSON in, JSON out, `Content-Type: application/json`.
- **Money is always integer euro cents** (`amount_cents`, `min_amount_cents`). Rates are integer basis points (`450` = 4.50% p.a.). No floats.
- Non-2xx status = error. The gateway answers the agent with `BANK_ERROR` and consumes no limit.
- Timeout 5 s per call.
- Responses are validated with a schema (`src/bank/types.ts`); unknown extra fields are dropped.
- The gateway calls you **only after** its own checks (identity, mandate, product scope, limits, idempotency). You do not need to re-implement them, but you may.
- Calls come from the gateway process on the same machine. There is no auth between gateway and backend in the demo - keep the backend on localhost.

## 1. `GET /offers`

Response `200`:

```json
[
  {
    "product_id": "td-3m",
    "product_type": "term_deposit",
    "title": "Term Deposit 3 months",
    "rate_bps": 450,
    "term_months": 3,
    "min_amount_cents": 10000,
    "description": "Fixed rate 4.50% p.a. for 3 months.",
    "distribution_channel": "both"
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `product_id` | string, 1-64, `[a-z0-9-]` | stable id, used by the agent in the other calls |
| `product_type` | `term_deposit` \| `savings` \| `insurance` | **policy uses this**: the mandate allows product types |
| `title` | string <= 200 | |
| `rate_bps` | integer >= 0 | |
| `term_months` | integer >= 0 | 0 = no fixed term |
| `min_amount_cents` | integer >= 0 | gateway rejects smaller amounts |
| `description` | string <= 2000 | free text, treated as **untrusted** |
| `distribution_channel` | `human_only` \| `agent_only` \| `both` | **PROPOSED, needs NestJS team approval** - see below |

### Proposed change: `distribution_channel` (needs approval from the NestJS team)

The bank owns one catalog and decides where each product is sold:

| Value | Human banking UI | External AI agent via MCP |
|---|---|---|
| `human_only` | yes | no |
| `agent_only` | no | yes (still subject to mandate and limits) |
| `both` | yes | yes (still subject to mandate and limits) |

- This is distribution eligibility set by the bank. It is not a product type, not a permission and not an AI decision. Rates and terms of agent offers come from your catalog, the gateway never creates or changes them.
- **The NestJS team owns the offer data.** This field is only a proposal until you approve it. Please confirm who sets the value and how agent-only terms are approved inside the bank.
- **Fail closed in the gateway:** if the field is missing or has any other value, the gateway treats the offer as `unclassified`. Unclassified offers are not shown to agents in `get_offers`, and `simulate_deposit` / `execute_deposit_mock` reject them with `SCOPE_DENIED`. The rest of your response still works. **So with `BANK_ADAPTER=http`, agents can use no products until `/offers` includes this field.**
- The gateway checks the channel on the server on every simulate and execute call, not only when it filters the list. An agent that guesses a human-only `product_id` is still denied.
- The bank admin page in the gateway (`/admin`, admin token) shows the full catalog grouped by channel, including human-only and unclassified products. MCP clients never see that list.

Fixed-term products: if `term_months > 0`, the gateway only simulates with exactly that term. Any other `term_months` from the agent gets `INVALID_INPUT` before your `/deposits/simulate` is called. Products with `term_months: 0` (flexible) accept any term from 1 to 120 months.

## 2. `POST /deposits/simulate`

Request:

```json
{ "product_id": "td-3m", "amount_cents": 100000, "term_months": 3 }
```

Response `200`:

```json
{
  "product_id": "td-3m",
  "amount_cents": 100000,
  "term_months": 3,
  "rate_bps": 450,
  "expected_interest_cents": 1125,
  "maturity_date": "2027-01-28"
}
```

No money moves, nothing is stored. Mock formula: `floor(amount_cents * rate_bps * term_months / 120000)`.

## 3. `POST /deposits/execute` - MOCK only

Request:

```json
{
  "product_id": "td-3m",
  "amount_cents": 100000,
  "idempotency_key": "demo-exec-0001",
  "agent_id": "agent-001",
  "owner_id": "customer-001",
  "mandate_id": "mandate-001"
}
```

Response `200`:

```json
{ "deposit_id": "DEP-123", "status": "executed_mock" }
```

- `agent_id`, `owner_id`, `mandate_id` come from verified gateway state, not from the AI agent.
- Please treat `idempotency_key` as unique per owner: same key again -> return the same `deposit_id`, do not create a second one. (The gateway already deduplicates, this is defence in depth.)
- No real money must move in the hackathon.

## Open questions for the NestJS team (not implemented in the gateway yet)

- **Idempotency on your side:** will `POST /deposits/execute` return the same `deposit_id` for a repeated `idempotency_key`? The gateway deduplicates locally. But the bank call and the local limit update are not one transaction: if the gateway crashes right after your execute succeeds, the next retry could execute again unless you deduplicate. The gateway never auto-retries execute.
- **Gateway -> backend authentication:** today there is none (localhost only). Proposal: a shared service token in an env var, sent as a header and verified by you. We add it only when you agree to verify it. Until both ends enforce it, the bank API is **not** secured.
- **Network:** same laptop or separate machine? Which URL and prefix?

## How to integrate

1. Implement the 3 routes in the NestJS backend (any prefix, e.g. `/bank-agent`).
2. Add `distribution_channel` to every offer in `GET /offers` once you agree with the proposal above. Without it no product is available to agents.
3. Put the base URL into `agent-gateway/.env` as `BANK_AGENT_URL`, set `BANK_ADAPTER=http`.
4. `npm run dev` in `agent-gateway`, then `npm run demo`. The demo uses these mock ids: `td-3m` (both), `td-6m-branch` (human_only), `td-3m-agent` (agent_only), `ins-life` (both), `ins-travel-agent` (agent_only), `td-promo-x` (both). If your catalog uses other ids, the demo steps that use them will fail - either add these ids to your test data or tell Leonid which ids to use.
