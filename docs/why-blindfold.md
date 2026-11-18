# Why Blindfold

[Design](design.md) · [Demo](DEMO.md) · [Scope](mvp.md)

## The problem in one line

A standard x402 `exact` payment on Solana exposes the payer, recipient, amount and timing. A seller memo can also identify the feed or token.

## Agents already buy financial data this way

Data vendors now sell pay-per-request access over x402: USDC per call, no account, no API key.

| Provider | What it sells over x402 | Price per request |
|---|---|---|
| [CoinGecko](https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402) | Prices, liquidity and trending pools on Base and Solana | $0.01 |
| [CoinMarketCap](https://coinmarketcap.com/api/documentation/ai-agent-hub/x402) | Supported Pro API endpoints and DEX pair quotes on Base | $0.01 |
| [Birdeye](https://docs.birdeye.so/reference/x402.md) | Solana DeFi data: price history, token and trade data; each request paid onchain in USDC on Solana | varies |
| [Messari](https://docs.messari.io/api-reference/x402-payments) | Selected legacy market endpoints | $0.35 for market details and $0.75 for daily market time series |

Prices come from vendor documentation and change over time.

Pay-per-request access lets an agent buy from a participating API without a subscription. On Solana, a paid `exact` call produces a public transfer. A subscription lookup generally does not produce a public transaction.

## What a watcher learns

With standard x402 `exact` on Solana, each paid call is a USDC transfer from the agent's wallet to the provider. A competitor reading the chain sees:

- **Who:** the agent's wallet, often the same wallet it trades from.
- **What:** which provider, and so which kind of data. If the seller tags payments with a memo (x402's `extra.memo`, used to reconcile payments), the memo is onchain too, and can name the token.
- **When and how often:** a burst of purchases about one token signals that something is about to happen.
- **The link to decisions:** data purchases followed by trades from the same wallet expose the strategy, not just the trades.

Per-call payments can give a wallet observer an additional signal before a trade.

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
| Provider can identify a payer | By account or API key | By paying wallet | From request and network metadata |
| Agent holds | API key | Wallet key with USDC | Tokens locked to registered providers |
| Payment destination | Subscription provider | Subject to client wallet policy | Registered signers in the token lock |

The provider still sees the request and network metadata such as the IP address; Blindfold does not include a relay.

## Use cases

1. **Trading agents.** Buy market, order-book and whale-flow data without telling competitors what they are about to trade. This is the demo scenario.
2. **Research agents for companies.** Buy patent, supplier or market-sizing data without revealing product plans through public purchases.
3. **Personal agents.** Buy medical, legal or financial lookups without a public record linked to the user's wallet.
4. **Procurement agents.** Check prices repeatedly without signalling demand that sellers can use to raise prices.
5. **Agents handling untrusted content.** Any agent that reads web pages or API responses can be manipulated. Its tokens can only be redeemed by registered providers, so an unregistered recipient cannot redeem them.

## Landscape

| Approach | Examples | How Blindfold differs |
|---|---|---|
| Payment guardrails | [AWS AgentCore Payments](https://builder.aws.com/content/3IUuxZQYy22L9sTIc4sBzeTbBut/an-ai-agent-with-a-wallet-and-a-spending-limit) (vendor description), [Handshake](https://github.com/George-WM/handshake), [GateKeep402](https://github.com/al1-nasir/gatekeep402) | These limit spending; payments remain public. Blindfold keeps limits and removes the public record |
| Private x402 | [TACEO Confidential x402](https://taceo.io/agents/), [Shielded x402](https://news.ycombinator.com/item?id=47036522), [Fhenix](https://www.fhenix.io/blog/the-elephant-in-room-x402-privacy), [Private-Escrow x402](https://ethglobal.com/showcase/private-escrow-x402-fj0v1), [PrivateX402](https://ethresear.ch/t/privatex402-privacy-preserving-payment-channels-for-multi-agent-ai-systems/24151) | Mostly zero-knowledge or encryption based, mostly on EVM chains. Blindfold sends ecash proofs over HTTP and batches Solana payouts |
| Cashu over HTTP 402 | [NUT-24](https://x.com/CashuBTC/status/1938200979024810045), [x402-cashu](https://github.com/orangerabbit-io/x402-cashu), [402-mcp](https://github.com/forgesworn/402-mcp), [cashu-agent](https://github.com/bachua2407-collab/cashu-agent) | Bitcoin and Lightning backed. Blindfold is backed by USDC in a Solana vault that the agent checks itself |

## Honest limits

- **The mint is custodial.** Blinding hides the direct link between issuance and later redemption. The mint chooses settlement amounts and could issue tokens without logging them.
- **Privacy needs a crowd.** If one deposit funds a batch, the payout can be linked to that owner. In the crowd demo, equal deposits leave multiple plausible contributors. Shared funding, distinctive amounts and repeated timing can weaken privacy.
- **Onchain trades stay public.** Direct Blindfold purchases leave no transaction to correlate with a later trade.
- **Agent commerce is early.** This is a problem that grows as agents scale; the evidence above shows it has started.
