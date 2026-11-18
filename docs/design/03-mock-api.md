# 03: Mock paid API

`apps/mock-api/` is a provider using the [x402 `blindfold` handshake](00-interfaces.md#7-payment-handshake-x402-v2-scheme-blindfold). It redeems payments online before serving token data: whale flow, order-book depth and premium trade signals, in the style of the Solana DeFi feeds that sell per call over x402. The data is live market data by default ([below](#market-data)). The demo calls it TokenFeed. [Runbook](../RUNNING.md#4-mock-api-and-owner-cli).

## Configuration and routes

One Node 22+ process represents one provider. Required: `PROVIDER_SECRET_KEY` (32-byte secp256k1 hex). Defaults: `MINT_URL=http://localhost:3338`, `PROVIDER_ID=0`, `PRICE_CENTS=5`, `PORT=4000`, and `PUBLIC_URL=http://localhost:<PORT>`. Set `USDC_MINT` to the vault's mint when it differs from the devnet default.

| Route | Behavior |
|---|---|
| `GET /health` | Free `{ok: true, pubkey, provider_id}` |
| `GET /v1/data/:topic` | Paid whale flow at `PRICE_CENTS` ([body](00-interfaces.md#75-mock-api-paid-endpoint)) |
| `GET /v1/data/:topic/depth` | Paid order-book depth, default 10 cents |
| `GET /v1/data/:topic/signals` | Paid trade signal, default 25 cents. A wallet with a cap of at least 25 cents and the default approval threshold asks its owner ([05](05-agent.md#owner-approval)) |

`createApp` accepts `priceCents`, `depthPriceCents`, `signalsPriceCents`, `dataHandler`, injectable redeem/keyset clients, logging, a market source and `exact`. The depth and signals prices have no CLI environment override. The replacement `dataHandler` runs only after redemption and provides a hostile-response demo/test hook. The demo uses this hook in Act 6. The provider has no rate limiter or refund path.

`PUBLIC_URL` rewrites the request origin through `withPublicUrl` in `index.ts`. It does not add a path prefix or provide a network relay.

## Market data

`createApp({ market })` takes a `MarketSource` (`src/data/liveMarket.ts`). With no source, `createApp` uses the deterministic mock (`src/data/marketData.ts`), so tests and `pnpm crowd` stay offline and reproducible. `index.ts`, `pnpm demo` and `pnpm serve` pass `marketSourceFromEnv()`, which is **live unless `MARKET_DATA=mock`**.

The live source reads Coinbase Exchange's public, keyless REST API for the `<TOKEN>-USD` product.

| Route | Derived from |
|---|---|
| Whale flow | `/stats`: last price, 24h change against the open, and 24h volume in USD. `/trades?limit=1000`: trades at or above the top-decile notional cutoff count as whale trades, classified by taker side (Coinbase reports the maker's side). This gives `whale_netflow`, `whale_buys`, `whale_sells` and `largest_trade_usd`. `window` is `recent`, and `trades_window_s` gives the span those trades cover. |
| Depth | `/book?level=2`: the top five levels a side and the spread in basis points |
| Signals | Whale buy/sell imbalance plus the 24h trend, capped at ±0.3: `BUY` above 0.25, `SELL` below −0.25, otherwise `HOLD`. Confidence runs from 0.5 to 0.9, and `basis` explains the inputs. |

Every response adds `source` (`live` or `mock`), plus `venue: "coinbase"` when live. `as_of` is the time the response is assembled. Each Coinbase request has a 3-second timeout. Successful stats, trades and order book results are cached for 20 seconds per token. A failure (network, timeout, HTTP error, unlisted token such as JUP, malformed symbol) serves that route's mock data with `source: "mock"` and a `fallback_reason`; failures are not cached. The demo's Act 6 poisoning spreads the same live whale-flow body and adds its injected `notice`.

## `exact` baseline

The paid routes can also accept the standard x402 `exact` scheme (00 §7.1, add-on 1). With `exact` set, each challenge lists `blindfold` first and an `exact` entry second, at the same price and asset; clients pay the scheme they registered. `exact` pays `EXACT_PAY_TO`, the provider's Solana wallet, through an in-process `@x402/svm` facilitator whose key (`EXACT_FACILITATOR_KEYPAIR`) pays fees and co-signs. The payer's transfer is public and names its wallet. The facilitator uses `SOLANA_RPC_URL` and retries RPC calls refused with HTTP 429. The CLI enables it only when both variables are set.

`ExactOptions.memoTopics` (for example `["sol"]`) adds one route per feed per listed token, ahead of the `:topic` routes, whose `exact` entry sets `extra.memo` to `whale-flow/SOL`, `depth/SOL` or `signals/SOL`. The payer's transaction then carries that memo onchain, as a seller's reconciliation tag would. Topics must be 1 to 16 lowercase letters or digits. The demo, crowd demo and live stack set it. The standalone provider CLI leaves it unset.

`exact` verifies, serves the route, then settles onchain, so a settlement that fails after the transfer lands can charge the payer without returning data. The Blindfold mint is not involved in `exact` payments.

## Request flow

1. `@x402/hono` returns 402 and `PAYMENT-REQUIRED` for an unpaid route. Requirements advertise `blindfold`, the Solana devnet CAIP-2 identifier, the configured asset and base-unit price, provider Cashu pubkey, mint URL and `upfront` flow.
2. On the paid retry, the SDK matches requirements and calls the in-process `BlindfoldFacilitator.settle`. The `upfront` flow does not call `verify`; that method is only a structural decoder, not payment authorization.
3. The facilitator validates the token, adds its provider signature and calls `POST /v1/blindfold/redeem`.
4. Only successful redemption permits the route handler to run. The success response includes `PAYMENT-RESPONSE`; its `transaction` is a redemption ID, not a Solana payout signature.

A failed settle produces `402 {}` with no new `PAYMENT-REQUIRED` header in the pinned SDK. The provider logs the reason; clients cannot rely on receiving it. No paid state is cached between requests.

## Token validation

`verifyToken.ts` checks, in order:

| Check | Failure reason |
|---|---|
| String starts with `cashuB`, at most 64 KiB, decodes with known keyset IDs | `malformed_token` |
| Mint URL matches, ignoring trailing `/` | `wrong_mint` |
| Unit is `usd` | `wrong_unit` |
| 1–64 proofs, no duplicate secret | `malformed_token` |
| Proof amounts sum exactly to the route's positive whole-cent price | `wrong_amount` |
| No existing witness | `unexpected_witness` |
| Valid Blindfold P2PK lock includes this provider | `wrong_lock` |

Lock validation rejects `SIG_ALL`, time/refund locks, duplicate tags/signers and thresholds other than one. Keyset IDs are cached from `/v1/keysets` and refreshed once after a decoding failure. A failed keyset request gives `mint_unavailable`.

The facilitator signs every proof with `signP2PKProofs` and requires one witness signature. Wire conversion uses numeric amounts and string witnesses through `toWireProof`, rather than serializing raw cashu-ts `Amount` objects. A mint 400 maps to `redeem_failed_<code>`; network errors, timeout and server failures map to `mint_unavailable`.

The default redeem timeout is 8000 ms. There is no automatic redemption retry. If the mint committed but its response was lost, resending would get a spent-proof error. The provider may therefore be paid without serving data; the wallet reconciles spent state, not delivery of the resource.

## Provider registration

The public key is derived at startup and returned by `/health`. Register it through the vault admin, or `/dev/provider` in fake-chain mode. `PROVIDER_ID` is only a sanity check: a mismatch with the mint's response is logged, not a failed payment. The mint credits the verified signing key's registered ID.

The mint's provider metadata must use the actual ID, public base URL, topics and price. It is loaded at mint startup. Each app instance has its own key and clients; multiple instances can be created programmatically, although the standard CLI starts one.

## Logging and privacy

Request middleware logs unpaid challenges and served responses. The facilitator logs settlement outcome, reason, amount, redemption ID and latency separately. This is not one uniform JSON record per request. It does not log payment headers, proof secrets or client IPs. Network endpoints can still observe client addresses and timing; no transport-anonymity claim follows from the log format.

## Source and tests

`src/app.ts` wires Hono routes and the SDK; `src/x402/` contains the server scheme, facilitator, token validation, HTTP redeem client, keyset cache and the `exact` baseline facilitator (`exactBaseline.ts`). `src/data/liveMarket.ts` supplies the live Coinbase source and its fallback; `src/data/marketData.ts` supplies the deterministic fixtures. `test/helpers/world.ts` uses shared testkit crypto and an in-process fake mint/redeem world.

`test/x402.test.ts` covers challenges, paid calls, exact amounts, 1-of-N locks, malformed tokens, replay, mint outages, no early serving, per-route pricing and replacement data. `test/exact.test.ts` covers the `exact` challenge entry, routing to its facilitator, failed settlement and rate-limit retries. Node's HTTP header limit can be lower than the 64 KiB token cap, so oversize tokens are tested directly on the facilitator. The application integration suite exercises these components against the real mint with PostgreSQL and a fake chain.

For manual local testing, use the [fake-chain mint](../RUNNING.md#3-fake-chain-mint).
