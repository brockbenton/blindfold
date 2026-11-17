# 06: Gateway

`apps/gateway/` is a Blindfold provider that resells upstream x402 `exact` endpoints. Agents pay the gateway with Blindfold tokens; the gateway buys the same call from the vendor with a standard `exact` payment from one shared wallet, and returns the vendor's response. Vendors do not have to adopt anything. [Interfaces](00-interfaces.md) · [Provider](03-mock-api.md).

```
agent ──(blindfold token, HTTP header)──▶ gateway ──(x402 exact, gateway wallet, onchain)──▶ vendor
                                             │
                                  redeems at the mint; the vault pays the gateway wallet in batches
```

## What it hides, and what it does not

| A chain watcher sees | Without the gateway | With the gateway |
|---|---|---|
| Who paid the vendor | The agent's own wallet, per call | The gateway wallet, for every agent |
| What was bought | The vendor's memo, if it sets one | The same memo |
| When | Each call's time | Each call's time, from the gateway wallet |

The gateway hides **which agent** is researching, not **what** is being researched or when: the vendor's `exact` transfer is still public and can carry a memo naming the feed. Privacy again needs a crowd: with one agent behind the gateway, every gateway purchase is that agent's. The vendor sees the gateway's IP address and the requested path, never the agent's. The gateway itself sees each agent's requests, as any provider does.

## Flow per paid call

1. **Quote, before payment.** The gateway builds the upstream URL from the route map and asks the vendor for its 402 challenge (cached for 30 s). If the vendor is unreachable, not an x402 `exact` seller in the configured asset and network, or charges more than the route's `maxUpstreamCents`, the gateway answers 502 and the agent's tokens are untouched.
2. **Redeem.** The x402 middleware settles the `blindfold` payment upfront, exactly like the mock API: tokens locked to the gateway's key are signed and redeemed at the mint before the handler runs.
3. **Buy.** The gateway pays the vendor with `@x402/fetch` and `@x402/svm` from its wallet. The wallet's spend control refuses any payment above the route's cap, even if the vendor raised its price after the quote. A transient failure (network error, HTTP 5xx) is retried once.
4. **Serve.** The vendor's body and content type go back to the agent, with `X-Upstream-Payment: <signature>` naming the upstream transaction.

**Why redeem before buying.** Buying first and redeeming only on success would protect the agent, but the mint is the only party that knows whether a token is unspent. Anyone could then make the gateway buy with tokens that were already spent and drain its wallet. Redeeming first protects the shared wallet; the preflight quote in step 1 removes the common failure cases before any payment. If the purchase still fails after the redeem, the agent's 5 cents are gone: the gateway answers 502 and logs `{"outcome":"owed", "owed_cents": ...}` so the operator can make it good. There are no refunds in the protocol.

## Upstream requests

The gateway builds every upstream request from scratch. It sends only `accept: application/json` and `user-agent: blindfold-gateway/0.1`: no cookies, authorization, `X-Forwarded-For`, client headers or payment headers from the agent. Path parameters must match `[A-Za-z0-9_-]{1,64}`, so a value cannot rewrite the upstream path, and the query string is dropped except for parameters a route allowlists.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MINT_URL` | `http://localhost:3338` | Mint that redeems the gateway's tokens |
| `GATEWAY_SECRET_KEY` / `GATEWAY_SECRET_FILE` | `.keys/gateway-secret.hex` | The gateway's Blindfold provider key |
| `GATEWAY_WALLET` | `.keys/gateway-wallet.json` | Shared Solana wallet for upstream purchases; created if missing |
| `GATEWAY_ROUTES` | — | Absolute path to a JSON route map. Without it, the devnet stand-in below |
| `UPSTREAM_URL` | `http://localhost:4000` | Base URL of the stand-in vendor |
| `PORT`, `PUBLIC_URL` | `4100`, `http://localhost:4100` | Listen port; public URL used in x402 challenges |
| `SOLANA_RPC_URL`, `USDC_MINT` | devnet, Circle devnet USDC | Where the wallet pays |
| `PROVIDER_ID` | — | Logging sanity check, as for the mock API |

A route map is a JSON array. `priceCents` must be at least `maxUpstreamCents`, so the gateway never pays out of pocket:

```json
[
  { "path": "/v1/price/:sym", "upstream": "https://vendor.example/x402/price/:sym",
    "priceCents": 3, "maxUpstreamCents": 2, "description": "spot price, resold", "query": ["interval"] }
]
```

**Devnet stand-in.** Real x402 vendors (CoinGecko, Birdeye and others) sell for mainnet USDC. On devnet the default upstream is `apps/mock-api` with its `exact` baseline enabled, so every gateway call makes a real devnet `exact` transfer from the gateway wallet to TokenFeed's payout account. The stand-in resells whale flow, depth and signals at the vendor's prices (5, 10 and 25 cents). Pointing at a real vendor needs a `GATEWAY_ROUTES` map, mainnet `SOLANA_RPC_URL` and `USDC_MINT`, a mainnet vault and mint, and a funded mainnet wallet; that is not done here.

## Setup and running (devnet)

```sh
pnpm gateway:setup      # once: keys, vault registration, USDC top-up
```

`gateway:setup` creates `.keys/gateway-secret.hex` and `.keys/gateway-wallet.json` (add both to your key backup), creates the wallet's USDC account, registers the gateway as a vault provider with that account as its payout destination (signed by `deployer.json`, the vault admin), and tops the wallet up with 50 cents from `owner.json` when it holds less than 25. The payout destination closes the loop: settlement batches pay the gateway's revenue into the same wallet that buys upstream. The wallet needs no SOL; the vendor's facilitator pays transaction fees. It prints a `providers_entry` to add to the mint's `PROVIDERS_FILE`, so agents can discover the gateway by name.

Then, with the mint running:

```sh
# Stand-in vendor: mock-api with its exact baseline (EXACT_PAY_TO = TokenFeed's payout wallet)
PORT=4000 EXACT_PAY_TO=<wallet> EXACT_FACILITATOR_KEYPAIR=.keys/facilitator.json node apps/mock-api/dist/index.js
# Gateway
MINT_URL=http://localhost:3338 pnpm gateway
# Agent
node agents/simple/dist/main.js --provider Gateway --topic sol --calls 1 --json
```

The gateway is registered on the devnet vault as provider 4. A devnet run on November 17, 2026 bought one whale-flow call through it: the agent paid 5 cents in tokens, the gateway redeemed them and paid the stand-in vendor with `exact` transaction [`59xxqisw…6tk5`](https://explorer.solana.com/tx/59xxqiswU13TwFKjtTYba8pGkr7xMj466cXTQALA92m8nQePzsm4D2q3zWD1pwsNL1RHakBVrkbczXiHF4ZA6tk5?cluster=devnet).

## Tests

`apps/gateway/test` uses a fake vendor and a fake mint: pay-through order (quote, redeem, buy), the upstream price cap refusing before payment, an unreachable vendor refusing before payment, one retry on a transient failure, an `owed` record when the purchase fails after the redeem, route prices, the header and query stripping, and route-map validation.
