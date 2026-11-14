# 03: Mock paid API (provider)

Standalone brief. Build from this file plus [`00-interfaces.md`](00-interfaces.md) (the contract; it wins on any conflict). Section references like §7.3 mean that file.

## 1. Purpose

A fake paid market-data API that behaves like a real Blindfold provider. It answers unpaid calls with HTTP 402 and an x402 v2 `PAYMENT-REQUIRED` offering scheme `cashu` (00 §7), and on the paid retry validates the `cashuB` token, signs the proofs with its Cashu key, redeems them online at the mint, and only then serves data. It uses the stock `@x402/hono` `paymentMiddleware` and adds two small Blindfold pieces (a server scheme and a facilitator), so the add-on demo can run several providers, or an extra `exact` payment option, from one codebase.

## 2. Depends on / used by

| Relation | What | Ref |
|---|---|---|
| Depends on | Token and lock formats | §3.3, §3.4 |
| Depends on | Mint `POST /v1/blindfold/redeem`, `GET /v1/keysets` | §5.6, §5.1 |
| Depends on | `packages/protocol`: `x402` helpers (`cashuExtra`, constants), `signerSet`, constants, `env`, error codes | §8 |
| Depends on | `@x402/core`, `@x402/hono` 2.31.x | §2, §7 |
| Depends on | Env vars `PROVIDER_SECRET_KEY`, `PROVIDER_ID`, `PRICE_CENTS`, `PORT`, `PUBLIC_URL`, `MINT_URL` | §9 |
| Used by | Wallet SDK (04) and simple agent (05): the x402 handshake | §7.1, §7.2, §7.4 |
| Used by | `scripts/e2e.ts`: paid call, replay | §10 |
| Used by | Mint (02) operator: the provider's pubkey is registered onchain with `register_provider` | §4.3 |
| Later used by | Competitor demo (add-on) and extraction of `src/x402/` into a package | |

## 3. MVP scope

| Item | Detail |
|---|---|
| Process | One Node 22 ESM process, one provider identity |
| `GET /health` | Free. `200 {"ok": true, "pubkey": "<hex33>", "provider_id": 0}` |
| `GET /v1/data/:topic` | Paid, `PRICE_CENTS` (default 5). Fake market data, deterministic per topic (seeded by the topic string), body exactly as §7.5: `{ topic, price, change_24h_pct, volume_24h, whale_netflow, as_of }` |
| `GET /v1/data/:topic/depth` (optional) | Paid, a different price (e.g. 10), to show per-route pricing |
| Pricing | Fixed integer cents per route, set in the route config (`price: { amount, asset }`, amount = cents * 10_000) |

## 4. Out of scope

List only: multiple provider processes, the `exact` baseline path (add-on 1, competitor demo), poisoned responses (prompt-injection demo), rate limiting, persistence, auth, refunds.

The design must make these easy later:

| Later feature | Hook already in the design |
|---|---|
| Several providers | `createApp(opts)` has no globals. Each call takes its own secret key, price and redeem client, so the demo mounts N instances on N ports or path prefixes |
| Per-route price | Each route entry in the `paymentMiddleware` route config carries its own `price: { amount, asset }` |
| `exact` baseline (add-on 1) | Add a second `accepts` entry on the same route: `{ scheme: "exact", network: SOLANA_DEVNET_CAIP2, payTo: <provider Solana address>, price: ... }`. Register `ExactSvmScheme` from `@x402/svm` on the resource server for that network, and add `HTTPFacilitatorClient({ url: "https://x402.org/facilitator" })` (verified: it supports `exact` on Solana devnet, v2) to the facilitator list. The resource server routes each scheme to the facilitator whose `getSupported` lists it, so `cashu` goes to `BlindfoldFacilitator` and `exact` to the public one. The client picks the entry its registered schemes can pay |
| Poisoned response | A plain Hono route concern: the handler (or a Hono middleware after `paymentMiddleware`) returns the replacement body. Settle has already happened, so no payment code changes |
| Rate limiting | Plain Hono middleware placed before `paymentMiddleware` |

## 5. Design

### 5.1 Framework

**Hono** on `@hono/node-server`, with `@x402/hono` for the paywall. Handlers use Web `Request`/`Response` (easy to test with `app.request()` and no port), and it is ESM and TypeScript native like `cashu-ts`. The spike (`spikes/x402-cashu/spike.ts`) is the reference for the exact SDK usage below.

### 5.2 Wiring

```ts
// apps/mock-api/src/app.ts
const resourceServer = new x402ResourceServer([new BlindfoldFacilitator({ ... })])
  .register(SOLANA_DEVNET_CAIP2, new CashuServerScheme({ mintUrl, providerPubkey }));

app.use(paymentMiddleware({
  'GET /v1/data/:topic': {
    accepts: [{ scheme: 'cashu', network: SOLANA_DEVNET_CAIP2, payTo: providerPubkey,
                price: { amount: String(5 * 10_000), asset: USDC_MINT } }],   // PRICE_CENTS * 10_000
    description: 'market data',
  },
  'GET /v1/data/:topic/depth': { accepts: [{ /* same, price 10 cents */ }], description: 'order book depth' },
}, resourceServer));
app.get('/v1/data/:topic', handler);     // runs only after settle succeeded
```

`GET /health` is not in the route config, so it is free. `PUBLIC_URL` is used for `resource.url`.

### 5.3 Blindfold pieces (`apps/mock-api/src/x402/`)

Both live in the mock API for now. They have no imports from the rest of `apps/mock-api`, so they can move to a package later (the facilitator is provider-side because it signs with the provider key).

**`CashuServerScheme`** implements `SchemeNetworkServer` (`@x402/core/types`):

| Member | Value |
|---|---|
| `scheme` | `"cashu"` |
| `defaultAssetTransferMethod` | `"default"` (SDK plumbing, no on-wire method) |
| `paymentFlows` | `{ default: { supported: ["upfront"], default: "upfront" } }` so settle runs before the handler |
| `parsePrice(price, network)` | Accepts only an `AssetAmount` (`{ amount, asset }`); returns it unchanged. Any other shape throws (no `"$0.05"` money strings) |
| `enhancePaymentRequirements(req)` | Returns `req` with `extra` gaining `cashuExtra({ mintUrl, providerPubkey })`: `{ mints: [mintUrl], unit: "usd", nut10: { k: "P2PK", d: providerPubkey } }` (00 §7.1). `payTo` already equals `providerPubkey` |

**`BlindfoldFacilitator`** implements `FacilitatorClient` (`@x402/core/http`), behaviour per 00 §7.3:

```ts
export interface RedeemClient {
  redeem(proofs: WireProof[]): Promise<RedeemResult>; // throws RedeemError | MintUnavailableError
}
export interface RedeemResult { provider_id: number; amount: number; redemption_id: string }

export interface BlindfoldFacilitatorOptions {
  mintUrl: string;                 // MINT_URL, also the only accepted mint
  providerSecretKey: string;       // secp256k1 hex, 32 bytes
  redeem: RedeemClient;            // real: HttpRedeemClient(mintUrl); tests: fake
  keysets?: KeysetSource;          // default: fetches GET {mintUrl}/v1/keysets, cached
  redeemTimeoutMs?: number;        // default 8000
  log?: Logger;
}
```

| Method | Behaviour |
|---|---|
| `getSupported()` | `{ kinds: [{ x402Version: 2, scheme: "cashu", network: SOLANA_DEVNET_CAIP2 }], extensions: [], signers: {} }` |
| `verify(payload, req)` | Not called in the `upfront` flow. Returns `{ isValid: true }` if `payload.payload.token` decodes, else `{ isValid: false, invalidReason: "malformed_token" }` |
| `settle(payload, req)` | Runs 5.5 on the token, signs (5.6), calls redeem (5.7). Success: `{ success: true, transaction: redemption_id, network, amount: req.amount }`. Failure: `{ success: false, errorReason, transaction: "", network }` with the reasons in 5.5 and 5.7 |

Constructor validates inputs (throws on bad key length). Never throws from `settle`; every failure becomes a `SettleResponse`.

### 5.4 Request flow

1. No `PAYMENT-SIGNATURE` header: `paymentMiddleware` returns `402` with `PAYMENT-REQUIRED` (00 §7.1), built from the route config plus `enhancePaymentRequirements`. No log of the caller.
2. With the header: the SDK checks `accepted` against the route's requirements and calls `BlindfoldFacilitator.settle` (the `upfront` flow skips `verify`).
3. `settle` validates the token (5.5). Any failure returns `success: false` with the reason; nothing is redeemed.
4. Sign every proof with the provider key (5.6).
5. `POST /v1/blindfold/redeem` with the signed proofs (5.7). Wait for the answer.
6. Mint `200`: `settle` returns `success: true`, the SDK sets `PAYMENT-RESPONSE` and runs the route handler.
7. Any `success: false`: the SDK answers `402` and the handler is not run (00 §7.3). The reason is only in the provider's log, and possibly in the `402` (open question 4).

Never serve data before step 6 succeeds. Never cache a "paid" state: each request pays itself.

### 5.5 Validation steps, in order

Run inside `settle`. `errorReason` strings are part of the contract (00 §7.3). Keep them stable.

| # | Check | `errorReason` |
|---|---|---|
| 1 | `payload.payload.token` is a string starting with `cashuB`, length cap 64 KiB, decodes | `malformed_token` |
| 2 | `token.mint` equals `mintUrl` after trimming trailing `/` | `wrong_mint` |
| 3 | `token.unit` is `usd` | `wrong_unit` |
| 4 | `1 <= proofs.length <= 64` (00 §5.6 limit), no duplicate `secret` | `malformed_token` |
| 5 | Sum of `proof.amount` is **exactly** `BigInt(req.amount) / 10_000n` (and `req.amount` is a whole number of cents) | `wrong_amount` |
| 6 | Every proof has no `witness` | `unexpected_witness` |
| 7 | Every `secret` parses as NUT-10 `P2PK` and `signerSet(secret)` contains `providerPubkey` | `wrong_lock` |
| 8 | Every proof is `SIG_INPUTS`, no `locktime` or `refund` tag (the mint rejects otherwise with `70001`; fail early) | `wrong_lock` |

The amount check uses `req.amount` (the requirements the SDK matched to the route, not client-supplied), so the price cannot be spoofed.

### 5.6 cashu-ts calls (v4.13.1, ESM only)

```ts
import { getDecodedToken, signP2PKProofs, parseP2PKSecret } from '@cashu/cashu-ts';
```

| Step | Call |
|---|---|
| Decode token | `getDecodedToken(token, keysetIds)` where `keysetIds` is the list of full ids from `GET {mintUrl}/v1/keysets`. Needed because V4 tokens may carry short ids. Returns `{mint, unit?, proofs, memo?}`. Wrap in try/catch: it throws on garbage |
| Amounts | `proof.amount` is an `Amount` object, not a number. Use `.toNumber()` for sums and compare as integers (implicit numeric coercion is deprecated and throws in v5) |
| Signer set | `signerSet(proof.secret)` from `packages/protocol` (00 §8); it wraps `parseP2PKSecret` (throws on malformed) and returns `data` plus the `pubkeys` tag values |
| Sign | `signP2PKProofs(proofs, providerSecretKey)`. It signs only proofs whose lock includes the key; afterwards assert every proof has `witness.signatures.length === 1`, else `wrong_lock` |
| Wire form | 00 §3.4 needs `witness` as the JSON **string** `{"signatures":["<hex>"]}` and `amount` as a JSON **number**. `signP2PKProofs` yields an object witness and `Amount.toJSON()` yields a string, so map explicitly: `{...p, amount: p.amount.toNumber(), witness: JSON.stringify(p.witness)}`. Never `JSON.stringify` raw cashu-ts proofs |

The mint keyset list (00 §5.1 lists all keysets, including inactive ones) is cached in memory. On an unknown keyset id, refetch once, then fail `malformed_token`. If the keyset fetch fails, `settle` returns `mint_unavailable`.

### 5.7 Redeem call

`HttpRedeemClient.redeem` does `POST {mintUrl}/v1/blindfold/redeem`, JSON `{ "proofs": [...] }`, `AbortSignal.timeout(redeemTimeoutMs)`, no automatic retry.

**Why redeem online before serving:** the token is a bearer instrument and the provider cannot see the spent set. Only the mint's atomic insert of every `Y` (00 §5.6 step 8) proves the token was unspent and now belongs to this provider. Serving first would let a replay or a double spend get free data, and a mint rejection after serving would leave the provider unpaid. The `upfront` flow gives exactly this order.

| Outcome | `settle` result | Why |
|---|---|---|
| `200` | `success: true`, `transaction = redemption_id` | Paid |
| `400` Cashu error | `success: false`, `errorReason: "redeem_failed_<code>"` (e.g. `redeem_failed_11001` spent, `redeem_failed_10001` bad signature, `redeem_failed_70002` not a registered provider) | 00 §7.3 |
| Timeout, connection error, `5xx` | `success: false`, `errorReason: "mint_unavailable"` | State unknown |

Idempotency: the mint's transaction is all-or-nothing and keyed on each `Y`, so a duplicate request cannot double-credit. The provider does **not** retry on timeout. If the first call actually committed, a retry would return `11001` and the provider would wrongly report failure. Instead `settle` fails with `mint_unavailable`, the client sees `402`, and the wallet runs `checkstate` (00 §7.4): `SPENT` means the provider was paid but the response was lost (wallet drops the proofs), `UNSPENT` means retry is safe. Accepted MVP loss: a provider-paid call with a lost response serves no data.

### 5.8 Logging

One JSON line per request (pino or console): `ts`, `route`, `outcome` (`challenge`, `served`, `rejected:<errorReason>`), `amount`, `redemption_id`, `latency_ms`. Log `errorReason` here, since the client may not see it. Never log the `PAYMENT-SIGNATURE` value, secrets, or proof `C`/`secret`. Log `Y` only if needed for debugging. No client IP (matches the privacy claim).

### 5.9 Provider pubkey

```ts
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { bytesToHex, hexToBytes } from '@noble/curves/utils'; // or node Buffer
const providerPubkey = bytesToHex(getPubKeyFromPrivKey(hexToBytes(providerSecretKey)));
```

Must be 33-byte compressed lowercase hex (66 chars, prefix `02`/`03`). Assert this at startup. This value is what the operator passes to `register_provider` and what `/health` prints. The operator also adds a mint `config/providers.json` entry that matches what this process serves, including `topics` (what `GET /v1/data/:topic` answers; the agent picks a provider by topic, 05):

```json
{ "provider_id": 0, "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5, "topics": ["sol", "btc", "eth"] }
```

`price_cents` equals `PRICE_CENTS`, `url` equals the public base URL of this process.

## 6. File layout

```
apps/mock-api/
  package.json              deps: hono, @hono/node-server, @x402/core, @x402/hono, @cashu/cashu-ts, @blindfold/protocol, zod
  tsconfig.json
  src/
    index.ts                load env (00 §9), build app, serve on PORT
    app.ts                  createApp(opts): Hono with /health, paymentMiddleware route config, paid routes (testable, no listen)
    x402/                   no imports from the rest of apps/mock-api; may move to a package later
      cashuServerScheme.ts  CashuServerScheme
      blindfoldFacilitator.ts  BlindfoldFacilitator (getSupported, verify, settle)
      verifyToken.ts        pure validation of 5.5, returns {ok} | {error}
      redeemClient.ts       RedeemClient, HttpRedeemClient, error classes
      keysets.ts            KeysetSource with cache
    data/marketData.ts      seeded fake data generator
  test/
    helpers/fakeMint.ts     in-memory mint (section 7)
    helpers/makeToken.ts    local keyset + locked token factory
    helpers/payClient.ts    x402Client + wrapFetchWithPayment with a minimal test cashu client scheme
    x402.test.ts
    app.test.ts
```

## 7. Stubs: build and test before the mint exists

Test runner: vitest. Tests use a port-0 server (the x402 client needs real HTTP) or `app.request()`; no external network.

| Piece | How |
|---|---|
| Fake redeem client | Implements `RedeemClient`. Keeps `Set<string>` of `Y` (use `hashToCurve` from cashu-ts on each secret). Verifies the witness with the provider pubkey, rejects repeats with `RedeemError(11001)`. Switches: `failWith('timeout' | 5xx | code)` |
| Fake mint (HTTP) | A small Hono app implementing `GET /v1/keysets`, `GET /v1/keys/:id` and `POST /v1/blindfold/redeem` over the same logic, for running the real `HttpRedeemClient` and the dev server before the mint is ready (`pnpm --filter mock-api fake-mint` on port 3338). It checks only: keyset known, witness signature valid, `Y` unspent, then returns `200 {provider_id, amount, redemption_id}`. It does not check `C` unless the helper below is used |
| Test paying client | `new x402Client().register(NET, testCashuScheme).setSpendControls({ allowedAssets: [...] })` wrapped with `wrapFetchWithPayment`, as in the spike. `testCashuScheme.createPaymentPayload` picks proofs and returns `{ x402Version, payload: { token } }`. Not the wallet SDK (04) |
| Token generation | `createNewMintKeys(12, undefined, { unit: 'usd' })` returns `{keysetId, pubKeys, privKeys}`. Per proof: pick a P2PK secret (`createP2PKsecret(pubkey, tags)` with the 00 §3.3 tags), blind it with cashu-ts (`OutputData.createP2PKData(...)` gives `blindedMessage` and blinding factors), sign `B_` with `createBlindSignature(B_point, privKeys[amount], keysetId)`, unblind via `OutputData.toProof(sig, keyset)`. Encode with `getEncodedToken({mint, unit: 'usd', proofs})`. Fall back to skipping blinding (fake `C` string) if the fake mint does not verify `C`; the real mint's step 3 is tested by the mint doc, not here |
| Real mint | When ready, set `MINT_URL`; the same tests run against it from `scripts/e2e.ts` |

## 8. Done when

Tests in `test/x402.test.ts` (fake redeem client, real `paymentMiddleware`, mirroring the spike checks) all pass. A "forged" request is a hand-built `PAYMENT-SIGNATURE` (base64 `PaymentPayload` with `accepted` copied from the 402).

| Test | Expect |
|---|---|
| 402 shape | No header: status 402, `PAYMENT-REQUIRED` decodes to `x402Version: 2` and one `accepts` entry: `scheme: "cashu"`, `network` = devnet CAIP-2, `asset` = `USDC_MINT`, `amount` = `"50000"`, `payTo` = `providerPubkey` (equal to `getPubKeyFromPrivKey` hex), `extra.mints = [MINT_URL]`, `extra.unit = "usd"`, `extra.nut10 = { k: "P2PK", d: providerPubkey }`, `extra.paymentFlow = "upfront"` |
| Paid call | Test paying client gets 200 with data and a `PAYMENT-RESPONSE` that `decodePaymentResponseHeader` reads as `success: true` with a non-empty `transaction`; fake mint saw witness-signed proofs with numeric amounts and string witness; wallet balance fell by the price; handler ran once, after settle |
| Locks | Exact sum locked to provider, N=1 and 1-of-3 including provider: 200 |
| Wrong amount | Forged sum 4 and sum 6 for price 5: not 200, logged `wrong_amount`, fake mint not called |
| Wrong mint | Token from `http://other`: `wrong_mint`, mint not called |
| Wrong unit | `sat` token: `wrong_unit` |
| Lock without provider key | Lock to a different key or to a 1-of-N set without ours: `wrong_lock`, mint not called |
| Has witness | Pre-signed proofs: `unexpected_witness` |
| Garbage | `cashuBxxxx`, empty, oversize: `malformed_token` |
| Replay | Same `PAYMENT-SIGNATURE` header twice: second is not 200, logged `redeem_failed_11001`, handler not run |
| Mint down | Fake client throws timeout, then 5xx: not 200, logged `mint_unavailable`, no data in body |
| No early serve | Every non-200 case above: handler never invoked (spy) |
| Status mapping | Every failure case above returns exactly 402 |
| Per-route price | Two routes, prices 5 and 10, each 402 advertises its own `amount` |
| Poisoned hook | A route whose handler returns a replacement body: returned as is after a successful settle |
| `getSupported` | Lists exactly `cashu` on the devnet CAIP-2 |
| Health | `/health` is 200 with no payment headers |
| Pubkey | 66-hex lowercase, prefix `02`/`03` |

Manual: with the real mint, `scripts/e2e.ts` steps 2 and 3 pass (00 §10).

## 9. Open questions

1. **`PROVIDER_ID` use.** It is only a sanity check against the redeem response `provider_id`. Should a mismatch be fatal (`settle` failure) or logged? Proposal: log a warning only.
2. **Lost response after a successful redeem.** The provider is paid but serves nothing; the wallet loses the call. Acceptable for the MVP; a later fix is a short-lived `redemption_id` replay cache keyed on `Y` that re-serves the data.
3. **Move `src/x402/` to a package?** Once a second provider (add-on) needs it, extract it (possibly shared with the wallet's client scheme). Not needed for the MVP.
4. **Does the SDK put `errorReason` into the `402` `PAYMENT-REQUIRED` `error` field?** The spike saw only a non-200 status. Confirm in `@x402/hono`; if it does, decide whether leaking reasons such as `wrong_lock` is acceptable (00 §7.3 says clients must not rely on it).
5. **`mint_unavailable` handling.** The SDK turns every settle failure into a plain `402`, which looks like "pay again" to the client. Decide whether the facilitator should throw instead (the SDK may map that to `500`) so clients can tell an outage from a refusal. The wallet's checkstate recovery is safe either way.
