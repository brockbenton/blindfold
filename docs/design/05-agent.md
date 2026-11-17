# 05: Agent

`agents/simple/` has two decision loops over the same tools and wallet. The scripted loop discovers a provider, checks reserves, pays and reports. The LLM loop (`--llm`) lets a model choose which data to buy and decide BUY, SELL or HOLD, while code enforces the limits. Purchases above a threshold wait for the owner's approval in both loops. [Interfaces](00-interfaces.md) · [Runbook](../RUNNING.md#5-agent).

## Scripted decision loop

`runScripted`:

1. Read the wallet balance; refuse an empty budget.
2. Fetch active providers. Pick `--provider` by name, otherwise the first provider whose topics include `--topic`, otherwise the first active provider. Refuse a missing provider or URL.
3. Build `/v1/data/<encoded topic>` from that provider's base URL. The advertised price is advisory; the wallet checks the actual x402 requirement.
4. Before the first call, and again every `RESERVE_CHECK_EVERY` calls, check reserves. With the default 10, checks run before calls 1, 11, 21, … . A failure stops the run before payment.
5. Pay sequentially for `--calls` requests through `wallet.payFetch`, collect results and report balance changes.

The reserve check validates the vault-owned `Config`, configured mint and expected vault account, reads the token balance over Solana RPC, rounds it down to whole cents, then compares it with the mint's reported outstanding liabilities. Missing accounts, mismatches, underfunding, invalid responses and RPC/mint errors return a failed check. Mint-reported issuance is still trusted; a dishonest mint can understate liabilities. The RPC and mint reads are not an atomic snapshot.

## LLM decision loop

`runLlm` (`src/llm.ts`) talks to any OpenAI-compatible chat completions endpoint with plain `fetch`. The default is Gemini's (`gemini-3.5-flash-lite`, falling back to `gemini-flash-latest` when a model is overloaded). The model sees four tools:

| Tool | What the model gets |
|---|---|
| `list_providers` | Name, base URL, price and topics of active providers (no keys) |
| `get_balance` | Remaining tokens in cents |
| `buy_data(url)` | The paid response, or `{refused: reason}` when a limit, the wallet or the owner says no. The description lists the feed's routes: whale flow, depth and premium signals |
| `final_answer(decision, rationale)` | Ends the run |

Each turn:

1. Send the conversation and tools to the model. A reply without tool calls ends the run; BUY, SELL or HOLD is read from the text, defaulting to HOLD.
2. For `buy_data`, code runs these checks in order before any payment:
   - **Budget:** refuse with `budget_exhausted` once the session has spent `--budget` cents (default 30). One purchase can cross the line by at most the per-call cap.
   - **Reserve gate:** before the first paid call and every `RESERVE_CHECK_EVERY` paid calls, check reserves. A failure ends the run with exit 7 before paying. The model cannot skip this; it is not a tool.
   - **Wallet policy:** the wallet pays only providers in the token lock's signer set (or `WALLET_ALLOWLIST`), only the configured asset and mint, only exact amounts up to `--max-per-call`.
   - **Owner approval:** a price above `--approve-over` (default 20 cents) waits for the owner ([below](#owner-approval)). A denial or no answer refuses with `approval_denied` or `approval_timeout`, and the model is told not to retry.
3. Return the result to the model as a tool message. Refusals and HTTP errors are results, not crashes, so a refused hijack attempt or a denied purchase costs nothing and the run continues.
4. Stop after `final_answer`, or with HOLD after 10 model turns.

Provider responses are untrusted input and go to the model unchanged; this is where a prompt injection arrives. The limits above do not depend on the model following instructions. `pnpm demo` Act 6 poisons a feed response with an injection that points the agent at an attacker's server ([demo](../DEMO.md)).

| Flag | Environment | Default |
|---|---|---|
| `--llm` | — | Off (scripted loop) |
| `--goal` | — | `Decide whether to buy <TOPIC> in the next hour.` |
| `--budget` | — | 30 cents |
| — | `LLM_API_KEY` | Required with `--llm` |
| — | `LLM_BASE_URL` | Gemini's OpenAI-compatible endpoint |
| — | `LLM_MODEL` | `gemini-3.5-flash-lite,gemini-flash-latest` (comma-separated fallbacks) |

## Owner approval

The track asks for three guardrails: budgets, allowlists and human approval for large transactions. Approval is enforced by the wallet, not by the model and not by an agent tool:

- **The price is only known from the 402 challenge.** The model sees a URL; the provider's `PAYMENT-REQUIRED` header sets the amount. The wallet's x402 payment hook (`createPaymentPayload`) is the first place that knows the exact price, the provider key and the asset together.
- **Every payment passes through it.** The scripted loop, the LLM loop and any other caller of `payFetch` reach the same hook, so nothing can pay around it. A tool the agent calls to ask permission would be opt-in, and a manipulated model could skip it. The reserve gate is not a tool for the same reason.
- **Last check, before any proof leaves.** The hook asks only after the mint, provider, cap and exact-balance checks pass, so the owner is never asked about a payment the wallet would refuse, and a denial leaves the token file unchanged.

The wallet takes a pluggable `Approver` ([wallet](04-wallet-sdk.md#owner-approval)) and enforces the deadline itself: a late answer, an error or a missing approver is a refusal. The CLI prompts on the terminal when stdin is a TTY (`y` approves) and otherwise refuses above the threshold. `pnpm demo` races the dashboard's Approve/Deny buttons against the terminal prompt ([demo](../DEMO.md)).

The threshold is soft and the per-call cap is hard: a price above `--max-per-call` is refused without asking, so approval only matters when the threshold is below the cap (the defaults, 20 and 10, never ask). Approval stops a manipulated model, not a compromised agent process: it runs in the agent's own wallet code. A protocol-level version (a co-signed reserve pocket) is still planned.

Rate limits (429) and server errors are retried up to three times. With `--json`, the result has `mode: "llm"`, `decision`, `rationale`, `steps` (tool, arguments, outcome, paid cents, refusal reason) and the balance fields.

## CLI

After building, run from the repository root:

```sh
node agents/simple/dist/main.js --fake --json
# Real vault, with required environment exported:
node agents/simple/dist/main.js --topic sol --calls 3 --json
```

| Flag | Environment | Default |
|---|---|---|
| `--token-file` | `TOKEN_FILE` | Required outside fake mode |
| `--mint-url` | `MINT_URL` | `http://localhost:3338` |
| `--max-per-call` | `MAX_PER_CALL_CENTS` | 10 cents |
| `--approve-over` | `APPROVAL_OVER_CENTS` | 20 cents; higher prices need the owner's approval |
| — | `APPROVAL_TIMEOUT_S` | 60; no answer in time is a denial |
| `--topic` | — | `sol` |
| `--provider` | — | Selection described above |
| `--calls` | — | 1 |
| `--json` | — | Off |
| `--fake` | `AGENT_FAKE=1` | Off |
| — | `RESERVE_CHECK_EVERY` | 10 |
| — | `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID`, `USDC_MINT` | Explicitly required outside fake mode |
| — | `WALLET_ALLOWLIST` | Passed to wallet; otherwise union of token signer sets |

Flags override their corresponding environment values. The agent requires explicit chain settings even though the shared loader has defaults. There is no flag that bypasses reserves for a fake-chain mint. LLM-mode flags are listed above.

## Tools and output

`makeTools` exposes `balance`, `list_providers`, `call_paid_api`, `check_reserves` and `report`. There is no approval tool; approval happens inside `call_paid_api`'s wallet payment. Tests can inject provider discovery and reserve readers.

`list_providers` has a 10-second fetch timeout. Payment and reserve operations do not have a general agent-level timeout or retry policy; callers needing deadlines must provide them through their clients. Calls are sequential, so `paidCents` can be measured from wallet balance deltas. `call_paid_api` parses JSON or preserves text, rejects non-2xx responses and optionally includes the x402 redemption ID.

Human output reports provider, topic, calls, balance and reserves. `--json` emits one result object on stdout, with logs on stderr. A success contains `ok`, `provider`, `topic`, `calls`, `balanceBefore`, `balanceAfter`, `paidCents` and `reserves`; each call includes status, paid cents, data and optional `redemptionId`. Failure contains `{ok: false, error: {kind, message, reason?, status?}}`.

| Exit | Meaning |
|---|---|
| 0 | All calls succeeded |
| 1 | Unexpected/internal error |
| 2 | Bad configuration, flags or unreadable token file |
| 3 | Wallet refusal, such as cap, provider, exact-balance failure or an owner denial (`approval_denied`, `approval_timeout`) |
| 4 | Recognized network failure |
| 5 | HTTP error or failed paid retry (the mock API maps settle failures to 402) |
| 6 | No suitable provider or provider URL |
| 7 | Reserve check failed; no subsequent paid call |

`runMain` returns the exit code and releases the wallet lock in `finally`.

## Safety limits

The agent holds tokens, not Solana keys or provider signing keys. It never needs `MINT_ADMIN_TOKEN`. The token lock restricts redemption to registered keys in its signer set; the wallet additionally enforces provider policy, asset/mint checks, exact amount, a per-call cap and owner approval above a threshold. These controls do not stop an agent wasting its entire budget at allowed providers, and leaked tokens can still buy services there.

The reserve gate is enforced by `runScripted` and `runLlm` around paid calls, not by each individual tool, and the LLM loop does not expose `check_reserves` to the model. The LLM loop adds a session budget and a step limit in code. A model fooled by a prompt injection can waste its budget at registered providers, in purchases at or below the approval threshold, but cannot pay anyone else and holds no key to leak.

## Fake mode and tests

`--fake` replaces wallet, providers and reserve reads with stubs. It requires no token file, mint, provider, PostgreSQL or RPC, and does not demonstrate a real payment.

| Variable | Effect in fake mode |
|---|---|
| `FAKE_START_CENTS` | Starting balance, default 100 |
| `FAKE_PRICE_CENTS` | Price, default 5 |
| `FAKE_FAIL_STATUS` | Forced `PaymentFailed` status |
| `FAKE_RESERVES_FAIL=1` | Fail the reserve check |

`scripted.test.ts` covers decisions, gate cadence, refusals and exit reporting. `e2e-local.test.ts` uses wallet/provider/mint fakes. `tests/integration/test/real-mint.test.ts` uses the actual mint and mock API with PostgreSQL and an injected fake chain. The separate real-vault acceptance script validates onchain reserve and settlement behavior; [historical deployment notes](01-vault.md#10-implementation-notes-and-decisions) record a November 16, 2026 pass.

`llm.test.ts` covers the gate before the first purchase, budget refusal, a refused hijack, an owner's denial, the step limit and the chat client. The wallet's `approval.test.ts` covers the threshold, approve, deny, timeout, a missing approver and the approvers themselves. The `exact` baseline client and Copycat, the competitor bot, live in `scripts/` ([demo](../DEMO.md)). The LLM loop uses no SDK; any OpenAI-compatible endpoint works.
