# Blindfold

Agent payments with provider-locked ecash, backed by USDC in a Solana vault.

An owner deposits USDC and receives blind-signed tokens locked to the mint's registered providers. An agent uses those tokens to buy API data through a custom x402 v2 `cashu` scheme. Providers redeem tokens at the mint before serving data and receive batched USDC payouts later.

The agent holds tokens, not a Solana signing key. It cannot redeem them to an arbitrary recipient. A compromised agent can still spend its entire token budget at allowed providers. Blind signatures hide the cryptographic link between issuance and redemption; amounts, timing, IP addresses and small user populations can still reveal activity.

## Run and test

See **[Run it locally](docs/RUNNING.md)** for prerequisites and commands. The default development path uses Node 22+, pnpm 10.33.0 and PostgreSQL. Fake-chain mode exercises the mint, provider and wallet without Solana tools or funded keys.

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

| Component | Current behavior |
|---|---|
| Vault | Accepts whole-cent deposits in a configured classic SPL mint; admin registers and deactivates providers; mint authority settles batches of up to eight providers |
| Mint | Confirms vault deposit records, issues tokens with DLEQ proofs, checks provider signatures, rejects spent proofs, tracks balances and recovers settlement attempts |
| Mock API | Offers `cashu` payments over x402; redeems before serving deterministic market data; supports per-route pricing |
| Wallet and owner CLI | Funds provider-locked tokens, selects exact payment amounts, applies per-call caps and reconciles pending payments |
| Scripted agent | Chooses a provider by topic, checks reserves before paying and periodically thereafter, reports results and refusals |

Competitor-bot and `exact` baseline demos, a complete prompt-injection demo, QuickNode Streams, owner co-signing, Temporal, onchain issuance logging and hidden provider revenue are planned work. Test hooks for hostile responses exist, but they are not a finished demo. See [MVP and add-ons](docs/mvp.md).

## Payment flow

1. The owner requests a mint quote and deposits USDC with the quote's random deposit reference.
2. The mint reads vault account state. The owner submits blinded outputs, receives signatures, verifies DLEQ proofs and writes provider-locked tokens to a file.
3. The provider returns HTTP 402. The wallet checks the price, mint and provider, then retries with an exact token payment.
4. The provider signs the tokens and redeems them online. The mint marks them spent and credits that provider in one database transaction. Only then does the provider serve data.
5. The mint periodically signs `settle_batch` transactions to pay registered provider accounts. An x402 redemption ID records offchain redemption, not an onchain payout.

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
| [MVP and add-ons](docs/mvp.md) | Implemented scope and planned work |
| [Design](docs/design.md) | Flow, trust, privacy and future options |
| [Interfaces](docs/design/00-interfaces.md) | Wire formats, accounts, HTTP APIs and configuration |
| Components | [Vault](docs/design/01-vault.md), [mint](docs/design/02-mint.md), [provider](docs/design/03-mock-api.md), [wallet](docs/design/04-wallet-sdk.md), [agent](docs/design/05-agent.md) |
| [Plan](docs/plan.md) | Delivery schedule and remaining work |
| [Security sources](docs/security-sources.md) | External references and their relevance |
