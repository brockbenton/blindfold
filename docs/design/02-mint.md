# 02: Mint server

Cashu mint for method `solana-usdc`: issues blind-signed `usd` proofs against vault deposits, redeems P2PK-locked proofs for registered providers, and settles provider balances to the vault. Lives in `services/mint/`. Contract: `00-interfaces.md` (cited as "00 §n"). This doc adds implementation detail only.

## 1. Depends on / used by

| Direction | What | Ref |
|---|---|---|
| Implements | NUT-01/02/06/07 endpoints | 00 §5.1 |
| Implements | Quote, mint, providers, redeem, admin | 00 §5.3 to §5.7 |
| Implements | Deposit polling | 00 §6 |
| Calls | `Config`, `DepositRecord`, `ProviderRecord` account reads | 00 §4.1 |
| Calls | `settle_batch` instruction | 00 §4.3 |
| Imports | `packages/protocol`: `constants`, `types`, `lock.signerSet`, `units`, `vault`, `env` | 00 §8 |
| Used by | Owner CLI / wallet SDK (quote, mint, providers), provider's x402 facilitator inside the mock API (redeem, during settle), agent (checkstate), `scripts/e2e.ts` (admin) | 00 §1 |
| Config | `DATABASE_URL`, `MINT_SEED`, `MINT_AUTHORITY_KEYPAIR`, `MINT_ADMIN_TOKEN`, `PORT`, `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID`, `USDC_MINT`, `MINT_URL`, `config/providers.json` | 00 §9 |

## 2. MVP scope

- One active keyset (`usd`, amounts 1..4096, fee 0) derived from `MINT_SEED`. Only the active keyset signs; redeem accepts any known `usd` keyset.
- NUT-04/20 quotes for `solana-usdc`; blind signing with DLEQ.
- Deposit poller, provider registry sync, redeem, per-provider unsettled balances.
- Settlement loop every `SETTLE_INTERVAL_S` plus admin trigger.
- Admin balances, settle, reconcile.

## 3. Out of scope

- QuickNode webhook / Stream trigger
- Temporal or any job engine
- Issuance log onchain
- Swap (NUT-03), melt (NUT-05)
- Refunds of unmatched or overpaid deposits
- Keyset rotation
- Hidden revenue (private provider income)

## 4. Design

### 4.1 Libraries

| Need | Choice |
|---|---|
| Cashu | `@cashu/cashu-ts` 4.13.1 (ESM only, wallet lib with mint-side helpers; no x402 helper needed here) |
| Solana | `@solana/web3.js` 1.x with `@anchor-lang/core` 1.2.2 (Anchor's `Program` and `Connection` types are web3.js 1.x; `@solana/kit` does not plug into it) |
| Postgres | `pg` with plain SQL |

cashu-ts functions used (all exported from `@cashu/cashu-ts`):

| Purpose | Function and signature |
|---|---|
| Keyset | `createNewMintKeys(13, seed: Uint8Array, {unit: 'usd', input_fee_ppk: 0}) -> {keysetId, pubKeys, privKeys}` (`RawMintKeys = {[amount: string]: Uint8Array}`). Deterministic from `seed` (BIP32 child per power of 2), so restarts reproduce the same keyset |
| Keys JSON | `serializeMintKeys(pubKeys) -> {[amount]: hex}` for `GET /v1/keys`; `deriveKeysetId(keys, opts)` only to assert the ID |
| Blind sign | `pointFromHex(B_)`; `createBlindSignature(B_: point, privateKey: Uint8Array, id) -> {C_: point, id}` (no `amount`, no `dleq`; add both) |
| DLEQ | `createDLEQProof(B_: point, a: Uint8Array) -> {s: Uint8Array, e: Uint8Array, r?}`; send `{s, e}` as hex, never `r` |
| NUT-20 | `verifyMintQuoteSignature(pubkey, quote, blindedMessages: SerializedBlindedMessage[], signature) -> boolean` |
| Y | `hashToCurve(new TextEncoder().encode(secret)).toHex(true)` |
| C check | `verifyUnblindedSignature({C: pointFromHex(C), secret: utf8(secret), id}, privKeys[amount]) -> boolean` |
| P2PK parse | `parseP2PKSecret(secret) -> Secret` (throws on malformed), `getP2PKSigFlag(secret)` |
| P2PK verify | `verifyP2PKSpendingConditions(proof, logger?, message?) -> P2PKVerificationResult` (`success`, `path: MAIN|REFUND|UNLOCKED|FAILED`, `lockState`, `locktime`, `main`, `refund`) |
| Signer | `getP2PKWitnessSignatures(proof.witness) -> string[]`; `getValidSigners(signatures, message = secret, pubkeys) -> string[]` (pubkeys that have a valid sig) |
| Lock set | `signerSet(secret)` from `packages/protocol` |

`createBlindSignature` and `createDLEQProof` are non-constant-time (library warning). Acceptable for the hackathon; note it in the README. A production mint would use a constant-time secp256k1 signer.

Amounts are integer cents; use JS `number` in code (max sum is small) and Postgres `bigint` in storage.

### 4.2 Schema (`migrations/001_init.sql`)

All timestamps `timestamptz default now()` unless stated. Money columns are cents (`bigint`) unless named `*_base`.

| Table | Columns | Constraints |
|---|---|---|
| `keysets` | `id text pk`, `unit text`, `active bool`, `input_fee_ppk int`, `pubkeys jsonb`, `created_at` | Private keys are NOT stored; re-derived from `MINT_SEED` at boot, boot fails if derived ID differs from stored active ID |
| `mint_quotes` | `id uuid pk` (v7), `deposit_ref text` (64 hex), `unit text`, `amount bigint`, `pubkey text`, `expiry bigint` (unix s), `amount_paid bigint default 0`, `amount_issued bigint default 0`, `created_at`, `updated_at` | `unique(deposit_ref)`, `check(amount_issued <= amount_paid)`, `check(amount between 1 and 5000)` |
| `deposits` | `index bigint pk`, `depositor text`, `amount_base bigint`, `amount_cents bigint`, `deposit_ref text`, `slot bigint`, `block_time bigint`, `quote_id uuid null fk`, `created_at` | `pk(index)`; index on `deposit_ref`; `quote_id null` means unmatched |
| `deposit_cursor` | `id int pk check(id=1)`, `next_index bigint default 0` | Single row |
| `issued_signatures` | `B_ text pk`, `quote_id uuid fk`, `request_id uuid` (one per successful mint request, for replay), `keyset_id text`, `amount int`, `C_ text`, `dleq_s text`, `dleq_e text`, `created_at` | `B_` primary key is the uniqueness rule (11003). Index on `(quote_id)` |
| `spent_proofs` | `Y text pk`, `amount int`, `keyset_id text`, `redemption_id uuid fk`, `created_at` | `Y` primary key (11001) |
| `providers` | `provider_id int pk`, `pubkey text`, `payout_token text`, `active bool`, `name text null`, `url text null`, `price_cents int null`, `topics jsonb default '[]'`, `synced_at` | `unique(pubkey)`. Cache of `ProviderRecord` accounts plus `config/providers.json` |
| `provider_balances` | `provider_id int pk fk`, `balance bigint default 0` | `check(balance >= 0)`. Unsettled cents |
| `redemptions` | `id uuid pk`, `provider_id int fk`, `amount bigint`, `proof_count int`, `created_at` | |
| `settlements` | `id bigserial pk`, `batch_id bigint`, `status text check in ('pending','submitted','confirmed','failed')`, `payouts jsonb` (`[{provider_id, amount_cents, amount_base}]`), `tx_sig text null`, `error text null`, `created_at`, `updated_at` | Partial unique index `(batch_id) where status <> 'failed'` |

`reconcile` totals: `deposited = sum(deposits.amount_cents)`, `issued = sum(issued_signatures.amount)`, `redeemed = sum(redemptions.amount)`, `settled = sum(amount_cents)` over `confirmed` settlements, `vault_balance` from the vault token account at `confirmed` divided by 10_000.

### 4.3 Boot sequence

1. Run migrations. Read env via `packages/protocol` `env`.
2. Derive keyset with `createNewMintKeys`. Insert into `keysets` if missing (active). Keep `privKeys` in memory only.
3. Registry sync once (4.6), then start deposit poller, registry sync timer (30 s), settlement loop.
4. Start HTTP server.

### 4.4 Endpoints

| Endpoint | Logic |
|---|---|
| `GET /v1/info` | Static NUT-06 body from 00 §5.1 |
| `GET /v1/keys[/{id}]`, `/v1/keysets` | From `keysets` rows; keys via `serializeMintKeys`. `/v1/keysets` lists all rows including inactive ones (`active` flag per row) |
| `POST /v1/checkstate` | `select Y from spent_proofs where Y = any($1)`; others `UNSPENT`; `witness: null` |
| `POST /v1/mint/quote/solana-usdc` | Validate unit (`11013`), amount (`11006`), `pubkey` is 66 hex starting `02`/`03` (`20009`). `deposit_ref = randomBytes(32).hex`, `id = uuidv7()`, `expiry = now + QUOTE_EXPIRY_S`. Response adds `vault_program`, `usdc_mint`, `amount_base_units = centsToBaseUnits(amount)` as string |
| `GET /v1/mint/quote/solana-usdc/{id}` | Same shape from the row. Unknown id: HTTP 404 `{detail, code: 20001}` |
| `POST /v1/mint/solana-usdc` | See 4.5 |
| `GET /v1/blindfold/providers` | `select * from providers order by provider_id`; `name`/`url`/`price_cents` are `null` and `topics` is `[]` when `config/providers.json` has no entry; inactive providers are returned with `active: false` |
| `POST /v1/blindfold/redeem` | See 4.7 |
| `GET /v1/blindfold/reserves` | Public, no auth (00 §5.5a). One read transaction (`repeatable read`, read only): `issued = sum(issued_signatures.amount)`, `settled = sum(amount_cents)` over `confirmed` settlements, `outstanding = issued - settled`. Returns `{issued, settled, outstanding, keyset_id, updated_at}` (cents; `keyset_id` is the active keyset, `updated_at` is unix s at read time). Trust limit: `issued` is mint-reported until the issuance-log add-on puts it onchain, so the agent's check catches a drained or underfunded vault but not a mint that under-reports issuance |
| `/v1/blindfold/admin/*` | Bearer check with constant-time compare. `settle` runs 4.8 once. `balances` lists rows with `balance > 0` |

Error helper: `throw new MintError(code, detail, status = 400)` returns `{detail, code}`; only the unknown-quote GET passes 404. Body validation failures (zod) use code `10000`.

### 4.5 Mint (blind signing)

1. Validate body shape; `1 <= outputs.length <= 256` else `11015`; reject duplicate `B_` in `outputs` (`11008`).
2. One transaction: `select * from mint_quotes where id=$1 for update`. Missing or `amount_paid = 0`: `20001`.
3. Verify NUT-20: `verifyMintQuoteSignature(quote.pubkey, quote.id, outputs, signature)` else `20008`. `outputs` here is the request array as sent.
3a. **Replay lookup:** `select * from issued_signatures where B_ = any($outputs)` (any quote). If no rows, continue. If there are rows, they must all have this `quote_id` and one single `request_id`, that request must have exactly `outputs.length` rows, and the count of found rows must equal `outputs.length`; then return the stored signatures (rebuilt from `C_`, `dleq_s`, `dleq_e`, in request order) with `200` and change nothing. Any other overlap is `11003`. This runs before the amount check, since a fully issued quote has `mintable = 0`.
4. `mintable = amount_paid - amount_issued`. If `mintable = 0`: `20002`. If `sum(outputs.amount) > mintable`: `11006`.
5. For each output: keyset must be the active one (`12001`), amount must be a key (`12002`), `B_` must be a valid point (`pointFromHex`, else `10000`).
6. For each output: `createBlindSignature(pointFromHex(B_), privKeys[amount], id)`, then `createDLEQProof(B_point, privKeys[amount])`. Build `{amount, id, C_: C_.toHex(true), dleq: {s: hex, e: hex}}`.
7. `insert into issued_signatures` for all, with a fresh `request_id`. A `unique_violation` on `B_` maps to `11003` and rolls back everything. `update mint_quotes set amount_issued = amount_issued + sum`. Commit, then respond.

The row lock on the quote serializes concurrent mints for one quote, so over-issuing is impossible.

### 4.6 Deposit poller and provider sync

Poller (`setInterval` guarded by a `running` flag so ticks never overlap), every `DEPOSIT_POLL_MS`:

1. `connection.getAccountInfo(configPda, 'confirmed')`, decode `Config`; `n = deposit_count`.
2. `cursor = select next_index from deposit_cursor`. For `i` in `cursor..n-1`: `getAccountInfo(depositPda(i), 'confirmed')`. If null, stop and retry next tick (RPC lag). Require `account.owner == VAULT_PROGRAM_ID`, else log and stop (never skip silently).
3. Transaction per record: `select ... from deposit_cursor for update`; `insert into deposits ... on conflict (index) do nothing`; match `mint_quotes where deposit_ref = hex(record.deposit_ref) for update`; if found, `amount_paid += amount_base / 10_000` (use `baseUnitsToCents`), `updated_at = now()`, set `deposits.quote_id`; `next_index = i + 1`.
4. Batch the fetches with `getMultipleAccountsInfo` (chunks of 50) when catching up.

Cursor advance and credit are in one transaction, so a crash replays at most the last record, which `on conflict do nothing` makes a no-op (skip the credit when the insert affected 0 rows).

Provider sync (every 30 s and at boot): read `provider_count` from `Config`, fetch `ProviderRecord` for ids `0..count-1`, upsert `providers` (`pubkey` hex of `cashu_pubkey`, `payout_token`, `active`), so a provider the admin deactivated onchain shows `active = false` after the next sync. Left-join `name`, `url`, `price_cents`, `topics` from `config/providers.json` (`[{"provider_id": 0, "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5, "topics": ["sol", "btc", "eth"]}]`, loaded at boot by the config loader; missing entries give nulls and `topics: []`; a missing `topics` field in an entry is also `[]`). Insert a `provider_balances` row for every new provider. Redeem reads the DB cache only; a provider registered seconds ago is usable after the next sync. `POST /admin/settle` forces a sync first.

### 4.7 Redeem algorithm

Input `proofs` in the 00 §3.4 wire form: `amount` a number, `witness` a JSON string. Normalize on input: also accept `amount` as a numeric string and `witness` as an object (cashu-ts v4 shapes). Steps map to 00 §5.6. The caller is the provider's x402 facilitator (00 §7.3) during settle; the mint API is unchanged and knows nothing about x402.

```
1. n in 1..64 else 11014; Set(secret).size == n else 11007
2. for each proof: keyset = keysets[proof.id] else 12001; keyset.unit == 'usd' else 12001; amount must be in keyset
3. verifyUnblindedSignature({C: pointFromHex(p.C), secret: utf8(p.secret), id: p.id}, privKeys[p.amount]) else 10001
4. try { s = parseP2PKSecret(p.secret) } catch -> 70001
   require s kind P2PK; getP2PKSigFlag(p.secret) === 'SIG_INPUTS'; tags only from {pubkeys, n_sigs, sigflag}, so any 'locktime' or 'refund' tag is rejected; n_sigs absent or 1; else 70001
   r = verifyP2PKSpendingConditions(p); require r.success && r.path === 'MAIN' else 10001
5. sigs = getP2PKWitnessSignatures(p.witness); set = signerSet(p.secret)
   valid = getValidSigners(sigs, p.secret, set); require valid.length === 1 else 10001
6. provider = select from providers where pubkey = valid[0] and active else 70002   -- inactive (deactivated) providers are rejected here
7. all proofs yield the same provider_id else 70003
8. BEGIN
     insert into redemptions (id, provider_id, amount, proof_count)
     insert into spent_proofs (Y, amount, keyset_id, redemption_id) for every proof   -- unique_violation -> ROLLBACK, 11001
     insert into provider_balances ... on conflict (provider_id) do update set balance = balance + $sum
   COMMIT; respond {provider_id, amount: sum, redemption_id}
```

Notes:
- The signature message is the `secret` string as UTF-8. `getValidSigners` takes it as `message`.
- Witness parse failure or missing signatures yields `10001`.
- Steps 1 to 7 hold no locks. Step 8 relies on the `Y` primary key: two concurrent redeems of the same proof both reach insert, one fails, the whole transaction aborts, so the balance is credited once. Use one multi-row `insert` per request.
- Y is `hashToCurve(utf8(secret)).toHex(true)`.
- `sigflag` absent defaults to `SIG_INPUTS` in NUT-11, so accept absence.

### 4.8 Settlement state machine

```
create:  pending --(tx sent)--> submitted --(confirmed)--> confirmed
              \                      \--(chain check says not landed, or tx error)--> failed (balances restored)
```

`runSettlement()` holds a Postgres advisory lock (`pg_try_advisory_lock(42)`) on a dedicated connection, so one run at a time, including the admin trigger. Steps:

1. **Recover first.** Load any settlement in `pending` or `submitted`. Call `recover(s)` (below) and finish; only then create a new batch.
2. **Create batch** in one transaction: `select provider_id, balance from provider_balances where balance > 0 order by balance desc, provider_id limit 8 for update`, joined to `providers` where `active`. If none, return `{batch_id: null}`. `chain = Config.last_batch_id` (read at `confirmed`); `batch_id = chain + 1`. For each row set `balance = 0` (full debit, balance is exactly the amount captured under the row lock, so later redeems add on top safely). Insert `settlements(status='pending', batch_id, payouts)`. Commit. Balances are debited here, not on confirmation, so a redeem during settlement is never double paid.
3. **Submit:** build `settle_batch(batch_id, payouts)` via the `vault` instruction builder; `amount_base = cents * 10_000`; remaining accounts in pairs `[providerPda(id), payout_token]` in payout order; sign with the mint authority keypair. `sendRawTransaction` (`skipPreflight: false`), store `tx_sig`, set `submitted`.
4. **Confirm:** `confirmTransaction(sig, 'confirmed')`. On success set `confirmed`.
5. **recover(s)** for a `pending` or `submitted` row after a crash or error:
   - `chain = Config.last_batch_id`. If `chain >= s.batch_id`: the batch landed. Set `confirmed` (keep `tx_sig` if known). Do NOT resend.
   - Else if `submitted` and the blockhash of the stored tx has not expired (`isBlockhashValid`): wait and re-check next tick.
   - Else (never sent, or expired and not landed): resend once with a fresh blockhash if the batch is still `chain + 1`; an error with `BadBatchId` means another path landed it, so re-read the chain and apply the first rule. A deterministic program error (`ProviderInactive`, `PayoutAccountMismatch`, others) sets `failed`, records `error`, and re-credits each payout to `provider_balances` in one transaction. `failed` frees `batch_id` (partial unique index), so the next batch reuses `chain + 1`.

Edge: deactivation (00 §4.5). If a provider is no longer `active` in the cache, step 2 skips it and its balance stays unsettled (visible in `balances`), since the program would return `ProviderInactive`. The admin should settle before deactivating (`POST /admin/settle`, repeated until the provider's balance is 0); otherwise the remaining balance is excluded from batches and forfeited unless the provider is re-registered (MVP: admin's call). The mint credits no new redemptions to it (check 6).

Admin settle response: `{batch_id, payouts: [{provider_id, amount}], tx}` with `amount` in cents. When more than 8 providers have balances, one call settles the 8 largest; the rest wait for the next run (the loop or another admin call).

### 4.9 Concurrency summary

| Hazard | Control |
|---|---|
| Two mints on one quote | `for update` on the quote row |
| Same `B_` signed twice | `issued_signatures.B_` pk |
| Same proof redeemed twice | `spent_proofs.Y` pk inside one transaction |
| Deposit counted twice | `deposits.index` pk plus cursor update in same transaction |
| Redeem during settlement | Settlement debits under `for update` on balance rows; redeem upserts add to the new balance |
| Two settlement runs | Advisory lock; partial unique index on `batch_id` |
| Poller overlap | `running` flag plus cursor row lock |

### 4.10 Error codes used

`10000` malformed or invalid point, `10001` invalid proof or signature, `11001` spent, `11003` output already signed, `11006` amount, `11007` duplicate inputs, `11008` duplicate outputs, `11013` unit, `11014` too many inputs, `12001` keyset unknown, `12002` amount not in keyset, `11015` too many outputs, `20001` unpaid or unknown quote (404 on GET), `20002` nothing mintable, `20008` NUT-20 signature, `20009` pubkey required, `70001` bad lock, `70002` signer not an active provider, `70003` mixed providers. Admin `401` has no Cashu body.

## 5. File layout

```
services/mint/
  package.json            ESM, scripts: dev, build, test, migrate
  tsconfig.json
  migrations/001_init.sql
  src/
    index.ts              boot (4.3)
    config.ts             env + providers.json
    db.ts                 pg Pool, tx() helper, migrate runner
    app.ts                Hono app, routes, error handler
    errors.ts             MintError + code enum from protocol
    crypto/keyset.ts      createNewMintKeys, privKeys holder
    crypto/blind.ts       sign + DLEQ
    crypto/p2pk.ts        verifyLockedProof(proof) -> {providerPubkey}
    routes/{info,keys,quote,mint,providers,reserves,redeem,checkstate,admin}.ts
    chain/vaultReader.ts  interface VaultReader + SolanaVaultReader
    chain/settleSender.ts interface SettleSender + SolanaSettleSender
    jobs/depositPoller.ts
    jobs/providerSync.ts
    jobs/settlement.ts
  test/                   vitest
    fakes/{memoryVault.ts,fakeSender.ts,testWallet.ts}
```

Choices: Hono (tiny, typed, fast to write, `app.request()` lets tests call routes without a socket; `@hono/node-server` to run). Migrations: plain numbered SQL files plus a 30-line runner in `db.ts` that records applied names in `schema_migrations`; no ORM, raw `pg` queries keep the `for update` logic explicit. Test runner: vitest.

## 6. Stubs

Build everything against two interfaces so the mint runs with no chain and no vault program.

```ts
interface VaultReader {
  getConfig(): Promise<{ depositCount: bigint; providerCount: number; lastBatchId: bigint }>;
  getDeposit(index: bigint): Promise<DepositRecord | null>;
  getProvider(id: number): Promise<ProviderRecord | null>;
  getVaultBalanceBase(): Promise<bigint>;
}
interface SettleSender {
  settleBatch(batchId: bigint, payouts: {providerId: number; payoutToken: string; amountBase: bigint}[]): Promise<string>; // returns tx sig
}
```

| Stub | Behavior |
|---|---|
| `MemoryVault` (implements `VaultReader`) | Arrays for deposits and providers; `addDeposit({amountBase, depositRef})`, `addProvider({cashuPubkey, payoutToken})`, `setActive`. Exposes `lastBatchId` |
| `FakeSender` (implements `SettleSender`) | Mimics the program: rejects unless `batchId == vault.lastBatchId + 1` (throws `BadBatchId`), then moves balance and bumps `lastBatchId`. Knobs: `failNext('send' \| 'afterLand')` (throw after landing, to test recover), `neverLand()` |
| `testWallet.ts` | Uses cashu-ts only on the client side: `blindMessage(secret, r, keysetPubkey)` style helpers or `OutputData.createP2PKData` to build locked outputs; `signMintQuote(privkey, quote, outputs)` for NUT-20; `constructUnblindedSignature`/`unblindSignature` to get proofs; `signP2PKProofs(proofs, providerPrivKey)` for the witness |
| Postgres | `docker-compose.yml` service `postgres:16`, `DATABASE_URL=postgres://blindfold:blindfold@localhost:5432/mint_test`; tests create a schema per file and run migrations |

Full redeem path with local keys (no vault program needed):

1. Generate provider key `sk = randomBytes(32)`, `pk = getPubKeyFromPrivKey(sk)`. `memoryVault.addProvider({cashuPubkey: pk, payoutToken: <fake base58>})`; run provider sync.
2. `POST /quote` with a fresh quote key; `memoryVault.addDeposit({amountBase: 1_000_000n, depositRef: quote.request})`; run one poller tick; GET quote shows `amount_paid = 100`.
3. Build outputs for 100 cents locked with `buildLockOptions([pk])` (or two keys for the 1-of-N case); NUT-20 sign; `POST /mint`; unblind.
4. Take proofs, `signP2PKProofs(proofs, sk)`, `POST /redeem`; expect balance 100; replay expects `11001`.
5. `POST /admin/settle` with `FakeSender`; assert `settlements.status = 'confirmed'`, balance 0, `reconcile` identity holds.

When the real vault exists, swap in `SolanaVaultReader` and `SolanaSettleSender` (from `packages/protocol` `vault`) and run the same tests against `solana-test-validator`.

## 7. Done when

| # | Test |
|---|---|
| 1 | Boot twice with same `MINT_SEED`: same keyset ID; `GET /v1/keys` has 13 keys (1..4096) |
| 2 | Quote: unknown quote on GET `404`/`20001`; bad unit `11013`, amount 0 and 5001 `11006`, no pubkey `20009`; `deposit_ref` unique |
| 3 | Poller: 3 deposits credit the right quotes; two deposits to one ref sum; unmatched stored with `quote_id null`; restart does not double credit (kill after insert before cursor) |
| 4 | Mint: unpaid or unknown quote `20001`, 257 outputs `11015`, bad NUT-20 sig `20008`, over amount `11006`, drained `20002`, duplicate `B_` in request `11008`, reused `B_` from another quote or partial overlap `11003`, identical resend of a completed request returns the stored signatures `200` with nothing changed, wrong keyset `12001`, paid after quote expiry succeeds |
| 5 | Mint concurrency: 10 parallel mints on one quote never issue more than `amount_paid` |
| 6 | Every `BlindSignature` carries `dleq`; `verifyDLEQProof` on the client side passes; unblinded proof passes `verifyUnblindedSignature` |
| 7 | Redeem happy path, N=1 and N=3 allowlist (each signer key credits its own provider) |
| 8 | Redeem rejects: forged `C` `10001`; non-P2PK secret `70001`; `SIG_ALL` `70001`; `locktime` or `refund` present `70001`; amount as numeric string and object witness accepted; no witness `10001`; two valid signers `10001`; unregistered or inactive key `70002` (deactivate onchain, sync, redeem rejects); two providers in one request `70003`; duplicate secret `11007`; 65 proofs `11014` |
| 9 | Double spend: same proof in two parallel redeems, exactly one succeeds, balance credited once; a request with one spent and one fresh proof leaves the fresh one unspent |
| 10 | `checkstate` returns `SPENT` after redeem, `UNSPENT` before |
| 11 | Settlement: balances debited at `pending`; payout `amount_base = cents * 10_000`; empty returns `{batch_id: null}`; admin 401 without token |
| 12 | Settlement recovery: crash after submit and landed (`FakeSender.failNext('afterLand')`) ends `confirmed` with no second send; send failure with `BadBatchId` re-reads chain; deterministic failure restores balances and next batch reuses the same `batch_id`; redeem during `submitted` is not lost |
| 13a | Deactivated provider: sync sets `active = false`, `GET /providers` lists it with `active: false`, its balance is skipped by settlement and stays visible in `balances`; providers.json entry without `topics` serves `topics: []` |
| 13 | More than 8 providers with balances: first call pays the 8 largest, second call pays the rest |
| 14 | `reconcile`: `vault_balance == deposited - settled` after the flow in section 6 |
| 14a | `GET /v1/blindfold/reserves`: unauthenticated `200`; after mint 100 and a redeem of 40 settled in full, `{issued: 100, settled: 40, outstanding: 60}`; a `pending` or `failed` settlement is not counted as settled; values come from one transaction (concurrent mint during the read does not make `outstanding` inconsistent) |
| 15 | Against `solana-test-validator` with the real vault: deposit, mint, redeem, settle end to end |

## 8. Open questions

| # | Issue | Proposed fix |
|---|---|---|
| 1 | Deposits at `confirmed` can in theory be rolled back after crediting a quote | Accept for the demo (00 §2 already says so); production polls `finalized` |
