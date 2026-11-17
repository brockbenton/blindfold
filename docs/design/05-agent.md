# 05: Agent

`agents/simple/` has two decision loops over the same tools and wallet. The scripted loop discovers a provider, checks reserves, pays and reports. The LLM loop (`--llm`) lets a model choose which data to buy and decide BUY, SELL or HOLD, while code enforces the limits. [Interfaces](00-interfaces.md) · [Runbook](../RUNNING.md#5-agent).

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
| `buy_data(url)` | The paid response, or `{refused: reason}` when a limit or the wallet says no |
| `final_answer(decision, rationale)` | Ends the run |

Each turn:

1. Send the conversation and tools to the model. A reply without tool calls ends the run; BUY, SELL or HOLD is read from the text, defaulting to HOLD.
2. For `buy_data`, code runs these checks in order before any payment:
   - **Budget:** refuse with `budget_exhausted` once the session has spent `--budget` cents (default 30). One purchase can cross the line by at most the per-call cap.
   - **Reserve gate:** before the first paid call and every `RESERVE_CHECK_EVERY` paid calls, check reserves. A failure ends the run with exit 7 before paying. The model cannot skip this; it is not a tool.
   - **Wallet policy:** the wallet pays only providers in the token lock's signer set (or `WALLET_ALLOWLIST`), only the configured asset and mint, only exact amounts up to `--max-per-call`.
3. Return the result to the model as a tool message. Refusals and HTTP errors are results, not crashes, so a refused hijack attempt costs nothing and the run continues.
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

`makeTools` exposes `balance`, `list_providers`, `call_paid_api`, `check_reserves`, `report` and `request_approval`. The approval tool throws `NotImplemented`. Tests can inject provider discovery and reserve readers.

`list_providers` has a 10-second fetch timeout. Payment and reserve operations do not have a general agent-level timeout or retry policy; callers needing deadlines must provide them through their clients. Calls are sequential, so `paidCents` can be measured from wallet balance deltas. `call_paid_api` parses JSON or preserves text, rejects non-2xx responses and optionally includes the x402 redemption ID.

Human output reports provider, topic, calls, balance and reserves. `--json` emits one result object on stdout, with logs on stderr. A success contains `ok`, `provider`, `topic`, `calls`, `balanceBefore`, `balanceAfter`, `paidCents` and `reserves`; each call includes status, paid cents, data and optional `redemptionId`. Failure contains `{ok: false, error: {kind, message, reason?, status?}}`.

| Exit | Meaning |
|---|---|
| 0 | All calls succeeded |
| 1 | Unexpected/internal error |
| 2 | Bad configuration, flags or unreadable token file |
| 3 | Wallet refusal, such as cap, provider or exact-balance failure |
| 4 | Recognized network failure |
| 5 | HTTP error or failed paid retry (the mock API maps settle failures to 402) |
| 6 | No suitable provider or provider URL |
| 7 | Reserve check failed; no subsequent paid call |

`runMain` returns the exit code and releases the wallet lock in `finally`.

## Safety limits

The agent holds tokens, not Solana keys or provider signing keys. It never needs `MINT_ADMIN_TOKEN`. The token lock restricts redemption to registered keys in its signer set; the wallet additionally enforces provider policy, asset/mint checks, exact amount and a per-call cap. These controls do not stop an agent wasting its entire budget at allowed providers, and leaked tokens can still buy services there.

The reserve gate is enforced by `runScripted` and `runLlm` around paid calls, not by each individual tool, and the LLM loop does not expose `check_reserves` to the model. The LLM loop adds a session budget and a step limit in code. A model fooled by a prompt injection can waste its budget at registered providers, but cannot pay anyone else and holds no key to leak.

## Fake mode and tests

`--fake` replaces wallet, providers and reserve reads with stubs. It requires no token file, mint, provider, PostgreSQL or RPC, and does not demonstrate a real payment.

| Variable | Effect in fake mode |
|---|---|
| `FAKE_START_CENTS` | Starting balance, default 100 |
| `FAKE_PRICE_CENTS` | Price, default 5 |
| `FAKE_FAIL_STATUS` | Forced `PaymentFailed` status |
| `FAKE_RESERVES_FAIL=1` | Fail the reserve check |

`scripted.test.ts` covers decisions, gate cadence, refusals and exit reporting. `e2e-local.test.ts` uses wallet/provider/mint fakes. `tests/integration/test/real-mint.test.ts` uses the actual mint and mock API with PostgreSQL and an injected fake chain. The separate real-vault acceptance script validates onchain reserve and settlement behavior; [historical deployment notes](01-vault.md#10-implementation-notes-and-decisions) record a November 16, 2026 pass.

`llm.test.ts` covers the gate before the first purchase, budget refusal, a refused hijack, the step limit and the chat client. Owner approval remains planned work. The `exact` baseline client and Copycat, the competitor bot, live in `scripts/` ([demo](../DEMO.md)). The LLM loop uses no SDK; any OpenAI-compatible endpoint works.
