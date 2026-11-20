## 1. What TradFi does (0:00-0:30)

In traditional markets, showing your hand costs money. If a big fund's order is visible, someone trades ahead of it. So Wall Street built private channels.

Dark pools handled 17 to 18 percent of US equity volume in 2025, and off-exchange trading passed half of all volume for the first time. Privacy matters enough that in 2016, Barclays and Credit Suisse paid about 154 million dollars for misleading clients about how well their dark pools protected them.

## 2. DeFi and AI agents can't do this (0:30-1:05)

AI agents now buy market data per call over x402. CoinGecko, Birdeye and others charge about a cent a request. But one report puts x402 daily settlement volume down 93 percent this year.

Part of the problem: on Solana, every one of those calls is a public USDC transfer. Here's our agent buying SOL whale-flow data the standard way. Three purchases, three public transfers, and the memo names the token.
Our watcher reads the chain and calls it: BUY SOL. Before the agent has even traded.

## 3. Until now (1:05-1:12)

On a public chain, an agent can't hide its research. Until now. We built Blindfold.

## 4. What it is and how it works (1:12-2:35)

Blindfold is a new x402 payment scheme on Solana. The owner deposits USDC into a vault and gets back blind-signed ecash tokens, so the mint can't link a redeemed token to the deposit that paid for it.

The agent holds tokens, not a wallet key. When a provider asks for payment, the agent sends a token in an HTTP header, and the provider redeems it with the mint before serving the data.

Same research, nothing onchain, and our watcher sees nothing. Providers get paid from the vault in rounded batches on a timer. The standard rail gave away three of three purchases. Blindfold gave away zero.

It also keeps the agent safe. Tokens only work at registered providers, so a poisoned feed can't redirect payment. The wallet enforces a budget and asks the owner before big purchases. And before paying, the agent checks Solana itself: if the vault holds less than the mint has issued, it pays nothing.

## 5. Closing lines (2:35-2:50)

Wall Street hides its orders. Blindfold hides what your agent is thinking.
