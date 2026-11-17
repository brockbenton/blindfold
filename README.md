# Blindfold

**Every time your agent pays for data with standard x402, it publishes what it's researching onchain.** Blindfold lets it pay per call without a public record.

Data vendors such as CoinGecko, CoinMarketCap, Birdeye and Messari already sell market data per request over x402. With the standard `exact` scheme, each call is a USDC transfer from the agent's wallet to the provider. Anyone reading Solana sees which wallet bought which feed, how often and when. A burst of purchases about one token is a trading signal that copy-trading bots can act on before the agent does. Finance already pays to hide intent: dark pools exist so large orders don't move the price. [Why Blindfold](docs/why-blindfold.md) has the evidence, use cases and landscape.

Blindfold is a custom x402 v2 scheme, `cashu`. An owner deposits USDC into a Solana vault and gets blind-signed ecash tokens for the agent. The agent pays each call with a token in an HTTP header: no transaction, no wallet, no onchain identity. Providers redeem tokens at the mint and receive one batched USDC payout from the vault that covers many calls. A watcher sees a deposit go in and a batch payout come out, not who bought what.

**Privacy without giving up safety.** The agent holds tokens, not a Solana key. Tokens are locked to registered providers, so a hijacked agent cannot pay an attacker. A purchase above the owner's approval limit waits for the owner to approve it. Before paying, the agent reads the vault's USDC balance on Solana itself and refuses to pay a mint that claims more liabilities than the vault holds.

What it does not hide: deposits and payouts are public, and providers see the queries and IP addresses. With one user, the batch payout is linked to that user's deposit; it takes several owners depositing equal amounts before Copycat cannot attribute a payout (`pnpm crowd`). See [Limits and trust](#limits-and-trust).

## Run and test

See **[Run it locally](docs/RUNNING.md)** for prerequisites and commands, and **[Run the demo](docs/DEMO.md)** for the narrated devnet walkthrough (`pnpm demo`). The default development path uses Node 22+, pnpm 10.33.0 and PostgreSQL. Fake-chain mode exercises the mint, provider and wallet without Solana tools or funded keys.

```sh
pnpm install --frozen-lockfile
pnpm -r build
# Start PostgreSQL and export DATABASE_URL first; see docs/RUNNING.md.
pnpm -r typecheck
pnpm -r test
node agents/simple/dist/main.js --fake --json
```

Build before testing: workspace packages import each other's `dist/` outputs. Mint tests require PostgreSQL; integration tests skip when `DATABASE_URL` is unset. The `--fake` agent uses stubs and does not validate the mint or chain.

The real-vault path additionally needs Rust 1.89.0, Anchor 1.2.2 and Solana tools. [Vault deployment notes](docs/design/01-vault.md#10-implementation-notes-and-decisions) record a devnet deployment and acceptance run on November 16, 2026. Those records do not guarantee the deployment's current availability. The configured program ID is `EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo`.

## What works

`pnpm demo` runs "Copycat vs. your trading agent" on Solana devnet with real transactions. Your agent researches SOL with standard x402 `exact` and Copycat, a bot reading only public Solana data, turns its payments into "BUY SOL". The same research paid with Blindfold gives Copycat no signal. Then an AI agent reads a poisoned feed whose prompt injection points it at an attacker, and its tokens cannot pay the attacker; a 25-cent purchase waits for the owner to approve it on the dashboard. A local dashboard shows both sides live. See [Run the demo](docs/DEMO.md).

| Component | Current behavior |
|---|---|
| Vault (Anchor program, devnet) | Holds deposited USDC; admin registers and deactivates providers; the mint authority pays batches of up to eight providers |
| Mint | Confirms vault deposits, issues blind-signed tokens with DLEQ proofs, checks provider signatures, rejects spent tokens, tracks balances and settles batches |
| Provider (mock token data feed) | Sells whale flow, order-book depth and premium trade signals per call over x402 `cashu`; redeems before serving; optionally also accepts standard `exact` as a baseline |
| Wallet and owner CLI | Funds provider-locked tokens, pays exact amounts, applies per-call caps, asks the owner before paying above a threshold (terminal, dashboard or timeout denial) and reconciles pending payments |
| Agent | Scripted or LLM-driven (`--llm`, Gemini by default, any OpenAI-compatible model): chooses data, decides BUY/SELL/HOLD; code enforces the reserve gate, a budget, owner approval and a step limit, and refusals go back to the model ([decision loop and limits](docs/design/05-agent.md)) |
| Copycat and dashboard | Copycat reads only public Solana data, pushed to it by a [QuickNode Stream](#quicknode-streams) with RPC polling as the fallback; it infers trading signals from `exact` payments and tests whether vault payouts can be attributed to depositors; the dashboard puts `exact` and Blindfold side by side with live balances; `pnpm crowd` runs several agents at once |

Protocol-level owner co-signing, Temporal, onchain issuance logging and hidden provider revenue are planned. See [MVP and add-ons](docs/mvp.md).

## QuickNode Streams

Copycat plays a real front-running bot, and a real one does not poll. A QuickNode Stream pushes every transaction that pays a data feed or touches the Blindfold vault to Copycat as it lands on devnet, already reduced to the few fields Copycat needs. The demo's dashboard, its narration and Copycat's `BUY SOL` call all run on that data.

| Setting | Value |
|---|---|
| Network | `solana-devnet` (where the vault and the demo run) |
| Dataset | `block`: full blocks with parsed transactions, token balances and logs. Batches of 5 blocks, elastic batching on, starting at the chain tip |
| Filter | [`scripts/streams/copycat-filter.js`](scripts/streams/copycat-filter.js), JavaScript, with the watched addresses filled in at upload |
| Destination | Webhook: `POST /streams` on a receiver inside `pnpm demo` or `pnpm bot`, exposed through a free cloudflared quick tunnel. Every delivery is checked against QuickNode's HMAC signature (`X-QN-Signature`) with a fresh security token per run |
| Created by | [`pnpm streams:setup`](scripts/streams-setup.ts) through the Streams REST API. Each demo or bot run replaces the Stream with one that points at its own tunnel |

**Filter logic.** For each successful transaction in the batch:

1. Skip it unless it changes the USDC balance of a watched token account: a data feed's payout account (TokenFeed's and NewsWire's in the demo) or the vault's USDC account.
2. Work out the movement from pre and post token balances (any instruction layout works): who sent it, from which account, how much. This mirrors what Copycat's RPC path computes, and a test checks that both paths give identical results on real devnet blocks.
3. Attach the SPL Memo, which is where an x402 `exact` payment says what was bought, such as `whale-flow/SOL`.
4. For vault transactions, decode the Anchor `DepositMade` event from the logs (index, depositor, amount, deposit reference).

Each batch returns `{ tip, records, deposits }`, even when nothing matched. One record looks like this:

```json
{ "signature": "KCWm...tRH4A", "slot": 522985052, "time": 1794850619, "account": "GVaF...VECe",
  "sender": "4pHm...usqE", "senderAccount": "8dHd...Vkk3", "recipient": "ELPm...5bzd", "amount": "50000", "memo": "whale-flow/SOL" }
```

**Why this setup.**

- **Speed.** In devnet tests, the record reached Copycat by the time the sender's own confirmation returned. Polling the public RPC takes two calls per account per pass, plus one per new transaction, and runs into its rate limit.
- **Filter on QuickNode's side.** The devnet block we sampled was about 250 KB. The filter sends Copycat a few hundred bytes per relevant transaction, already in Copycat's `Observation` shape, so the dashboard and the inference code did not change.
- **Proof of an empty block.** The `tip` in every batch says how far the Stream has read. When the demo claims that Blindfold payments left nothing onchain, Copycat first waits until the Stream has delivered past the current slot.
- **Automatic fallback.** The demo never depends on QuickNode. With no API key, no tunnel, a refused request, or 20 seconds without a delivery, Copycat polls RPC and switches back when deliveries resume. Both sources feed the same deduplicated list, so a transaction is reported once whichever source sees it first.
- **Free plan.** Streams is included in QuickNode's free trial. The trial allows 1 active Solana Stream that follows the tip, with no backfill, so `pnpm bot` reads its starting history over RPC. Only one process can own the Stream at a time: a second `pnpm bot` or demo takes it over, and the first falls back to polling.

**The mint does not credit deposits from the Stream.** It keeps reading the vault's own `DepositRecord` accounts over RPC: crediting money from a third-party feed would weaken its trust model, and its 2-second poll is already fast. The decoded `DepositMade` events are printed by `pnpm bot`; using them only as a trigger for an immediate poll is a possible next step.

Setup steps are in [Run the demo](docs/DEMO.md#quicknode-streams-optional).

## Payment flow

1. **Fund.** The owner gets a mint quote, deposits USDC into the vault with the quote's random reference, and receives blind-signed tokens locked to the registered providers. The agent gets a token file, not a key. Onchain: one deposit.
2. **Check.** Before paying, the agent compares the vault's USDC balance on Solana with the mint's reported liabilities, and refuses if they don't add up.
3. **Pay.** The provider answers HTTP 402. The wallet checks price, mint and provider, then retries with an exact token payment in the `PAYMENT-SIGNATURE` header. Onchain: nothing.
4. **Redeem.** The provider redeems the tokens at the mint, which marks them spent and credits the provider in one database transaction. Only then is the data served. A replayed payment is refused.
5. **Settle.** The mint signs one `settle_batch` transaction that pays each provider's registered USDC account for many calls. Onchain: one payout from the vault, no payer.

## Limits and trust

- **Budget and recipients:** tokens limit total spend and require an allowed provider's signature. The default token lock includes all active providers at funding time. `WALLET_ALLOWLIST` can narrow spending in wallet code; it does not change existing locks.
- **Approval:** prices above `APPROVAL_OVER_CENTS` (default 20) need the owner's approval; no answer in time is a denial. The check runs in the agent's wallet code, where the 402 price is known. It stops a manipulated model, not a compromised agent process.
- **Price and data:** an allowed provider can charge up to the wallet's per-call cap. An agent can waste its whole budget on allowed providers. Payment does not establish that returned data is accurate.
- **Custody:** the mint can censor, under-report issuance or misuse its settlement authority. The vault restricts payout addresses, but it does not prove those payouts correspond to honest redemptions. Deployment and upgrade authorities remain trusted.
- **Reserves:** the agent reads the vault balance itself and compares it with mint-reported outstanding liabilities. It fails closed on errors, but cannot detect a mint that lies about issuance. Fake-chain mode does not provide an onchain reserve check.
- **Privacy:** deposits and provider payouts are public. Privacy needs a crowd: with one depositor a payout is linked to it, and distinctive amounts, a common funding wallet or repeated timing can link several. Providers see queries, and the mint sees redemption amounts and times. No shared relay, Tor or Oblivious HTTP layer is implemented.
- **Recovery:** a lost paid response can consume tokens without delivering data. Funding state supports recovery at persisted checkpoints, not exactly-once deposits across every crash. See [wallet recovery limits](docs/design/04-wallet-sdk.md#recovery-limits).
- **Prototype:** no mainnet support, refunds, swap/change, key rotation, sanctions screening or independent security audit. Mint signing helpers are non-constant-time; this is not a production custody service.

## Documentation

| Document | Contents |
|---|---|
| [Run it locally](docs/RUNNING.md) | Installation, PostgreSQL, services, CLI and tests |
| [Run the demo](docs/DEMO.md) | One-command devnet demo, `exact` comparison, Copycat, dashboard |
| [Why Blindfold](docs/why-blindfold.md) | The problem, evidence, use cases, landscape and pitch lines |
| [MVP and add-ons](docs/mvp.md) | Implemented scope and planned work |
| [Design](docs/design.md) | Flow, trust, privacy and future options |
| [Interfaces](docs/design/00-interfaces.md) | Wire formats, accounts, HTTP APIs and configuration |
| Components | [Vault](docs/design/01-vault.md), [mint](docs/design/02-mint.md), [provider](docs/design/03-mock-api.md), [wallet](docs/design/04-wallet-sdk.md), [agent](docs/design/05-agent.md) |
| [Plan](docs/plan.md) | Delivery schedule and remaining work |
| [Security sources](docs/security-sources.md) | External references and their relevance |
