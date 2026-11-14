# 04: Wallet SDK and owner client (`packages/wallet`)

Standalone brief. Build from this file plus [`00-interfaces.md`](00-interfaces.md) (referred to as "00"). If they disagree, 00 wins. `cashu-ts` is 4.13.1, ESM only. Names below were checked against its `index.d.ts`.

## 1. Purpose

Two halves in one package:

| Half | Runs as | Job |
|---|---|---|
| Agent wallet | Library inside the agent process | Holds the token file, pays 402s by itself, and refuses any provider outside the proofs' signer set. Holds no key and no USDC |
| Owner client + CLI | `owner` command, run by the human | Quote, deposit, mint locked tokens, write the token file |

## 2. Depends on / used by

| Depends on | For |
|---|---|
| 00 §3.3, §3.4 | Lock shape, token file |
| 00 §5.1, §5.3, §5.4, §5.5 | checkstate, quote, mint, providers |
| 00 §4.3 | `deposit` instruction (via `packages/protocol` `vault`) |
| 00 §7 | 402 handshake |
| 00 §8 `packages/protocol` | `lock`, `paymentRequest`, `units`, `vault`, `env`, `types` |
| 00 §9 env | `MINT_URL`, `TOKEN_FILE`, `MAX_PER_CALL_CENTS`, `OWNER_KEYPAIR`, `SOLANA_RPC_URL` |
| `@cashu/cashu-ts` 4.13.1, `@anchor-lang/core` 1.2.2, `@solana/web3.js`, `commander` | Libraries |

Used by: `agents/simple` (05, imports `AgentWallet`), `scripts/e2e.ts` (00 §10 step 1 calls `ownerFund`), mock API tests (a fake paying client).

## 3. MVP scope

- `AgentWallet`: load file, `balance()`, `payFetch`, exact-sum selection, pending marking, checkstate recovery.
- Guardrails: unit, mint, per-call cap, provider allowlist, signer-set membership, exact sum.
- `ownerFund`: NUT-20 quote, deposit, poll, split, mint, DLEQ verify, write file.
- CLI: `owner fund`, `owner balance`, `owner providers`.
- Fully testable with fakes (section 7).

## 4. Out of scope (hooks noted)

| Item | Hook left |
|---|---|
| Owner approval, 2-of-2 reserve | `buildLockOptions` call in `ownerFund` takes a `lockFor(allowlist)` override later; wallet reads `witness`-free proofs only |
| Expiry or refund locks (`locktime`, `refund`) | `signerSet()` ignores them today; selection already goes through `signerSet()` |
| Temporal top-up | `ownerFund` is split into resumable steps (section 5.6) with a persisted `FundState` |
| LLM tool wrappers | One thin export `payFetchTool(wallet)` returning `{name, description, execute}`; nothing else |
| Browser support | Node `fs` used directly. Keep file I/O behind `TokenStore` so a browser store can replace it |
| Swap, change, melt, restore | Not offered by the mint (00 §5.1). No change is ever made |

## 5. Design

### 5.1 Public TS API

```ts
// src/index.ts
export class AgentWallet {
  static async open(opts?: WalletOptions): Promise<AgentWallet>;
  balance(): number;                    // cents, spendable proofs only
  pendingBalance(): number;             // cents in flight
  proofCount(): number;
  payFetch: (url: string | URL, init?: RequestInit) => Promise<Response>; // bound arrow, fetch-compatible
  recoverPending(): Promise<RecoverReport>; // checkstate on every pending entry; called by open()
  readonly allowlist: readonly string[];
}

export interface WalletOptions {
  tokenFile?: string;                   // default env TOKEN_FILE
  maxPerCallCents?: number;             // default env MAX_PER_CALL_CENTS (10)
  allowlist?: string[];                 // provider pubkeys hex33. Default: env WALLET_ALLOWLIST (comma list, 00 §9), else the union of the proofs' signer sets
  fetch?: typeof fetch;                 // injectable, default globalThis.fetch
  mint?: MintLike;                      // injectable, default new Mint(file.mint)
  now?: () => number;
}

export interface MintLike { check(p: { Ys: string[] }): Promise<{ states: { Y: string; state: 'UNSPENT' | 'SPENT' | 'PENDING' }[] }>; }

export type RefusalReason =
  | 'bad_request'            // X-Cashu missing, undecodable, or no amount/provider key
  | 'unit'                   // u != 'usd'
  | 'mint'                   // token file mint not in m
  | 'over_cap'               // a > MAX_PER_CALL_CENTS
  | 'provider_not_allowed'   // d not in configured allowlist
  | 'provider_not_in_signer_set' // d not in the signer set of the proofs
  | 'insufficient_exact'     // no subset sums to exactly a
  | 'insufficient_balance'   // total < a
  | 'amount_mismatch';       // JSON body amount disagrees with creq amount (only if body parses)

export class PaymentRefused extends Error {
  constructor(public reason: RefusalReason, public detail: Record<string, unknown>);
}
export class PaymentFailed extends Error {   // paid retry returned non-2xx (after checkstate recovery)
  constructor(public status: number, public body: string, public recovered: { returned: number; dropped: number });
}
export class TokenFileError extends Error {} // unreadable, wrong version, wrong unit

// src/select.ts
export function selectExact(proofs: Proof[], amount: number, providerPubkey: string):
  { chosen: Proof[] } | { error: 'insufficient_balance' | 'insufficient_exact' | 'provider_not_in_signer_set' };

// src/store.ts
export interface TokenStore { read(): Promise<TokenFile>; write(f: TokenFile): Promise<void>; }
export class FileTokenStore implements TokenStore { constructor(path: string); }

// src/owner.ts
export interface Depositor {
  deposit(a: { amountCents: number; depositRef: Uint8Array /* 32 bytes */ }): Promise<{ signature: string }>;
}
export class SolanaDepositor implements Depositor { constructor(o: { rpcUrl: string; owner: Keypair; programId: PublicKey; usdcMint: PublicKey }); }

export interface FundOptions {
  mintUrl: string; cents: number;                // 1..MAX_DEPOSIT_CENTS
  providerIds: number[];                         // indexes from GET /v1/blindfold/providers
  prices?: Record<number, number>;               // provider_id -> price in cents. Default: `price_cents` from the providers list, else PRICE_CENTS
  tokenFile: string; depositor: Depositor;
  stateDir?: string;                             // default ~/.blindfold/owner; holds FundState
  pollMs?: number; timeoutMs?: number;           // default DEPOSIT_POLL_MS, 10 min
  mint?: Mint; fetch?: typeof fetch;             // injectable
  onProgress?: (s: FundStep) => void;
}
export type FundStep = 'quote' | 'deposit' | 'wait_paid' | 'mint' | 'write';
export async function ownerFund(o: FundOptions): Promise<{ quote: string; cents: number; proofs: number; depositTx: string }>;
export function planDenominations(cents: number, prices: number[]): number[];  // section 5.5
export async function ownerBalance(tokenFile: string): Promise<{ spendable: number; pending: number; byDenom: Record<number, number> }>;
```

`payFetch` never throws for non-402 responses; it returns them. It throws `PaymentRefused` before any proof leaves the file, `PaymentFailed` after a bad paid retry.

### 5.2 Token file handling

00 §3.4 shape, including its optional `pending` array, `[{ proofs, url, sent_at }]`.

```json
{ "version": 1, "mint": "...", "unit": "usd", "proofs": [ ... ],
  "pending": [ { "proofs": [ ... ], "url": "<origin+path>", "sent_at": 1763166400 } ] }
```

`pending` is a separate array, not a flag on proofs, so `proofs` stays as the owner CLI wrote it, and a reader that ignores `pending` just sees a lower balance (safe). `version` stays 1. Unknown extra fields are preserved on rewrite. Entries have no id; they are addressed by array position.

| Rule | Detail |
|---|---|
| Atomic write | Write `<file>.tmp.<pid>` in the same directory, `fsync`, `rename` over the target. Mode `0600` |
| Load | Parse, check `version === 1`, `unit === 'usd'`, `mint` is a string. Else `TokenFileError`. Stored proofs are kept as written (strings and numbers; convert `amount` with `Number(p.amount)` on read, JSON never holds bigint) |
| Witness | Strip `witness` on load if present (00 §7.2 says none) |
| Duplicates | Drop proofs with duplicate `secret` on load, keep the first |
| Cross-process | One agent process per file. Take an advisory lock file `<file>.lock` (`wx` open, pid inside, stale after 60 s) on `open()`; fail with `TokenFileError` if held |

Spend state machine for one call:

| Step | File write |
|---|---|
| select | none |
| mark pending | move chosen proofs from `proofs` to a new `pending` entry. Write **before** the retry is sent |
| 2xx | delete the pending entry. Write |
| non-2xx or network error | checkstate (5.4). Move `UNSPENT` back to `proofs`, drop `SPENT`, delete entry. Write |
| crash between mark and result | `open()` runs `recoverPending()`: same checkstate treatment for every entry. If checkstate itself fails, entries stay pending (never returned blindly) |

### 5.3 `payFetch` algorithm

All under the spend mutex (5.7).

1. `res = await fetch(url, init)`. If `res.status !== 402`, return it.
2. `h = res.headers.get('x-cashu')`. Missing: `PaymentRefused('bad_request')`.
3. `req = parsePaymentRequest(h)` (protocol; wraps `decodePaymentRequest`, handles `creqA` and `creqB`). Need `amount`, `unit`, `mints`, `providerPubkey` (`nut10.k === 'P2PK'`, `nut10.d`). Anything missing: `bad_request`.
4. Validate in this order, first failure throws:

| # | Check | Reason |
|---|---|---|
| 1 | `req.unit === 'usd'` and file unit is `usd` | `unit` |
| 2 | `normalize(file.mint)` equals `normalize(m)` for some `m` (strip trailing `/`, lowercase scheme and host) | `mint` |
| 3 | `req.amount` is a positive integer and `<= maxPerCallCents` | `over_cap` |
| 4 | `req.providerPubkey` in `this.allowlist` (hex compare, lowercase) | `provider_not_allowed` |
| 5 | `req.providerPubkey` in `signerSet(secret)` of **every** candidate proof (see selection) | `provider_not_in_signer_set` |

5. `selectExact(proofs, amount, providerPubkey)` (5.4). Error maps to the refusal of the same name.
6. Mark pending (5.2).
7. `token = getEncodedToken({ mint: file.mint, unit: 'usd', proofs: chosen }, { removeDleq: true })`. Retry `fetch(url, { ...init, headers: new Headers(init?.headers) + 'X-Cashu': token })`. Same method, URL, body. If `init.body` is a stream, refuse up front with `bad_request` (cannot replay).
8. 2xx: drop the pending entry, return the response. Otherwise failure path (5.4 step 3), then throw `PaymentFailed` carrying the status and body. Do not auto-retry a failed payment.

The creq mint list is advisory input from an untrusted server. The wallet only ever pays the mint named in its own file, so a hostile `m` can only cause a refusal.

### 5.4 Exact-sum selection (deterministic)

`selectExact` is pure. Steps:

1. Candidates = proofs whose `signerSet(secret)` contains the provider key. If none but proofs exist: `provider_not_in_signer_set`. This is the prompt-injection guardrail: an unknown provider key never matches any lock, so tokens go nowhere.
2. Drop candidates with `amount > target`. If `sum(candidates) < target`: `insufficient_balance`.
3. Sort by `(amount desc, secret asc)`. Subset-sum DP over sums `0..target` (target is at most `MAX_PER_CALL_CENTS`, so at most about 10 columns and a few hundred rows): `best[s]` = the best subset reaching `s`, where better means fewer proofs, then lexicographically smaller list of `secret`s. Process proofs in the sorted order, iterate `s` downward, replace only when strictly better.
4. `best[target]` empty: `insufficient_exact`. Else return it.

Fewest-coins keeps `X-Cashu` small and preserves the owner's exact-P bundles (section 5.5). Same inputs always give the same output; unit-test with a shuffled input.

Checkstate (00 §7.4, NUT-07): `Ys = chosen.map(p => bytesToHex(hashToCurve(utf8(p.secret)).toBytes(true)))` (verify the point-to-hex helper in cashu-ts at build time; there is also `Y` computed inside `OutputData`/`Wallet`). Call `mint.check({ Ys })` (low-level `Mint.check(CheckStatePayload)`; do not instantiate `Wallet`). Map `states[i]` back by `Y`. `UNSPENT` returns to `proofs`; `SPENT` dropped; `PENDING` stays pending, retried on the next `open()` or `recoverPending()`.

### 5.5 Denomination strategy (owner side)

Problem: no swap, no change (00 §5.1, §7.2). A payment of price `P` needs a subset of the wallet summing to exactly `P`. A plain binary split of the deposit (e.g. 100 = 64+32+4) cannot pay 5.

Strategy, `planDenominations(cents, prices)`:

| Step | Rule |
|---|---|
| 1 | `prices` = distinct expected prices: `--prices` if given, else `price_cents` of the chosen providers from `GET /v1/blindfold/providers`, else (null) `PRICE_CENTS`. If empty use `[5]` |
| 2 | Budget share per price = `floor(cents * 0.8 / prices.length)`. 80% of funds is reserved for exact bundles |
| 3 | For each price `P`, `n = floor(share / P)` bundles, each bundle is the binary decomposition of `P` (5 = 4+1, 10 = 8+2, 3 = 2+1). Emit `n` copies. Max `popcount(P)` coins per call, at most 4 for `P <= 10` |
| 4 | Remainder `R = cents - spent_on_bundles` split as the **unary-pair ladder**: `1, 1, 2, 2, 4, 4, ...` while it fits, then binary for what is left. This gives every value up to about `R` as a subset sum in at least two ways, so odd prices not in `prices` (a repriced API) are still payable a few times |
| 5 | Validate: every denomination is a power of two `<= 4096`; sum equals `cents`. Pass the list as `customSplit` to `createP2PKData` per output group (throws if the keyset lacks an amount) |

Why: exact bundles guarantee `n` payments at the expected price with `popcount(P)` proofs and no search failures. The ladder covers price drift and the tail. Example: 100 cents, price 5: share 80, 16 bundles of `4+1` (32 coins), remainder 20 as ladder `1,1,2,2,4,4` (14) plus binary of 6 (`4,2`). 40 proofs total. Tradeoff: more outputs means a bigger mint request and file, but the mint redeem cap is 64 proofs per call (00 §5.6) and one call uses at most 4. The mint accepts at most 256 outputs per mint request (00 §5.4); if a plan has more, the owner splits it into chunks of at most 256, each signed and sent separately (NUT-20 allows this while the sum fits `amount_paid - amount_issued`). The default plans stay well under 256.

### 5.6 Owner flow (`ownerFund`)

Each step persists `FundState` (`stateDir/<quoteKeyPubkey>.json`, mode `0600`, atomic write) so a crash is resumable and the quote key is never lost. State holds: step, quote key hex, quote id, `deposit_ref`, planned denominations, allowlist, output secrets and blinding factors (hex) once generated, deposit tx signature.

| # | Step | Calls |
|---|---|---|
| 0 | Fetch providers | `GET {mint}/v1/blindfold/providers` (00 §5.5). Pick `provider_id in providerIds`, require `active`. Read `price_cents` for the denomination plan. `allowlist = pubkeys sorted ascending by hex` (00 §3.3). Refuse empty |
| 1 | Quote key | `sk = createRandomSecretKey()`; `pk = bytesToHex(getPubKeyFromPrivKey(sk))`. Persist `sk` **before** the quote request |
| 2 | Quote | `mint.createMintQuote('solana-usdc', { unit: 'usd', amount: cents, pubkey: pk })` (00 §5.3). Check `quote.pubkey === pk`, `amount === cents`. Persist `quote`, `request` |
| 3 | Deposit | `depositRef = hexToBytes(quote.request)` (32 bytes). `depositor.deposit({ amountCents: cents, depositRef })`. `SolanaDepositor`: `amount = centsToBaseUnits(cents)`; build the `deposit` ix with protocol `vault` helpers (`depositPda(config.deposit_count)` read from `Config` just before sending, `depositor_token` = owner USDC ATA, accounts in 00 §4.3 order); send and confirm at `confirmed`. Collision: if another deposit took the index, the tx fails on the seed; rebuild with the new `deposit_count` and resend, up to 3 times. Persist the signature |
| 4 | Wait paid | Loop `mint.checkMintQuote('solana-usdc', quote)` every `pollMs` until `amount_paid >= cents` (and `amount_paid - amount_issued >= cents`) or timeout. Resumed runs skip the deposit if the state says it was sent |
| 5 | Outputs | `keyset` = active `usd` keyset: `mint.getKeySets()`, pick `active && unit === 'usd'`, then `mint.getKeys(id)`. `outputs = OutputData.createP2PKData(buildLockOptions(allowlist), cents, keyset, planDenominations(...))`. `buildLockOptions` returns `{ pubkey: allowlist, requiredSignatures: 1, sigFlag: 'SIG_INPUTS' }` (00 §3.3). Persist each `secret` and `blindingFactor` |
| 6 | Sign and mint | `blinded = outputs.map(o => o.blindedMessage)`; `signature = signMintQuote(skHex, quote, blinded)`; `mint.mint('solana-usdc', { quote, outputs: blinded, signature })` returns `{ signatures }`. At most 256 outputs per request; chunk if more. If the response is lost (timeout, network error), resend the identical request (same outputs); the mint returns the stored signatures (00 §5.4). Never regenerate outputs after a failed attempt |
| 7 | Unblind, verify | `proofs = outputs.map((o, i) => o.toProof(signatures[i], keyset))` (unblinds). Run `verifyMintSignatures(proofs, () => keyset, { require: true })`; any entry in `invalid` aborts without writing. Check `sum(amount) === cents`. Check every proof's `signerSet(secret)` equals the allowlist (catches a lock bug before the agent hits it) |
| 8 | Write | `FileTokenStore.write({ version: 1, mint, unit: 'usd', proofs })` with `dleq` kept, `witness` absent. If the file already has proofs, append to them (top-up) |

DLEQ check uses `verifyMintSignatures` (returns `{ valid, invalid }`, never throws per proof). `hasValidDleq` is deprecated in 4.13.1 and removed in v5, so it is not used. Wrap it in `src/dleq.ts`. Amounts in cashu-ts are `Amount` objects; use `.toNumber()` at the boundary.

### 5.7 Concurrency

Single process. A promise-chain mutex (`class Mutex { run<T>(fn: () => Promise<T>): Promise<T> }`) wraps the whole of `payFetch` from the first fetch through the file write, so two parallel calls can never select the same proofs. The cost is serial payments, acceptable for the MVP. `balance()` reads the in-memory copy, which is updated only under the mutex. The advisory lock file (5.2) covers a second process.

### 5.8 CLI (`src/cli.ts`, bin `owner`)

| Command | Behavior |
|---|---|
| `owner fund --cents 100 --providers 0[,1] [--prices 5,3] [--token-file F]` | Calls `ownerFund` with `SolanaDepositor` from `OWNER_KEYPAIR`. Prints quote id, deposit tx, final balance |
| `owner balance [--token-file F]` | `ownerBalance`: spendable, pending, count by denomination |
| `owner providers` | Lists `GET /v1/blindfold/providers` |
| `owner resume <quote-pubkey>` | Resumes a `FundState` |

Exit nonzero on any error with a one-line message.

## 6. File layout

```
packages/wallet/
  package.json            type: module, bin: { owner: dist/cli.js }, deps in section 2
  tsconfig.json
  src/index.ts            re-exports
  src/agent-wallet.ts     AgentWallet, payFetch
  src/select.ts           selectExact
  src/store.ts            TokenStore, FileTokenStore, lock file, atomic write
  src/errors.ts           PaymentRefused, PaymentFailed, TokenFileError
  src/checkstate.ts       Y computation, recovery
  src/mutex.ts
  src/owner.ts            ownerFund, ownerBalance, FundState
  src/denominations.ts    planDenominations
  src/depositor.ts        Depositor, SolanaDepositor
  src/dleq.ts             DLEQ wrapper
  src/cli.ts
  src/tool.ts             payFetchTool (thin LLM export)
  test/                   section 8
  test/fakes/fake-mint.ts, fake-provider.ts, fake-depositor.ts
```

## 7. Stubs (build and test before mint or vault exist)

| Fake | Implements | Notes |
|---|---|---|
| `FakeMint` (in-process `http.createServer` on port 0) | `GET /v1/info`, `/v1/keysets`, `/v1/keys`, `POST /v1/mint/quote/solana-usdc`, `GET .../{quote}`, `POST /v1/mint/solana-usdc`, `POST /v1/checkstate`, `GET /v1/blindfold/providers` | Keys from `createNewMintKeys(13, seed, { unit: 'usd' })` (amounts 1..4096). Signing: `createBlindSignature(B_, privateKeys[amount], id)` with DLEQ included. Verifies NUT-20 sig with `schnorr.verify` over the signMintQuote message. `amount_paid` set by the test via `fakeMint.markPaid(quote, cents)`. Spent set test-controlled: `fakeMint.spend(secret)`; checkstate reads it |
| `FakeProvider` | A 402 server | Takes a provider keypair, price, mint URL. Emits `X-Cashu` built with protocol `buildPaymentRequest`. On retry: decode token, check exact sum, signer set contains its key, then 200. Modes to force failures: `reject400`, `drop200` (marks proofs spent in FakeMint, returns 502), `hostile` (returns `d` = attacker key or amount 10000) |
| `FakeDepositor` | `Depositor` | Records the call, returns a fake signature, then calls `fakeMint.markPaid(quote, cents)` for the quote whose `request` equals `depositRef` |

Owner flow tests use FakeMint plus FakeDepositor, so no Solana is needed. A separate opt-in test (`SOLANA_TEST=1`) runs `SolanaDepositor` against `solana-test-validator` once the vault exists.

## 8. Done when

All with vitest, no network.

| # | Test |
|---|---|
| 1 | `selectExact`: given proofs `[4,1,1,2,8]` target 5 returns `4+1`; shuffled input gives identical output; target 7 with `[4,4]` gives `insufficient_exact`; total below target gives `insufficient_balance`; proofs locked to other keys give `provider_not_in_signer_set` |
| 2 | `planDenominations(100, [5])`: sums to 100, all powers of two, contains 16 copies of `{4,1}`. `(100,[5,3])` and `(1,[5])` also sum correctly. Property test: for random price in 1..10 and 100 cents, `selectExact` succeeds for the first `n` payments in a row |
| 3 | Store: write is atomic (kill-before-rename leaves the old file intact), mode 0600, extra fields preserved, version or unit mismatch throws, second `open()` on a held lock throws |
| 4 | Happy path: owner flow against FakeMint+FakeDepositor writes a file whose proofs all pass `verifyMintSignatures`, have the sorted allowlist signer set, sum to 100. Then `payFetch` to FakeProvider (price 5) returns 200, balance is 95, `pending` is empty |
| 5 | Refusals, each asserts the exact `reason` and that **no** paid retry reached the server and the file is unchanged: wrong unit, mint not in `m`, amount 11 over cap 10, provider key not in allowlist, provider key in allowlist but not in proof signer set, `creqB` variant parses and pays |
| 6 | Hostile provider (`hostile` mode asking for an attacker key): `provider_not_allowed`; balance unchanged |
| 7 | Failure recovery: FakeProvider `reject400` returns 400, proofs unspent in FakeMint, so they return to `proofs`, `PaymentFailed.recovered = {returned: n, dropped: 0}`. `drop200`: proofs spent, so dropped, balance falls by 5 |
| 8 | Crash recovery: write a file with a `pending` entry, mark half the Ys spent in FakeMint, `open()` returns the unspent to `proofs` and drops the rest |
| 9 | Concurrency: 10 parallel `payFetch` calls against a provider; no proof is sent twice, each success is exactly 5, final balance is consistent |
| 10 | Owner errors: lost mint response then identical resend returns the stored signatures; plan over 256 outputs is chunked; bad DLEQ (FakeMint corrupts one) aborts without writing the file; empty or inactive provider list refuses; resume from a state saved after deposit does not deposit twice |
| 11 | CLI smoke: `owner fund` and `owner balance` against FakeMint print expected values (depositor injected through an env flag used by tests only) |

## 9. Open questions

| # | Question | Proposed answer |
|---|---|---|
| Q1 | 00 §5.3 quote `amount` is the target; `amount_paid` may differ. If an owner overpays, mint only what was planned | Wallet mints `min(cents, amount_paid - amount_issued)` and re-plans the split to that amount |
