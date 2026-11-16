# 05: Scripted agent

`agents/simple/` discovers a provider, checks reserves, pays through the wallet and reports the result. It is a deterministic script, not an LLM loop. [Interfaces](00-interfaces.md) · [Runbook](../RUNNING.md#5-agent).

## Decision loop

`runScripted`:

1. Read the wallet balance; refuse an empty budget.
2. Fetch active providers. Pick `--provider` by name, otherwise the first provider whose topics include `--topic`, otherwise the first active provider. Refuse a missing provider or URL.
3. Build `/v1/data/<encoded topic>` from that provider's base URL. The advertised price is advisory; the wallet checks the actual x402 requirement.
4. Before the first call, and again every `RESERVE_CHECK_EVERY` calls, check reserves. With the default 10, checks run before calls 1, 11, 21, … . A failure stops the run before payment.
5. Pay sequentially for `--calls` requests through `wallet.payFetch`, collect results and report balance changes.

The reserve check validates the vault-owned `Config`, configured mint and expected vault account, reads the token balance over Solana RPC, rounds it down to whole cents, then compares it with the mint's reported outstanding liabilities. Missing accounts, mismatches, underfunding, invalid responses and RPC/mint errors return a failed check. Mint-reported issuance is still trusted; a dishonest mint can understate liabilities. The RPC and mint reads are not an atomic snapshot.

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

Flags override their corresponding environment values. The agent requires explicit chain settings even though the shared loader has defaults. It does not accept `--mode llm` or a flag that bypasses reserves for a fake-chain mint.

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

The reserve gate is enforced by `runScripted`, not by each individual tool. A future LLM loop must enforce it around paid-tool dispatch in code. Exposing `check_reserves` to a model alone would not enforce the gate.

## Fake mode and tests

`--fake` replaces wallet, providers and reserve reads with stubs. It requires no token file, mint, provider, PostgreSQL or RPC, and does not demonstrate a real payment.

| Variable | Effect in fake mode |
|---|---|
| `FAKE_START_CENTS` | Starting balance, default 100 |
| `FAKE_PRICE_CENTS` | Price, default 5 |
| `FAKE_FAIL_STATUS` | Forced `PaymentFailed` status |
| `FAKE_RESERVES_FAIL=1` | Fail the reserve check |

`scripted.test.ts` covers decisions, gate cadence, refusals and exit reporting. `e2e-local.test.ts` uses wallet/provider/mint fakes. `tests/integration/test/real-mint.test.ts` uses the actual mint and mock API with PostgreSQL and an injected fake chain. The separate real-vault acceptance script validates onchain reserve and settlement behavior; [historical deployment notes](01-vault.md#10-implementation-notes-and-decisions) record a November 16, 2026 pass.

LLM tool use, a complete injection demo and owner approval remain planned work. The `exact` baseline client and Copycat, the competitor bot, live in `scripts/` ([demo](../DEMO.md)). No model vendor, model version or LLM SDK is selected by the current implementation.
