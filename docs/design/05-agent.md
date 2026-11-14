# 05: Simple agent (`agents/simple`)

Builds against [00-interfaces.md](00-interfaces.md). That file wins on any conflict.

## 1. Purpose

A small agent that makes at least one paid API call through the wallet SDK and reports the result. MVP version is a deterministic script. It sits behind a tool interface so an LLM loop can replace the script later without touching the tools.

## 2. Depends on / used by

| Depends on | For |
|---|---|
| `packages/wallet` (04) | `AgentWallet.open`, `balance()`, `payFetch`, `PaymentRefused`, `PaymentFailed` (00 §8.1) |
| `packages/protocol` (00) | `ProviderInfo` type, `env` loader (§9), constants |
| `packages/protocol` (00) | also `checkReserves` (00 §7.6, §8) |
| Mint (02) | `GET /v1/blindfold/providers` (§5.5, includes advisory `price_cents` and `topics`), `GET /v1/blindfold/reserves` (§5.5a, via `checkReserves`) |
| Solana RPC | Vault token account and `Config` reads, `@solana/web3.js` `Connection` from `SOLANA_RPC_URL` |
| Mock API (03) | The paid endpoint `GET /v1/data/:topic` (00 §7.5) |
| Owner CLI (04) | Writes the token file the agent reads (§3.4) |

Used by: `scripts/e2e.ts` (runs the CLI with `--json`, §10 step 2), the demo, and later add-ons (competitor-bot task, prompt-injection run, owner approval).

**Wallet API (00 §8.1, built in 04).** `packages/wallet` exports:

```ts
const wallet = await AgentWallet.open({ tokenFile, maxPerCallCents, allowlist? });
wallet.balance(): number;                       // synchronous, spendable cents
wallet.payFetch(url, init?): Promise<Response>; // fetch-compatible
class PaymentRefused extends Error { reason: RefusalReason }
class PaymentFailed extends Error { status: number }
```

`payFetch` does the x402 handshake (§7, scheme `cashu`) and returns non-402 responses unchanged (it does not throw for them). It throws `PaymentRefused` before any proof leaves the wallet, with `reason` one of `bad_request`, `unit`, `mint`, `over_cap`, `provider_not_allowed`, `provider_not_in_signer_set`, `insufficient_exact`, `insufficient_balance` (04 also has). It throws `PaymentFailed` when the paid retry returns non-2xx (after the wallet's checkstate recovery); x402 collapses every settle failure into `402`, so `status` is `402` and the reason is not available. On success the `PAYMENT-RESPONSE` header carries the provider's redemption id (`decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')).transaction`); the agent may log it with the call. Network failures propagate as `TypeError` (fetch) or an error with `cause`.

**Paid endpoint (00 §7.5).** `GET {provider.url}/v1/data/:topic` (topic is a path parameter) returns `200 {topic, price, change_24h_pct, volume_24h, whale_netflow, as_of}`.

## 3. MVP scope

- One scripted run: discover, pick, call once, print, exit.
- Provider choice: the one matching `--provider`, else the first active provider whose `topics` include `--topic`, else the first active provider.
- Topic from `--topic` (default `sol`).
- Fake wallet and fake provider list so the agent runs before other components exist (§7).
- Optional `--calls N` (default 1) to repeat the paid call. Not needed for acceptance.

## 4. Out of scope

- LLM tool-use loop
- Competitor-bot research task
- Prompt-injection run
- Owner approval (`request_approval` is declared but throws "not implemented")

## 5. Design

### 5.1 Tool interface

`src/tools.ts`. Both the scripted loop and a future LLM loop call only these.

```ts
export interface Tools {
  balance(): Promise<{ cents: number }>;
  list_providers(): Promise<ProviderInfo[]>;                 // active only
  call_paid_api(a: { url: string; method?: 'GET' | 'POST'; body?: unknown }):
    Promise<{ status: number; data: unknown; paidCents: number }>;
  check_reserves(): Promise<{ ok: boolean; vaultCents: number; outstandingCents: number; reason?: string }>;
  report(a: { summary: string; data?: unknown }): Promise<void>;
  request_approval(a: { amountCents: number; reason: string }): Promise<never>; // reserved
}
export function makeTools(deps: { wallet: AgentWallet; mintUrl: string; connection: Connection; programId: PublicKey; usdcMint: PublicKey; out: Reporter }): Tools;
```

| Tool | Behavior |
|---|---|
| `balance` | `wallet.balance()` (sync in the wallet, wrapped in a promise here) |
| `list_providers` | `GET {mintUrl}/v1/blindfold/providers`, filter `active`. Throws `NetworkError` on fetch failure, `HttpError` on non-2xx |
| `call_paid_api` | `balB = wallet.balance()`, `wallet.payFetch(url, init)`, `balA = wallet.balance()`. `paidCents = balB - balA`. Parses JSON (falls back to text). Throws `HttpError` if status is not 2xx. Catches `PaymentFailed` and rethrows it as `HttpError {status: e.status, body}`. Lets `PaymentRefused` and network errors propagate |
| `check_reserves` | `checkReserves({ connection, programId, usdcMint, mintUrl })` from `@blindfold/protocol` (00 §7.6). `connection` is a `@solana/web3.js` `Connection` built from `SOLANA_RPC_URL`. Never throws for a failed check: RPC errors, mint errors, a wrong `Config` owner or a `usdc_mint` mismatch return `ok: false` with `reason` (fail closed) |
| `report` | Hands the summary to the `Reporter` (human or JSON output, §5.4) |
| `request_approval` | Always throws `NotImplemented` in MVP |

Error classes in `src/errors.ts`: `NetworkError`, `HttpError {status, body}`, `NoProviderError`. `PaymentRefused` and `PaymentFailed` are imported from the wallet.

### 5.2 Scripted run

`src/scripted.ts`, `runScripted(tools, opts)`:

1. `start = tools.balance()`. If `0`, fail with exit code 3 and reason `insufficient_balance` before any call.
2. `providers = tools.list_providers()`. Empty, or `--provider` name not found: `NoProviderError`.
3. Pick provider: match `--provider` by `name`, else the first provider whose `topics` include `topic`, else `providers[0]`. Its `price_cents` (advisory, may be null) is shown in the output only; the wallet decides what to pay.
4. `url = new URL('/v1/data/' + encodeURIComponent(topic), provider.url)`.
5. Reserve gate: before the first paid call, and again before every `RESERVE_CHECK_EVERY`-th paid call after it, `r = tools.check_reserves()`. If `!r.ok`, refuse to pay, print `r.reason`, and exit 7 (`reserves_failed`). No paid call happens after a failed check. RPC and mint errors count as failure (fail closed).
6. `res = tools.call_paid_api({ url })`. Repeat `--calls` times (re-running the gate in step 5 as above), collecting results.
7. `end = tools.balance()`.
8. `tools.report({ summary, data })` with provider, topic, paid cents, start and end balance, vault vs outstanding from the last check, data.
9. Return a `RunResult` (§5.4). `main` exits 0.

### 5.3 CLI flags and env

`src/main.ts`, run as `pnpm --filter agent-simple start -- [flags]`.

| Flag | Env (§9) | Default | Meaning |
|---|---|---|---|
| `--token-file <path>` | `TOKEN_FILE` | required | Agent token file (§3.4) |
| `--mint-url <url>` | `MINT_URL` | `http://localhost:3338` | Mint and provider list |
| `--max-per-call <cents>` | `MAX_PER_CALL_CENTS` | `10` | Passed to the wallet |
| `--topic <str>` | none | `sol` | Topic (path segment of `/v1/data/:topic`) |
| `--provider <name>` | none | first active with matching topic | Provider `name` from §5.5 |
| `--calls <n>` | none | `1` | Number of paid calls |
| `--json` | none | off | One JSON object on stdout, logs on stderr |
| `--fake` | `AGENT_FAKE=1` | off | Use stubs (§7) |
| none | `RESERVE_CHECK_EVERY` | `10` | Paid calls between reserve checks (a check always runs before the first) |
| none | `SOLANA_RPC_URL` | required unless `--fake` | RPC for the vault read |
| none | `VAULT_PROGRAM_ID` | required unless `--fake` | Vault program (00 §4) |
| none | `USDC_MINT` | required unless `--fake` | Must match the vault `Config.usdc_mint` |

Flags win over env. Missing `TOKEN_FILE`, `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID` or `USDC_MINT` without `--fake`: exit 2. The agent never sets `allowlist`; the token lock is the real guard.

### 5.4 Output

Human (stdout):

```
provider   mock-api (http://localhost:4000)
topic      sol
call 1     200  paid 5c
data       {"topic":"sol","price":172.4,"change_24h_pct":-1.2,...}
balance    100c -> 95c
reserves   vault 250c >= outstanding 180c (ok)
```

`--json` (stdout, single line; nothing else on stdout):

```json
{ "ok": true, "provider": {"provider_id":0,"name":"mock-api","url":"http://localhost:4000","price_cents":5,"topics":["sol","btc","eth"]},
  "topic": "sol", "calls": [{"status":200,"paidCents":5,"data":{}}],
  "balanceBefore": 100, "balanceAfter": 95, "paidCents": 5,
  "reserves": { "ok": true, "vaultCents": 250, "outstandingCents": 180 } }
```

On failure with `--json`: `{ "ok": false, "error": { "kind": "payment_refused"|"reserves_failed"|"network"|"http"|"no_provider"|"config"|"internal", "message": "...", "reason"?: "...", "status"?: 400 } }`, same exit codes. Human mode prints `error: <kind>: <message>` to stderr.

### 5.5 Errors and exit codes

| Exit | Kind | Cause |
|---|---|---|
| 0 | none | All calls returned 2xx |
| 1 | `internal` | Unexpected exception |
| 2 | `config` | Missing or bad flag/env, unreadable token file |
| 3 | `payment_refused` | `PaymentRefused` from the wallet; print `reason` (e.g. `over_cap`, `insufficient_balance`, `provider_not_allowed`) |
| 4 | `network` | Mint or provider unreachable (fetch failed, timeout) |
| 5 | `http` | `PaymentFailed` (the paid retry returned non-2xx, always `402` under x402, for example a replayed token; `status` is reported), or an unpaid non-2xx such as `404` |
| 6 | `no_provider` | No active provider, or `--provider` not found |
| 7 | `reserves_failed` | `check_reserves` returned `!ok` (vault below outstanding, or RPC or mint unreachable, or `Config` mismatch); print `reason`; nothing was paid |

No retries in the agent. The wallet already reconciles unspent proofs after a failed retry (§7.4). Fetch timeout 10 s on `list_providers`; `payFetch` timeout is the wallet's.

### 5.6 Decision loop and safety limits

The hackathon requires these to be documented. The scripted run and any LLM loop follow the same loop:

1. Check reserves (`check_reserves`, 00 §7.6). Stop if not ok.
2. Discover providers (`list_providers`).
3. Choose a provider by topic.
4. Pay through the wallet (`call_paid_api`), which applies its own guardrails.
5. Report the result (`report`).

| Safety limit | Enforced in |
|---|---|
| Token lock: 1-of-N P2PK to registered providers only; a leaked token is useless to anyone else | tokens / mint (00 §3.3) |
| Per-call cap | x402 `spendControls` and wallet (`MAX_PER_CALL_CENTS`, `over_cap`) |
| Exact-amount payment, no change given to the provider | wallet (`insufficient_exact`) |
| Budget = tokens held; the agent cannot spend more than the owner minted | tokens |
| Provider allowlist policy (`WALLET_ALLOWLIST`) | wallet (`provider_not_allowed`) |
| Reserve check, fail closed (exit 7) | agent code (`runScripted`) |
| Agent holds no keys and no USDC | design (only tokens in the token file; §8) |

### 5.7 LLM swap-in (not designed here)

A later `src/llm.ts` runs a Claude tool-use loop with the Anthropic SDK (model `claude-sonnet-5-5`). It exposes the six `Tools` as tool definitions, `check_reserves` among them. The LLM loop must call `check_reserves` first, and that is enforced in code (the loop wrapper runs the same §5.2 gate before dispatching any `call_paid_api`, and blocks it on a failed check), not left to the model.  dispatches each `tool_use` block to the same `makeTools` instance, feeds results back, and ends on `report`. Tool errors (`PaymentRefused`, `HttpError`) go back to the model as `is_error` results. `main.ts` picks the loop with `--mode scripted|llm`. No change to `tools.ts`.

## 6. File layout

```
agents/simple/
  package.json        name agent-simple, bin "agent", deps: @blindfold/wallet, @blindfold/protocol
  tsconfig.json
  src/
    main.ts           arg/env parsing, wiring, exit codes
    tools.ts          Tools interface + makeTools
    scripted.ts       runScripted
    reporter.ts       human and JSON Reporter
    errors.ts         NetworkError, HttpError, NoProviderError
    stubs.ts          fakeWallet, fakeProviders (§7)
  test/
    scripted.test.ts  runScripted against stubs; exit-code mapping
```

## 7. Stubs

`--fake` (or `AGENT_FAKE=1`) swaps in `src/stubs.ts`. No token file, mint or provider needed.

| Stub | Behavior |
|---|---|
| `fakeWallet(startCents = 100, priceCents = 5)` | Same shape as the real `AgentWallet` (00 §8.1): `balance()` is synchronous and returns the running total in cents; `payFetch(url)` deducts `priceCents` and returns `200` JSON `{"topic":"<last path segment>","price":172.4,"change_24h_pct":-1.2,"volume_24h":123456789,"whale_netflow":42000,"as_of":1763166400,"fake":true}`. Throws `PaymentRefused` with `reason: 'insufficient_balance'` when the balance is below price, and `'over_cap'` when price exceeds `maxPerCallCents`. Env `FAKE_FAIL_STATUS=402` makes it throw `PaymentFailed` with that `status` (balance unchanged) |
| `fakeReserves` | `check_reserves` stub: default `{ ok: true, vaultCents: 250, outstandingCents: 180 }`. Env `FAKE_RESERVES_FAIL=1` returns `{ ok: false, vaultCents: 100, outstandingCents: 180, reason: 'vault_below_outstanding' }` |
| `fakeProviders` | `[{ provider_id: 0, pubkey: "02" + "11".repeat(32), name: "mock-api", url: "http://localhost:4000", price_cents: 5, topics: ["sol", "btc", "eth"], active: true }]`, served by a patched `list_providers` |

Env `FAKE_PRICE_CENTS` and `FAKE_START_CENTS` tune the fake wallet so tests can hit each exit code. Until `packages/wallet` exists, `stubs.ts` also defines local `PaymentRefused` and `PaymentFailed` with the 00 §8.1 fields; switch to the real imports once published.

## 8. Done when

- [ ] `agent --fake --json` exits 0 and prints the JSON in §5.4 with `balanceBefore - balanceAfter == paidCents`.
- [ ] `scripted.test.ts` covers exits 0, 3 (empty wallet, `over_cap`), 4 (list fetch fails), 5 (`PaymentFailed` 402), 6 (no provider), 7 (reserves not ok: no paid call made, reason printed; same for RPC error), and the pass case (reserves ok, check runs before the first call and every `RESERVE_CHECK_EVERY` calls).
- [ ] Fail-closed (00 §10 step 6): with a stub reserves endpoint reporting `outstanding` above the vault balance, the agent refuses to pay and exits 7.
- [ ] Against the real mint, wallet and mock API: one call returns 200, token file balance drops by `PRICE_CENTS`, exit 0.
- [ ] stdout in `--json` mode is exactly one JSON line (e2e script parses it).
- [ ] Agent code never reads the Solana keypair, `MINT_ADMIN_TOKEN` or any provider secret.

## 9. Open questions

| # | Question | Proposed fix |
|---|---|---|
| 1 | `paidCents` is computed from balance deltas, which is wrong if two calls run concurrently | Agent is sequential in MVP. Wallet could return `paidCents` on the response (for example a header-less side channel) later |
| 2 | The agent cannot tell a lost `200` from a rejected payment | Covered by wallet checkstate (§7.4). No agent action |

## 10. Implementation notes (client stream)

- `runMain(argv, env, io, { tools?, connection? })` returns the exit code; the wallet lock is released in `finally`.
- Without `--fake`, `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID` and `USDC_MINT` must be set (exit 2), as in 5.3, even though the protocol loader has defaults.
- `RunResult.calls[]` also carries the optional `redemptionId`.
- In-process e2e: `agents/simple/test/e2e-local.test.ts`.
