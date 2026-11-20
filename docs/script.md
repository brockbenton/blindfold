## 1. What TradFi does (0:00-0:30)

In traditional markets, showing your hand costs money. If a big fund's order is visible, someone trades ahead of it. So Wall Street built private channels.

Dark pools handled 17 to 18 percent of US equity volume in 2025, and off-exchange trading passed half of all volume for the first time. Privacy matters enough that in 2016, Barclays and Credit Suisse paid about 154 million dollars for misleading clients about how well their dark pools protected them.

## 2. DeFi and AI agents can't do this (0:30-1:05)

AI agents now buy market data per call over x402. CoinGecko, Birdeye and others charge about a cent a request. But one report puts x402 daily settlement volume down 93 percent this year.

Part of the problem: on Solana, every one of those calls is a public USDC transfer. l

## 3. Until now (1:05-1:12)

On a public chain, an agent can't hide its research. Until now. We built Blindfold.

## 4. What it is and how it works (1:12-2:35)

Blindfold is a new x402 payment scheme on Solana. It works in four steps.

1. Deposit. The owner deposits USDC into a Solana vault.

2. Blind-sign. The mint returns blind-signed ecash tokens, so it can't link a redeemed token to the deposit that paid for it.

3. Pay per call. The agent holds tokens, not a wallet key. When a provider asks for payment, the agent sends a token in an HTTP header, and the provider redeems it with the mint before serving the data. Same research, nothing onchain, and our watcher sees nothing.

4. Settle. The vault pays providers in rounded batches on a timer, so payouts don't line up with individual calls.

Now let's see it.

## 4b. Demo: Glass Map (~65s)

Before recording: restart `pnpm replay`, wait for "Live crowd run ready", open `localhost:5174/vault/glass-map/`, click one tx and allow local network access. Record within 10 minutes.

**Stage 0**
This is a live dashboard we built on a local Solana chain. On the left are three autonomous agents, our test subjects, researching tokens and paying per call over x402 to TokenFeed, our test data provider. On the right is an observer agent we built, which watches every x402 transaction on chain.

**Stage 1**
First, the agents use regular x402. Take Agent A: it buys one depth call and two whale-flow calls, three calls for 20 cents. Every one of those payments is a public transfer, and the memo says exactly what it bought.
*[Click Agent A's whale-flow tx → Explorer → back]*
So the observer picks them up instantly, and from the research alone it can guess a SOL trade is coming. Same for Agent B with BTC and Agent C with ETH. TokenFeed received 55 cents on chain, and the observer knows exactly which agent paid for which query. All three agents identified.

**Stage 2**
Now the same agents, same research, with Blindfold. Each agent's owner deposits one dollar into the vault, and you can see those deposits on chain. But each purchase is just a token sent over HTTP, so nothing about it reaches the chain. All the observer can say is that three dollars went into the vault. Zero agents identified.

**Stage 3**
Finally, the vault pays providers periodically. TokenFeed gets one payout of 55 cents, and 2.45 stays in the vault. So the observer learns that 55 cents of research happened, but not which agent made which query, or when.

## 4c. Back to the slides

The standard rail gave away three of three purchases. Blindfold gave away zero.

It also keeps the agent safe. Tokens only work at registered providers, so a poisoned feed can't redirect payment. The wallet enforces a budget and asks the owner before big purchases. And before paying, the agent checks Solana itself: if the vault holds less than the mint has issued, it pays nothing.

## 5. Closing lines (2:35-2:50)

Wall Street hides its orders. Blindfold hides what your agent is thinking.
