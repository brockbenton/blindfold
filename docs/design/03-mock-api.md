# 03: Mock paid API

`apps/mock-api/` is a provider using the [x402 `cashu` handshake](00-interfaces.md#7-payment-handshake-x402-v2-scheme-cashu). It redeems payments online before serving deterministic market data. [Runbook](../RUNNING.md#4-mock-api-and-owner-cli).

## Configuration and routes

One Node 22+ process represents one provider. Required: `PROVIDER_SECRET_KEY` (32-byte secp256k1 hex). Defaults: `MINT_URL=http://localhost:3338`, `PROVIDER_ID=0`, `PRICE_CENTS=5`, `PORT=4000`, and `PUBLIC_URL=http://localhost:<PORT>`. Set `USDC_MINT` to the vault's mint when it differs from the devnet default.

| Route | Behavior |
|---|---|
| `GET /health` | Free `{ok: true, pubkey, provider_id}` |
| `GET /v1/data/:topic` | Paid market data at `PRICE_CENTS` |
| `GET /v1/data/:topic/depth` | Paid depth data, default 10 cents |

`createApp` accepts `priceCents`, `depthPriceCents`, `dataHandler`, injectable redeem/keyset clients, logging and `exact`. The depth price has no CLI environment override. The replacement `dataHandler` runs only after redemption and provides a hostile-response demo/test hook. No complete prompt-injection demo, rate limiting or refund path is implemented.

`PUBLIC_URL` rewrites the request origin through `withPublicUrl` in `index.ts`. It does not add a path prefix or provide a network relay.

## `exact` baseline

For comparison only, the paid routes can also accept the standard x402 `exact` scheme (00 §7.1, add-on 1). With `exact` set, each challenge lists `cashu` first and an `exact` entry second, at the same price and asset; clients pay the scheme they registered. `exact` pays `EXACT_PAY_TO`, the provider's Solana wallet, through an in-process `@x402/svm` facilitator whose key (`EXACT_FACILITATOR_KEYPAIR`) pays fees and co-signs. The payer's transfer is public and names its wallet. The facilitator uses `SOLANA_RPC_URL` and retries RPC calls refused with HTTP 429. The CLI enables it only when both variables are set.

`exact` verifies, serves the route, then settles onchain, so a settlement that fails after the transfer lands can charge the payer without returning data. The Blindfold mint is not involved in `exact` payments.

## Request flow

1. `@x402/hono` returns 402 and `PAYMENT-REQUIRED` for an unpaid route. Requirements advertise `cashu`, the Solana devnet CAIP-2 identifier, the configured asset and base-unit price, provider Cashu pubkey, mint URL and `upfront` flow.
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

`src/app.ts` wires Hono routes and the SDK; `src/x402/` contains the server scheme, facilitator, token validation, HTTP redeem client, keyset cache and the `exact` baseline facilitator (`exactBaseline.ts`). `src/data/marketData.ts` supplies deterministic fixtures. `test/helpers/world.ts` uses shared testkit crypto and an in-process fake mint/redeem world.

`test/x402.test.ts` covers challenges, paid calls, exact amounts, 1-of-N locks, malformed tokens, replay, mint outages, no early serving, per-route pricing and replacement data. `test/exact.test.ts` covers the `exact` challenge entry, routing to its facilitator, failed settlement and rate-limit retries. Node's HTTP header limit can be lower than the 64 KiB token cap, so oversize tokens are tested directly on the facilitator. The application integration suite exercises these components against the real mint with PostgreSQL and a fake chain.

There is no `pnpm --filter mock-api fake-mint` command. For manual local testing, run the real mint with `MINT_DEV_FAKE_CHAIN=1` as described in the runbook.
