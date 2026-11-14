# Blindfold

**Agent wallets that can't be drained and can't be watched.** An AI agent pays for data APIs over [x402](https://github.com/x402-foundation/x402) with ecash tokens backed by USDC on Solana. Blindfold is a custom x402 v2 payment scheme (`cashu`), so providers and agents use the standard x402 SDKs. The spending rules are inside the tokens, so the agent can't be drained or tricked into paying the wrong party. The tokens are blind-signed, so the chain, the providers and the mint can't link the agent to the APIs it buys from.

Tracks: **Agentic Payments & AI**, **Best use of Solana**, **QuickNode Streams**.

| Doc | What's in it |
|---|---|
| **README.md** (this) | Problem, what we solve and don't, competitors, demo |
| [`docs/mvp.md`](docs/mvp.md) | MVP scope, add-ons in priority order, cut rules |
| [`docs/design.md`](docs/design.md) | How it works: flow, crypto, guardrails, settlement, Temporal, trust model, leaks |
| [`docs/design/`](docs/design/00-interfaces.md) | Per-component build briefs: interface contract (00), vault, mint, mock API, wallet SDK, agent |
| [`docs/plan.md`](docs/plan.md) | Week plan, repo layout, risks, open questions |
| [`docs/security-sources.md`](docs/security-sources.md) | The x402 security research we cite, and how to cite it |

## What we solve

| # | Problem | Demo moment |
|---|---|---|
| 1 | **Agent safety:** agents can be drained or tricked into paying the wrong party | Prompt injection fails |
| 2 | **Research privacy:** what an agent buys reveals its strategy | Competitor bot sees nothing |
| 3 | **Provider confidentiality:** a provider's customers and revenue are public | One settlement, can't attribute |

### 1. Agent safety

In normal x402 the agent holds a wallet key, and its limits are just code. In August 2026 V12 reported that the default x402 client had **no spending limit**: a hostile server could request the wallet's whole balance. It was patched within days, but the fix is a limit in client code, which a bug or a compromised agent can get around. Separately, a USENIX Security 2026 study found that every x402 facilitator it tested broke at least one security rule. Details and how to cite them: [`docs/security-sources.md`](docs/security-sources.md).

**Ours:** the agent never holds USDC or a key, only tokens, and the rules are in the tokens: a budget it can't exceed and a lock so only allowlisted providers can redeem them. The agent also doesn't trust our mint: before spending, it reads the vault's USDC balance from Solana and refuses to pay if it doesn't cover the tokens outstanding. Add-ons: an owner co-signature for anything beyond a small allowance, and a time lock that returns unspent tokens. See [`docs/design.md`](docs/design.md#guardrails-in-the-tokens).

**Doesn't solve:** an injected agent can still waste its budget on allowed providers; a malicious allowlisted provider can overcharge up to the per-call cap (enforced in the wallet SDK, not the tokens); poisoned data; a dishonest mint. We don't claim to fix x402 security in general.

### 2. Research privacy

Agents already buy market data over x402: [CoinGecko](https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402), [CoinMarketCap](https://coinmarketcap.com/api/x402/), [Nansen](https://docs.nansen.ai/getting-started/agentic-payments/x402-payments.md), [Birdeye](https://birdeye.so/data-api/changelog). Each payment puts agent, provider, amount and time onchain, and the payment header hands the payer's address to the provider ([TACEO](https://core.taceo.io/articles/x402-privacy-gap/), [Curvy](https://curvy.box/x402-privacy/)). A wallet suddenly paying a wallet-flow API 12 times tells copy-traders where to look.

**Ours:** one deposit, then offchain token payments; providers are paid in batches. Chain, provider and mint can't link the agent to the providers it uses. No gas per call.

**Doesn't solve:** **the agent's trades are still public.** We hide the research, not the trade, so the protection is the window before it acts. The provider still reads the query (just not who sent it). IP addresses and timing still leak, especially with few users.

### 3. Provider confidentiality

Normal x402 publishes a provider's customers, per-customer usage and revenue, which exposes negotiated rates (TACEO). Blindfold hides customers by default. Hiding revenue too is the last add-on and has a cost (see [`docs/design.md`](docs/design.md#settlement-and-hiding-provider-revenue)).

## Why now

- The privacy leak is widely recognized: TACEO Merces, Fhenix, Curvy, bigrceo/hush and Shinjuku have all worked on private x402, and Circle is building privacy into Arc.
- The safety problem is current, verifiable and a stated track objective. No privacy project fixes it with the tokens themselves.
- x402 is a Linux Foundation standard backed by Visa, Mastercard, Google, Stripe and Circle ([PaymentsJournal](https://www.paymentsjournal.com/industry-backed-x402-foundation-is-aimed-at-agentic-commerce-gaps/)).

Privacy alone is crowded; safety plus privacy is not. Expected objections are in [`docs/plan.md`](docs/plan.md#risks).

## Competitors

| | Normal x402 | [x402 `batch-settlement` on Solana](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_svm.md) | [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement) | [bigrceo/hush](https://github.com/bigrceo/hush) | [TACEO](https://financialit.net/news/payments/taceo-merces-brings-confidential-payments-x402-new-internet-payment-standard) / [Curvy](https://curvy.box/x402-privacy/) | **Blindfold** |
|---|---|---|---|---|---|---|
| Hidden from chain | ✗ | ✗ (one public channel per payer and provider) | per call (batched) | ✓ | amounts / addresses | ✓ |
| Hidden from provider | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| Hidden from operator | n/a | n/a | ✗ | ✗ | n/a | **✓ blind signatures** |
| Guardrails enforced by | agent code | channel (one provider per funded channel) | agent code | server | agent code | **the tokens** |

**What's new.** Cashu ecash over HTTP 402 already exists for Bitcoin agents ([Cashu NUT-24](https://cashubtc.github.io/nuts/24), [xcashu](https://github.com/callebtc/xcashu), [x402-cashu](https://github.com/orangerabbit-io/x402-cashu) and several hackathon wallets). Those pay a Lightning-backed mint in sats, and the agent holds spendable tokens it could send anywhere. Blindfold is the first we know of to:

1. Back Cashu with **USDC on Solana**: an Anchor vault holds the dollars, deposits mint tokens, and providers are paid in batched USDC payouts onchain.
2. Use the token lock as the **agent guardrail**: every token is locked 1-of-N to registered providers, so a compromised agent has nothing it can redirect.
3. Make the custodial mint **auditable onchain**: deposits, payouts and the vault balance are all onchain, and the issuance-log add-on makes tokens issued public too.
4. Ship it as a standard **x402 v2 scheme**, so it sits next to normal `exact` payments on the same endpoint.

We reuse Cashu's token specs and the x402 SDKs rather than reinventing them. [Shinjuku Shielded](https://github.com/ShinjukuStaition/shinjuku-shielded) (private x402 facilitator on Solana) was archived Oct 2026. Inspiration: [kshinn/umbra-gateway](https://github.com/kshinn/umbra-gateway) (reference only; no building on pre-existing projects).

## Demo (3 minutes)

1. **Prompt injection (45 s):** a hostile server could drain an x402 agent's wallet. That was patched in client code, not in the structure. A poisoned API response tells our agent to pay `evil-provider.xyz`; the payment fails because no token can be redeemed there. (With add-on 4: a call above the allowance makes the agent ask the owner to co-sign.)
2. **The leak (45 s):** same research task, same provider endpoint, paying with x402's standard `exact` scheme. The competitor bot watches the chain, sees the agent paying for token X data, and copies the trade.
3. **Blindfold (45 s):** same task and endpoint, paying with the `cashu` scheme. The bot sees one deposit and nothing else.
4. **Settlement (30 s):** one transaction pays providers. With add-on 6, issuance and payouts reconcile with the vault balance.
5. **Close (15 s):** "Agent wallets that can't be drained and can't be watched."

Many sources are vendor blogs or secondary reports. Volume figures (about $28k/day of x402 in March 2026, roughly half wash trading: [StartupHub](https://www.startuphub.ai/ai-news/startup-news/2026/x402-payments-the-real-numbers), [MEXC](https://www.mexc.com/news/901995)) use different months and methods.
