# Why Blindfold

[Design](design.md) · [Demo](DEMO.md) · [Scope](mvp.md)

## The problem in one line

Every time an AI agent pays for data with standard x402, it publishes what it is researching on a public blockchain.

## Agents already buy financial data this way

Data vendors now sell pay-per-request access over x402: USDC per call, no account, no API key.

| Provider | What it sells over x402 | Price per request |
|---|---|---|
| [CoinGecko](https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402) | Prices, liquidity, trending pools (Base and Solana); pitched at trading bots and monitoring agents | about $0.01 |
| [CoinMarketCap](https://coinmarketcap.com/api/documentation/ai-agent-hub/x402) | Pro API endpoints, DEX pair quotes | $0.01 |
| [Birdeye](https://docs.birdeye.so/reference/x402.md) | Solana DeFi data: price history, token and trade data; each request paid onchain in USDC on Solana | varies |
| [Messari](https://docs.messari.io/api-reference/x402-payments) | Market timeseries, news | $0.35 to $0.75 |

Prices come from vendor documentation and change over time.

x402 gives agents something valuable: pay any API instantly without accounts. It also removes something subscriptions always had. A fund's Bloomberg searches and data subscriptions are private. An x402 agent's purchases are public transfers from its wallet, one per call.

## What a watcher learns

With standard x402 `exact`, each paid call is a USDC transfer from the agent's wallet to the provider. A competitor reading the chain sees:

- **Who:** the agent's wallet, often the same wallet it trades from.
- **What:** which provider, and so which kind of data.
- **When and how often:** a burst of purchases about one token signals that something is about to happen.
- **The link to decisions:** data purchases followed by trades from the same wallet expose the strategy, not just the trades.

Copy-trading bots already follow profitable wallets onchain. Per-call payments hand them the research behind the trades.

## Finance already pays to hide intent

Revealed intent costs money, so markets build private channels:

- **Dark pools** are private venues where orders are not displayed before they execute. They exist so large orders do not move the price against the buyer. They handled about [17 to 18% of US equity volume in 2025](https://www.rblt.com/market-structure-reports/let-there-be-light-us-edition-75), and all off-exchange trading passed [half of US equity volume (50.6%)](https://www.cboe.com/insights/posts/2025-u-s-equities-year-in-review) for the first time. The broader figure includes wholesaler internalization, not only hidden orders.
- **Protection from predatory traders is worth enforcing.** In 2016 Barclays and Credit Suisse paid about [$154 million in combined settlements](https://www.thetradenews.com/credit-suisse-and-barclays-settle-federal-dark-pool-fines-worth-150-million) for misleading clients about protection from high-frequency traders inside their dark pools.
- **Crypto does the same.** Ethereum traders send transactions through private channels such as Flashbots Protect so bots cannot see and front-run them, and onchain dark pools such as Renegade exist.

The analogy has a limit: dark pools hide orders, Blindfold hides the data purchases before them. The principle is the same: visible intent gets exploited.

## What Blindfold changes

| | Subscription API key | Standard x402 `exact` | Blindfold |
|---|---|---|---|
| Account or API key needed | Yes | No | No |
| Public record per call | No | Yes, a transfer from the agent's wallet | No |
| Provider knows who is buying | Yes | Yes, the paying wallet | No |
| Agent holds a spendable key | API key | Wallet key with USDC | Tokens only, locked to registered providers |
| Hijacked agent can pay anyone | No | Up to the wallet balance | No |

The provider still sees the request and network metadata such as the IP address; Blindfold does not include a relay.

## Use cases

1. **Trading agents.** Buy market, order-book and whale-flow data without telling competitors what they are about to trade. This is the demo scenario.
2. **Research agents for companies.** Buy patent, supplier or market-sizing data without revealing product plans through public purchases.
3. **Personal agents.** Buy medical, legal or financial lookups without a public record linked to the user's wallet.
4. **Procurement agents.** Check prices repeatedly without signalling demand that sellers can use to raise prices.
5. **Agents handling untrusted content.** Any agent that reads web pages or API responses can be manipulated. Its tokens can only be redeemed by registered providers, so a hijacked agent cannot redirect funds to an attacker.

## Landscape

| Approach | Examples | How Blindfold differs |
|---|---|---|
| Payment guardrails | [AWS AgentCore Payments](https://builder.aws.com/content/3IUuxZQYy22L9sTIc4sBzeTbBut/an-ai-agent-with-a-wallet-and-a-spending-limit) (vendor description), [Handshake](https://github.com/George-WM/handshake), [GateKeep402](https://github.com/al1-nasir/gatekeep402) | These limit spending; payments remain public. Blindfold keeps limits and removes the public record |
| Private x402 | [TACEO Confidential x402](https://taceo.io/agents/), [Shielded x402](https://news.ycombinator.com/item?id=47036522), [Fhenix](https://www.fhenix.io/blog/the-elephant-in-room-x402-privacy), [Private-Escrow x402](https://ethglobal.com/showcase/private-escrow-x402-fj0v1), [PrivateX402](https://ethresear.ch/t/privatex402-privacy-preserving-payment-channels-for-multi-agent-ai-systems/24151) | Mostly zero-knowledge or encryption based, mostly on EVM chains. Blindfold needs no per-call proofs and puts no per-call transaction onchain |
| Cashu over HTTP 402 | [NUT-24](https://x.com/CashuBTC/status/1938200979024810045), [x402-cashu](https://github.com/orangerabbit-io/x402-cashu), [402-mcp](https://github.com/forgesworn/402-mcp), [cashu-agent](https://github.com/bachua2407-collab/cashu-agent) | Bitcoin and Lightning backed. Blindfold is backed by USDC in a Solana vault that the agent checks itself |

We found no other project combining USDC-backed ecash in a Solana vault, agent-verified reserves and standard x402 SDK compatibility. The search was not exhaustive.

## Honest limits

- **The mint is custodial.** It cannot see who buys what, and the agent verifies the vault's reserves before paying, but it holds the funds and could under-report issuance.
- **Privacy grows with users.** With few users, or distinctive amounts and timing, deposits and payouts can still be correlated.
- **It hides purchases, not trades.** Onchain trades stay public; the research behind them and the link between data and decisions do not.
- **Agent commerce is early.** This is a problem that grows as agents scale; the evidence above shows it has started.

## Pitch lines

- "Every time your agent pays for data with standard x402, it publishes what it's thinking about. Blindfold lets it pay without telling the world."
- "Wall Street routes over half its stock volume away from public exchanges because revealing intent costs money. x402 makes every AI agent publish its intent onchain, one transaction per call."
- "CoinGecko and Birdeye already sell this data per call over x402. Here is what a competitor learns when your agent buys it, and here is what it learns with Blindfold."
- "Privacy without giving up safety: the agent holds tokens, not keys, and a hijacked agent cannot pay an attacker."
