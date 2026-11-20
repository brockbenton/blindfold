## 1. What TradFi does (0:00-0:30)

In traditional markets, showing your hand costs money. If a big fund's order is visible, someone trades ahead of it. So Wall Street built private channels.

Dark pools handled about 17 to 18 percent of US equity volume in 2025. And off-exchange trading passed half of all US equity volume for the first time. Hiding intent is worth enough that in 2016, Barclays and Credit Suisse paid about 154 million dollars for misleading clients about how well their dark pools protected them.

## 2. DeFi and AI agents can't do this (0:30-1:05)

AI agents are starting to buy market data the same way, per call, over x402. CoinGecko, Birdeye and others sell it for about a cent a request. But x402 volume fell sharply this year. One report puts daily settlement volume down 93 percent.

Part of the problem: on Solana, every one of those calls is a public USDC transfer. Here's our agent buying SOL whale-flow data the standard way. Three purchases, three public transfers, and the memo names the token.
Our watcher reads the chain and calls it: BUY SOL. Before the agent has even traded.

## 3. Until now (1:05-1:12)

An agent can't hide its research on a public chain. Until now. We built Blindfold.

## 4. What it is and how it works (1:12-2:35)

Blindfold is a new x402 payment scheme on Solana. The owner deposits USDC into a vault and gets back blind-signed ecash tokens. Blind signatures mean the mint can't link the tokens it redeems to the deposit that paid for them.

The agent holds tokens, not a wallet key. When a data provider asks for payment, the agent pays with a token in an HTTP header. The provider redeems it with the mint before serving the data.

Same research as before, and nothing goes onchain. Our watcher sees nothing. Providers get paid from the vault in rounded batches on a timer. Scored against what the agent actually bought: the standard rail gave away three out of three purchases. Blindfold gave away zero.

And it keeps the agent safe. Tokens only work at registered providers, so a poisoned feed can't redirect payment. The wallet enforces a budget and asks the owner before big purchases. Before paying, the agent checks Solana itself. If the vault holds less than the mint has issued, it pays nothing. 

QuickNode Streams powers our watcher. So the attacker we beat is reading real chain data in real time.

## 5. Closing lines (2:35-2:50)

Wall Street hides its orders. Blindfold hides what your agent is thinking.

