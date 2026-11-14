# 03: Mock paid API (provider)

Standalone brief. Build from this file plus [`00-interfaces.md`](00-interfaces.md) (the contract; it wins on any conflict). Section references like §7.3 mean that file.

## 1. Purpose

A fake paid market-data API that behaves like a real Blindfold provider. It answers unpaid calls with HTTP 402 and a NUT-24 payment request, validates the `cashuB` token on retry, signs the proofs with its Cashu key, redeems them online at the mint, and only then serves data. The 402 logic is a reusable middleware so the add-on demo can run several providers from one codebase.

## 2. Depends on / used by

| Relation | What | Ref |
|---|---|---|
| Depends on | Token and lock formats | §3.3, §3.4 |
| Depends on | Mint `POST /v1/blindfold/redeem`, `GET /v1/keysets` | §5.6, §5.1 |
| Depends on | `packages/protocol`: `buildPaymentRequest`, `signerSet`, constants, `env`, error codes | §8 |
| Depends on | Env vars `PROVIDER_SECRET_KEY`, `PROVIDER_ID`, `PRICE_CENTS`, `PORT`, `MINT_URL` | §9 |
| Used by | Wallet SDK (04) and simple agent (05): the 402 handshake | §7.1, §7.2, §7.4 |
| Used by | `scripts/e2e.ts`: paid call, replay | §10 |
| Used by | Mint (02) operator: the provider's pubkey is registered onchain with `register_provider` | §4.3 |
| Later used by | Competitor demo (add-on) and `packages/middleware` extraction | |

## 3. MVP scope

| Item | Detail |
|---|---|
| Process | One Node 22 ESM process, one provider identity |
| `GET /health` | Free. `200 {"ok": true, "pubkey": "<hex33>", "provider_id": 0}` |
| `GET /v1/data/:topic` | Paid, `PRICE_CENTS` (default 5). Fake market data, deterministic per topic (seeded by the topic string), body exactly as §7.5: `{ topic, price, change_24h_pct, volume_24h, whale_netflow, as_of }` |
| `GET /v1/data/:topic/depth` (optional) | Paid, a different price (e.g. 10), to show per-route pricing |
| Pricing | Fixed integer cents per route, set at route registration |

## 4. Out of scope

List only: multiple provider processes, the standard x402 `exact` baseline path (competitor demo), poisoned responses (prompt-injection demo), rate limiting, persistence, auth, refunds.

The middleware API must make these easy later:

| Later feature | Hook already in the API |
|---|---|
| Several providers | Middleware is a factory with no globals. Each call takes its own secret key, price and redeem client, so the demo mounts N instances on N ports or N path prefixes |
| Per-route price | `price` is a number or `(c) => number`, so price can depend on route or params |
| Poisoned response | `onPaid(c, ctx)` runs after redeem and may return a replacement body; default is pass through to the handler |
| `exact` baseline | The paid check is one function (`verifyPayment`). A second middleware with the same shape can be swapped in on the same routes |
| Rate limiting | Plain Hono middleware placed before `requirePayment` |

## 5. Design

### 5.1 Framework

**Hono** on `@hono/node-server`. Middleware is a typed `(c, next)` function, handlers use Web `Request`/`Response` (easy to test with `app.request()` and no port), and it is ESM and TypeScript native like `cashu-ts`. Express would need extra typing and a test client for no gain.

### 5.2 Middleware API

```ts
// apps/mock-api/src/middleware/requirePayment.ts
export interface RedeemClient {
  redeem(proofs: WireProof[]): Promise<RedeemResult>; // throws RedeemError | MintUnavailableError
}
export interface RedeemResult { provider_id: number; amount: number; redemption_id: string }

export interface RequirePaymentOptions {
  price: number | ((c: Context) => number);       // cents, integer > 0
  mintUrl: string;                                 // MINT_URL, also the only accepted mint
  providerSecretKey: string;                       // secp256k1 hex, 32 bytes
  redeem: RedeemClient;                            // real: HttpRedeemClient(mintUrl); tests: fake
  keysets?: KeysetSource;                          // default: fetches GET {mintUrl}/v1/keysets, cached
  redeemTimeoutMs?: number;                        // default 8000
  onPaid?: (c: Context, ctx: PaidContext) => Promise<unknown | void>; // optional body hook
  log?: Logger;
}
export function requirePayment(opts: RequirePaymentOptions): MiddlewareHandler;
```

`PaidContext = { amount, redemption_id, provider_id, proofCount }`. Without `onPaid` the route handler runs normally via `next()`. With it, a returned value replaces the JSON body.

At construction: derive the provider pubkey (below), build the creqA string per distinct price once and cache it, validate inputs (throw on bad key length or `price <= 0`).

### 5.3 Provider pubkey

```ts
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { bytesToHex, hexToBytes } from '@noble/curves/utils'; // or node Buffer
const providerPubkey = bytesToHex(getPubKeyFromPrivKey(hexToBytes(providerSecretKey)));
```

Must be 33-byte compressed lowercase hex (66 chars, prefix `02`/`03`). Assert this at startup. This value is what the operator passes to `register_provider` and what `/health` prints.

### 5.4 Request flow

1. No `X-Cashu` header: respond 402 (step 2). Otherwise go to step 3.
2. Build the payment request and return `402` with `X-Cashu: creqA...` and body `{"error":"payment_required","amount":<a>,"unit":"usd"}` (§7.1). No log of the caller.
3. Validate the token (5.5). Any failure returns the §7.3 `400`; nothing is redeemed.
4. Sign every proof with the provider key (5.6).
5. `POST /v1/blindfold/redeem` with the signed proofs (5.7). Wait for the answer.
6. Mint `200`: call `onPaid` if set, then `next()` and serve the data.
7. Mint `4xx` (Cashu error body): return `400 {"error":"redeem_failed","code":<mint code>}`.
8. Timeout, network error or mint `5xx`: return `502 {"error":"mint_unavailable"}`.

Never serve data before step 6 succeeds. Never cache a "paid" state: each request pays itself.

### 5.5 Validation steps, in order

| # | Check | Response (§7.3) |
|---|---|---|
| 1 | `X-Cashu` header starts with `cashuB`, length cap 64 KiB, decodes | `400 {"error":"malformed_token"}` |
| 2 | `token.mint` equals `mintUrl` after trimming trailing `/` | `400 {"error":"wrong_mint"}` |
| 3 | `token.unit` is `usd` | `400 {"error":"wrong_unit"}` |
| 4 | `1 <= proofs.length <= 64` (§5.6 limit), no duplicate `secret` | `400 {"error":"malformed_token"}` |
| 5 | Sum of `proof.amount` is **exactly** the route price | `400 {"error":"wrong_amount"}` |
| 6 | Every proof has no `witness` | `400 {"error":"unexpected_witness"}` |
| 7 | Every `secret` parses as NUT-10 `P2PK` and `signerSet(secret)` contains `providerPubkey` | `400 {"error":"wrong_lock"}` |
| 8 | Every proof is `SIG_INPUTS`, no `locktime` or `refund` tag (the mint rejects otherwise with `70001`; fail early) | `400 {"error":"wrong_lock"}` |

The reason strings are part of the contract (§7.3). Keep them stable; the wallet SDK may log them.

### 5.6 cashu-ts calls (v4.13.1, ESM only)

```ts
import {
  PaymentRequest, getDecodedToken, signP2PKProofs, parseP2PKSecret,
} from '@cashu/cashu-ts';
```

| Step | Call |
|---|---|
| Build 402 request | `new PaymentRequest(undefined, undefined, price, 'usd', [mintUrl], undefined, true, { kind: 'P2PK', data: providerPubkey }).toEncodedCreqA()`. Argument order: `transport, id, amount, unit, mints, description, singleUse, nut10`. No transport (HTTP header only), no `id`. Expected decode: `{a, u:"usd", m:[mint], nut10:{k:"P2PK", d}}` plus `s:true` |
| Lock helper | Prefer `packages/protocol` `buildPaymentRequest({amount, mintUrl, providerPubkey})` (§8). The call above is its body; use it directly only until the package exists |
| Decode token | `getDecodedToken(header, keysetIds)` where `keysetIds` is the list of full ids from `GET {mintUrl}/v1/keysets`. Needed because V4 tokens may carry short ids. Returns `{mint, unit?, proofs, memo?}`. Wrap in try/catch: it throws on garbage |
| Amounts | `proof.amount` is an `Amount` object, not a number. Use `Amount.from(...).toNumber()` for sums and compare as integers |
| Signer set | `signerSet(proof.secret)` from `packages/protocol` (§8); it wraps `parseP2PKSecret` (throws on malformed) and returns `data` plus the `pubkeys` tag values |
| Sign | `signP2PKProofs(proofs, providerSecretKey)`. It signs only proofs whose lock includes the key; afterwards assert every proof has `witness.signatures.length === 1`, else `400 wrong_lock` |
| Wire form | §3.4 needs `witness` as the JSON **string** `{"signatures":["<hex>"]}` and `amount` as a JSON **number**. `signP2PKProofs` yields an object witness and `Amount.toJSON()` yields a string, so map explicitly: `{...p, amount: Amount.from(p.amount).toNumber(), witness: JSON.stringify(p.witness)}`. Never `JSON.stringify` raw cashu-ts proofs |

The mint keyset list (§5.1 lists all keysets, including inactive ones) is cached in memory. On an unknown keyset id, refetch once, then fail `malformed_token`. If the keyset fetch fails, return `502 mint_unavailable`.

### 5.7 Redeem call

`HttpRedeemClient.redeem` does `POST {mintUrl}/v1/blindfold/redeem`, JSON `{ "proofs": [...] }`, `AbortSignal.timeout(redeemTimeoutMs)`, no automatic retry.

**Why redeem online before serving:** the token is a bearer instrument and the provider cannot see the spent set. Only the mint's atomic insert of every `Y` (§5.6 step 8) proves the token was unspent and now belongs to this provider. Serving first would let a replay or a double spend get free data, and a mint rejection after serving would leave the provider unpaid.

| Outcome | Provider action | Why |
|---|---|---|
| `200` | Serve | Paid |
| `400` Cashu error | `400 redeem_failed` with the mint `code` (e.g. `11001` spent, `10001` bad signature, `70002` not a registered provider) | §7.3 |
| Timeout, connection error, `5xx` | `502 mint_unavailable`, serve nothing | State unknown |

Idempotency: the mint's transaction is all-or-nothing and keyed on each `Y`, so a duplicate request cannot double-credit. The provider does **not** retry on timeout. If the first call actually committed, a retry would return `11001` and the provider would wrongly report failure. Instead it returns `502`, and the wallet runs `checkstate` (§7.4): `SPENT` means the provider was paid but the response was lost (wallet drops the proofs), `UNSPENT` means retry is safe. Accepted MVP loss: a provider-paid call with a lost `200` serves no data.

### 5.8 Logging

One JSON line per request (pino or console): `ts`, `route`, `outcome` (`challenge`, `served`, `rejected:<reason>`, `redeem_failed:<code>`, `mint_unavailable`), `amount`, `redemption_id`, `latency_ms`. Never log the `X-Cashu` value, secrets, or proof `C`/`secret`. Log `Y` only if needed for debugging. No client IP (matches the privacy claim).

## 6. File layout

```
apps/mock-api/
  package.json              deps: hono, @hono/node-server, @cashu/cashu-ts, @blindfold/protocol, zod
  tsconfig.json
  src/
    index.ts                load env (§9), build app, serve on PORT
    app.ts                  createApp(opts): Hono with /health and paid routes (testable, no listen)
    middleware/
      requirePayment.ts     the middleware (5.2 to 5.7)
      verifyPayment.ts      pure validation of 5.5, returns {ok} | {error}
      redeemClient.ts       RedeemClient, HttpRedeemClient, error classes
      keysets.ts            KeysetSource with cache
    data/marketData.ts      seeded fake data generator
  test/
    helpers/fakeMint.ts     in-memory mint (section 7)
    helpers/makeToken.ts    local keyset + locked token factory
    requirePayment.test.ts
    app.test.ts
```

`src/middleware/` has no imports from the rest of `apps/mock-api`, so it moves to `packages/middleware` unchanged.

## 7. Stubs: build and test before the mint exists

Test runner: vitest. Tests call `app.request()`; no network.

| Piece | How |
|---|---|
| Fake redeem client | Implements `RedeemClient`. Keeps `Set<string>` of `Y` (use `hashToCurve` from cashu-ts on each secret). Verifies the witness with the provider pubkey, rejects repeats with `RedeemError(11001)`. Switches: `failWith('timeout' | 5xx | code)` |
| Fake mint (HTTP) | A small Hono app implementing `GET /v1/keysets`, `GET /v1/keys/:id` and `POST /v1/blindfold/redeem` over the same logic, for running the real `HttpRedeemClient` and the dev server before the mint is ready (`pnpm --filter mock-api fake-mint` on port 3338). It checks only: keyset known, witness signature valid, `Y` unspent, then returns `200 {provider_id, amount, redemption_id}`. It does not check `C` unless the helper below is used |
| Token generation | `createNewMintKeys(12, undefined, { unit: 'usd' })` returns `{keysetId, pubKeys, privKeys}`. Per proof: pick a P2PK secret (`createP2PKsecret(pubkey, tags)` with the §3.3 tags), blind it with cashu-ts (`OutputData.createP2PKData(...)` gives `blindedMessage` and blinding factors), sign `B_` with `createBlindSignature(B_point, privKeys[amount], keysetId)`, unblind via `OutputData.toProof(sig, keyset)`. Encode with `getEncodedToken({mint, unit: 'usd', proofs})`. Fall back to skipping blinding (fake `C` string) if the fake mint does not verify `C`; the real mint's step 3 is tested by the mint doc, not here |
| Real mint | When ready, set `MINT_URL`; the same tests run against it from `scripts/e2e.ts` |

## 8. Done when

Tests in `test/requirePayment.test.ts` (fake mint) all pass:

| Test | Expect |
|---|---|
| 402 shape | No header: status 402, `X-Cashu` starts `creqA`, `decodePaymentRequest` gives amount = price, unit `usd`, `mints = [MINT_URL]`, `nut10.kind = 'P2PK'`, `nut10.data = providerPubkey` (equal to `getPubKeyFromPrivKey` hex); body `{"error":"payment_required","amount":5,"unit":"usd"}` |
| Valid token | Exact sum, locked to provider (N=1 and 1-of-3 including provider): 200 with data; fake mint saw witness-signed proofs with numeric amounts and string witness |
| Wrong amount | Sum 4 and sum 6 for price 5: 400 `wrong_amount`, fake mint not called |
| Wrong mint | Token from `http://other`: 400 `wrong_mint`, mint not called |
| Wrong unit | `sat` token: 400 `wrong_unit` |
| Lock without provider key | Lock to a different key or to a 1-of-N set without ours: 400 `wrong_lock`, mint not called |
| Has witness | Pre-signed proofs: 400 `unexpected_witness` |
| Garbage | `cashuBxxxx`, empty, oversize: 400 `malformed_token` |
| Replay | Same token twice: second is 400 `{"error":"redeem_failed","code":11001}` |
| Mint down | Fake client throws timeout, then 5xx: 502 `{"error":"mint_unavailable"}`, no data in body |
| No early serve | Handler is never invoked when redeem fails (spy) |
| Per-route price | Two routes, prices 5 and 10, each 402 advertises its own amount |
| `onPaid` hook | Returned value replaces the body |
| Health | `/health` is 200 with no `X-Cashu` and no payment |
| Pubkey | 66-hex lowercase, prefix `02`/`03` |

Manual: with the real mint, `scripts/e2e.ts` steps 2 and 3 pass (§10).

## 9. Open questions

1. **`PROVIDER_ID` use.** It is only a sanity check against the redeem response `provider_id`. Should a mismatch be fatal (502) or logged? Proposal: log a warning only.
2. **Lost 200 after a successful redeem.** The provider is paid but serves nothing; the wallet loses the call. Acceptable for the MVP; a later fix is a short-lived `redemption_id` replay cache keyed on `Y` that re-serves the data.
3. **`singleUse: true`** adds `s` to the creqA. NUT-24 wallets ignore it; confirm our wallet SDK does too.
