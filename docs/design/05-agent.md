# 05: Simple agent (`agents/simple`)

Builds against [00-interfaces.md](00-interfaces.md). That file wins on any conflict.

## 1. Purpose

A small agent that makes at least one paid API call through the wallet SDK and reports the result. MVP version is a deterministic script. It sits behind a tool interface so an LLM loop can replace the script later without touching the tools.

## 2. Depends on / used by

| Depends on | For |
|---|---|
| `packages/wallet` (04) | `AgentWallet.open`, `balance()`, `payFetch`, `PaymentRefused`, `PaymentFailed` (00 §8.1) |
| `packages/protocol` (00) | `ProviderInfo` type, `env` loader (§9), constants |
| Mint (02) | `GET /v1/blindfold/providers` (§5.5, includes advisory `price_cents`) |
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

`payFetch` does the 402 handshake (§7) and returns non-402 responses unchanged (it does not throw for them). It throws `PaymentRefused` before any proof leaves the wallet, with `reason` one of `bad_request`, `unit`, `mint`, `over_cap`, `provider_not_allowed`, `provider_not_in_signer_set`, `insufficient_exact`, `insufficient_balance` (04 also has `amount_mismatch`). It throws `PaymentFailed` when the paid retry returns non-2xx (after the wallet's checkstate recovery). Network failures propagate as `TypeError` (fetch) or an error with `cause`.

**Paid endpoint (00 §7.5).** `GET {provider.url}/v1/data/:topic` (topic is a path parameter) returns `200 {topic, price, change_24h_pct, volume_24h, whale_netflow, as_of}`.

## 3. MVP scope

- One scripted run: discover, pick, call once, print, exit.
- Provider choice: first `active` provider, or the one matching `--provider`.
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
  report(a: { summary: string; data?: unknown }): Promise<void>;
  request_approval(a: { amountCents: number; reason: string }): Promise<never>; // reserved
}
export function makeTools(deps: { wallet: AgentWallet; mintUrl: string; out: Reporter }): Tools;
```

| Tool | Behavior |
|---|---|
| `balance` | `wallet.balance()` (sync in the wallet, wrapped in a promise here) |
| `list_providers` | `GET {mintUrl}/v1/blindfold/providers`, filter `active`. Throws `NetworkError` on fetch failure, `HttpError` on non-2xx |
| `call_paid_api` | `balB = wallet.balance()`, `wallet.payFetch(url, init)`, `balA = wallet.balance()`. `paidCents = balB - balA`. Parses JSON (falls back to text). Throws `HttpError` if status is not 2xx. Catches `PaymentFailed` and rethrows it as `HttpError {status: e.status, body}`. Lets `PaymentRefused` and network errors propagate |
| `report` | Hands the summary to the `Reporter` (human or JSON output, §5.4) |
| `request_approval` | Always throws `NotImplemented` in MVP |

Error classes in `src/errors.ts`: `NetworkError`, `HttpError {status, body}`, `NoProviderError`. `PaymentRefused` and `PaymentFailed` are imported from the wallet.

### 5.2 Scripted run

`src/scripted.ts`, `runScripted(tools, opts)`:

1. `start = tools.balance()`. If `0`, fail with exit code 3 and reason `insufficient_balance` before any call.
2. `providers = tools.list_providers()`. Empty, or `--provider` name not found: `NoProviderError`.
3. Pick provider: match `--provider` by `name`, else `providers[0]`. Its `price_cents` (advisory, may be null) is shown in the output only; the wallet decides what to pay.
4. `url = new URL('/v1/data/' + encodeURIComponent(topic), provider.url)`.
5. `res = tools.call_paid_api({ url })`. Repeat `--calls` times, collecting results.
6. `end = tools.balance()`.
7. `tools.report({ summary, data })` with provider, topic, paid cents, start and end balance, data.
8. Return a `RunResult` (§5.4). `main` exits 0.

### 5.3 CLI flags and env

`src/main.ts`, run as `pnpm --filter agent-simple start -- [flags]`.

| Flag | Env (§9) | Default | Meaning |
|---|---|---|---|
| `--token-file <path>` | `TOKEN_FILE` | required | Agent token file (§3.4) |
| `--mint-url <url>` | `MINT_URL` | `http://localhost:3338` | Mint and provider list |
| `--max-per-call <cents>` | `MAX_PER_CALL_CENTS` | `10` | Passed to the wallet |
| `--topic <str>` | none | `sol` | Topic (path segment of `/v1/data/:topic`) |
| `--provider <name>` | none | first active | Provider `name` from §5.5 |
| `--calls <n>` | none | `1` | Number of paid calls |
| `--json` | none | off | One JSON object on stdout, logs on stderr |
| `--fake` | `AGENT_FAKE=1` | off | Use stubs (§7) |

Flags win over env. Missing `TOKEN_FILE` without `--fake`: exit 2. The agent never sets `allowlist`; the token lock is the real guard.

### 5.4 Output

Human (stdout):

```
provider   mock-api (http://localhost:4000)
topic      sol
call 1     200  paid 5c
data       {"topic":"sol","price":172.4,"change_24h_pct":-1.2,...}
balance    100c -> 95c
```

`--json` (stdout, single line; nothing else on stdout):

```json
{ "ok": true, "provider": {"provider_id":0,"name":"mock-api","url":"http://localhost:4000","price_cents":5},
  "topic": "sol", "calls": [{"status":200,"paidCents":5,"data":{}}],
  "balanceBefore": 100, "balanceAfter": 95, "paidCents": 5 }
```

On failure with `--json`: `{ "ok": false, "error": { "kind": "payment_refused"|"network"|"http"|"no_provider"|"config"|"internal", "message": "...", "reason"?: "...", "status"?: 400 } }`, same exit codes. Human mode prints `error: <kind>: <message>` to stderr.

### 5.5 Errors and exit codes

| Exit | Kind | Cause |
|---|---|---|
| 0 | none | All calls returned 2xx |
| 1 | `internal` | Unexpected exception |
| 2 | `config` | Missing or bad flag/env, unreadable token file |
| 3 | `payment_refused` | `PaymentRefused` from the wallet; print `reason` (e.g. `over_cap`, `insufficient_balance`, `provider_not_allowed`) |
| 4 | `network` | Mint or provider unreachable (fetch failed, timeout). A `PaymentFailed` with `status` 502 (`mint_unavailable`) also maps here |
| 5 | `http` | `PaymentFailed` (the paid retry returned non-2xx other than 502, for example `400 redeem_failed`; `status` is reported), or an unpaid non-2xx such as `404` |
| 6 | `no_provider` | No active provider, or `--provider` not found |

No retries in the agent. The wallet already reconciles unspent proofs after a failed retry (§7.4). Fetch timeout 10 s on `list_providers`; `payFetch` timeout is the wallet's.

### 5.6 LLM swap-in (not designed here)

A later `src/llm.ts` runs a Claude tool-use loop with the Anthropic SDK (model `claude-sonnet-5-5`). It exposes the five `Tools` as tool definitions, dispatches each `tool_use` block to the same `makeTools` instance, feeds results back, and ends on `report`. Tool errors (`PaymentRefused`, `HttpError`) go back to the model as `is_error` results. `main.ts` picks the loop with `--mode scripted|llm`. No change to `tools.ts`.

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
| `fakeWallet(startCents = 100, priceCents = 5)` | Same shape as the real `AgentWallet` (00 §8.1): `balance()` is synchronous and returns the running total in cents; `payFetch(url)` deducts `priceCents` and returns `200` JSON `{"topic":"<last path segment>","price":172.4,"change_24h_pct":-1.2,"volume_24h":123456789,"whale_netflow":42000,"as_of":1763166400,"fake":true}`. Throws `PaymentRefused` with `reason: 'insufficient_balance'` when the balance is below price, and `'over_cap'` when price exceeds `maxPerCallCents`. Env `FAKE_FAIL_STATUS=400` makes it throw `PaymentFailed` with that `status` (balance unchanged) |
| `fakeProviders` | `[{ provider_id: 0, pubkey: "02" + "11".repeat(32), name: "mock-api", url: "http://localhost:4000", price_cents: 5, active: true }]`, served by a patched `list_providers` |

Env `FAKE_PRICE_CENTS` and `FAKE_START_CENTS` tune the fake wallet so tests can hit each exit code. Until `packages/wallet` exists, `stubs.ts` also defines local `PaymentRefused` and `PaymentFailed` with the 00 §8.1 fields; switch to the real imports once published.

## 8. Done when

- [ ] `agent --fake --json` exits 0 and prints the JSON in §5.4 with `balanceBefore - balanceAfter == paidCents`.
- [ ] `scripted.test.ts` covers exits 0, 3 (empty wallet, `over_cap`), 4 (list fetch fails, `PaymentFailed` 502), 5 (`PaymentFailed` 400), 6 (no provider).
- [ ] Against the real mint, wallet and mock API: one call returns 200, token file balance drops by `PRICE_CENTS`, exit 0.
- [ ] stdout in `--json` mode is exactly one JSON line (e2e script parses it).
- [ ] Agent code never reads the Solana keypair, `MINT_ADMIN_TOKEN` or any provider secret.

## 9. Open questions

| # | Question | Proposed fix |
|---|---|---|
| 1 | `list_providers` does not say what each provider sells, so the agent cannot choose by topic | Fine for one mock provider. Later, add optional `topics: string[]` to `config/providers.json` and §5.5 |
| 2 | `paidCents` is computed from balance deltas, which is wrong if two calls run concurrently | Agent is sequential in MVP. Wallet could return `paidCents` on the response (for example a header-less side channel) later |
| 3 | The agent cannot tell a lost `200` from a rejected payment | Covered by wallet checkstate (§7.4). No agent action |
