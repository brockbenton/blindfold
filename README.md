# Blindfold

**Every time your agent pays for data with standard x402, it publishes what it's researching onchain.** Blindfold lets it pay per call without a public record.

Data vendors such as CoinGecko, CoinMarketCap, Birdeye and Messari already sell market data per request over x402. With the standard `exact` scheme, each call is a USDC transfer from the agent's wallet to the provider. Anyone reading Solana sees which wallet bought which feed, how often and when. A burst of purchases about one token is a trading signal that copy-trading bots can act on before the agent does. Finance already pays to hide intent: dark pools exist so large orders don't move the price. [Why Blindfold](docs/why-blindfold.md) has the evidence, use cases and landscape.

Blindfold is a custom x402 v2 scheme, `cashu`. An owner deposits USDC into a Solana vault and gets blind-signed ecash tokens for the agent. The agent pays each call with a token in an HTTP header: no transaction, no wallet, no onchain identity. Providers redeem tokens at the mint and receive one batched USDC payout from the vault that covers many calls. A watcher sees a deposit go in and a batch payout come out, not who bought what.

**Privacy without giving up safety.** The agent holds tokens, not a Solana key. Tokens are locked to registered providers, so a hijacked agent cannot pay an attacker. Before paying, the agent reads the vault's USDC balance on Solana itself and refuses to pay a mint that claims more liabilities than the vault holds.

What it does not hide: deposits and payouts are public, providers see the queries and IP addresses, and with few users or distinctive amounts and timing, deposits and payouts can still be correlated. See [Limits and trust](#limits-and-trust).

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

`pnpm demo` runs the whole story on Solana devnet with real transactions, then repeats the same purchases with standard x402 `exact` while a competitor bot reads the chain. See [Run the demo](docs/DEMO.md).

| Component | Current behavior |
|---|---|
| Vault (Anchor program, devnet) | Holds deposited USDC; admin registers and deactivates providers; the mint authority pays batches of up to eight providers |
| Mint | Confirms vault deposits, issues blind-signed tokens with DLEQ proofs, checks provider signatures, rejects spent tokens, tracks balances and settles batches |
| Provider (mock market data API) | Sells market data and order-book depth per call over x402 `cashu`; redeems before serving; optionally also accepts standard `exact` as a baseline |
| Wallet and owner CLI | Funds provider-locked tokens, pays exact amounts, applies per-call caps and reconciles pending payments |
| Agent | Checks vault reserves before paying and periodically after, buys data, reports results and refusals |
| Competitor bot | Reads only public Solana data and reports what it learns from `exact` payments and from Blindfold |

A Claude-driven trading agent with a prompt-injection act, QuickNode Streams, owner co-signing, Temporal, onchain issuance logging and hidden provider revenue are planned. See [MVP and add-ons](docs/mvp.md).

## Payment flow

1. **Fund.** The owner gets a mint quote, deposits USDC into the vault with the quote's random reference, and receives blind-signed tokens locked to the registered providers. The agent gets a token file, not a key. Onchain: one deposit.
2. **Check.** Before paying, the agent compares the vault's USDC balance on Solana with the mint's reported liabilities, and refuses if they don't add up.
3. **Pay.** The provider answers HTTP 402. The wallet checks price, mint and provider, then retries with an exact token payment in the `PAYMENT-SIGNATURE` header. Onchain: nothing.
4. **Redeem.** The provider redeems the tokens at the mint, which marks them spent and credits the provider in one database transaction. Only then is the data served. A replayed payment is refused.
5. **Settle.** The mint signs one `settle_batch` transaction that pays each provider's registered USDC account for many calls. Onchain: one payout from the vault, no payer.

## Limits and trust

- **Budget and recipients:** tokens limit total spend and require an allowed provider's signature. The default token lock includes all active providers at funding time. `WALLET_ALLOWLIST` can narrow spending in wallet code; it does not change existing locks.
- **Price and data:** an allowed provider can charge up to the wallet's per-call cap. An agent can waste its whole budget on allowed providers. Payment does not establish that returned data is accurate.
- **Custody:** the mint can censor, under-report issuance or misuse its settlement authority. The vault restricts payout addresses, but it does not prove those payouts correspond to honest redemptions. Deployment and upgrade authorities remain trusted.
- **Reserves:** the agent reads the vault balance itself and compares it with mint-reported outstanding liabilities. It fails closed on errors, but cannot detect a mint that lies about issuance. Fake-chain mode does not provide an onchain reserve check.
- **Privacy:** deposits and provider payouts are public. Providers see queries, and the mint sees redemption amounts and times. No shared relay, Tor or Oblivious HTTP layer is implemented.
- **Recovery:** a lost paid response can consume tokens without delivering data. Funding state supports recovery at persisted checkpoints, not exactly-once deposits across every crash. See [wallet recovery limits](docs/design/04-wallet-sdk.md#recovery-limits).
- **Prototype:** no mainnet support, refunds, swap/change, key rotation, sanctions screening or independent security audit. Mint signing helpers are non-constant-time; this is not a production custody service.

## Documentation

| Document | Contents |
|---|---|
| [Run it locally](docs/RUNNING.md) | Installation, PostgreSQL, services, CLI and tests |
| [Run the demo](docs/DEMO.md) | One-command devnet demo, `exact` comparison, competitor bot |
| [Why Blindfold](docs/why-blindfold.md) | The problem, evidence, use cases, landscape and pitch lines |
| [MVP and add-ons](docs/mvp.md) | Implemented scope and planned work |
| [Design](docs/design.md) | Flow, trust, privacy and future options |
| [Interfaces](docs/design/00-interfaces.md) | Wire formats, accounts, HTTP APIs and configuration |
| Components | [Vault](docs/design/01-vault.md), [mint](docs/design/02-mint.md), [provider](docs/design/03-mock-api.md), [wallet](docs/design/04-wallet-sdk.md), [agent](docs/design/05-agent.md) |
| [Plan](docs/plan.md) | Delivery schedule and remaining work |
| [Security sources](docs/security-sources.md) | External references and their relevance |
