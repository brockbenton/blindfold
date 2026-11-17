# 00: Interfaces

The MVP interface reference. Keep this file, component docs, implementation and tests in sync when changing an interface. Planned features are called out explicitly.

Where a Cashu NUT or the [x402 v2 spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) already defines something, we use it unchanged and link it. Blindfold-specific choices are marked **[BF]**.

Payments travel over **x402 v2** with a custom scheme, `blindfold`: the Cashu token rides inside x402's standard payment envelope. A feasibility spike (real `@x402/hono` server, real `@x402/fetch` client, real `cashu-ts` crypto) passed all checks; see `spikes/x402-cashu/`.

## 1. Overview

```
Owner CLI ──deposit(amount, deposit_ref)──▶ Vault program (Solana devnet)
    │                                            ▲   │ DepositRecord accounts
    │ NUT-04/20 quote + mint (blinded)           │   ▼ (polled)
    └──────────────────────────────▶ Mint ◀──────┘  settle_batch
                                      ▲  ▲
         cashuB token file            │  │ POST /v1/blindfold/redeem
Owner ───────────────▶ Agent ─ Wallet SDK ─x402 v2, scheme cashu─▶ Mock API
```

| Step | From → To | Interface |
|---|---|---|
| 1. Quote | Owner (wallet SDK) → Mint | `POST /v1/mint/quote/solana-usdc` (§5.3) |
| 2. Deposit | Owner → Vault | `deposit` instruction (§4.3) |
| 3. Detect | Mint → Vault | Poll `Config.deposit_count` + `DepositRecord` (§6) |
| 4. Issue | Owner → Mint | `POST /v1/mint/solana-usdc` with locked blinded outputs (§5.4, §3.3) |
| 5. Hand over | Owner → Agent | `cashuB` token file (§3.4) |
| 6. Pay | Agent (wallet SDK) → Mock API | x402 v2 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`, scheme `blindfold` (§7) |
| 7. Redeem | Mock API (x402 settle) → Mint | `POST /v1/blindfold/redeem` (§5.6) |
| 8. Settle | Mint → Vault | `settle_batch` instruction (§4.3) |

## 2. Constants and conventions

| Name | Value | Notes |
|---|---|---|
| Cashu unit | `usd` | Amounts are **integer cents** everywhere offchain |
| USDC decimals | 6 | |
| `BASE_UNITS_PER_CENT` | `10_000` | Conversion happens only at the vault boundary |
| Keyset amounts | `1, 2, 4, ... 4096` (2^0 to 2^12) | One active keyset, `input_fee_ppk = 0` |
| `MAX_DEPOSIT_CENTS` | `5000` ($50) | Default per-deposit cap; vault uses configured `max_deposit`, quotes enforce 5000 cents |
| `QUOTE_EXPIRY_S` | `3600` | Payment deadline only (NUT-04) |
| `DEPOSIT_POLL_MS` | `2000` | |
| `SETTLE_INTERVAL_S` | `600` | Settlement window; runs fire at UTC multiples of it |
| `SETTLE_HOLD_S` | `SETTLE_INTERVAL_S` | Cents redeemed more recently are not paid in a run |
| `SETTLE_UNIT_CENTS` | `10` | Payouts round down to a multiple; the remainder carries over |
| `MAX_PAYOUTS_PER_BATCH` | `8` | Keeps `settle_batch` under the tx size limit |
| Solana commitment | `confirmed` | Demo only; real deployment would use `finalized` |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle devnet USDC, classic SPL Token program. Configurable via `USDC_MINT` |
| Mint URL | `http://localhost:3338` | Configurable via `MINT_URL` |
| x402 version | `2` | |
| x402 scheme | `blindfold` | **[BF]** custom scheme |
| x402 network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | CAIP-2 id for Solana devnet (`SOLANA_DEVNET_CAIP2` in `@x402/svm`) |
| x402 packages | `@x402/core`, `@x402/hono`, `@x402/fetch` `2.31.x` | Versions the spike used |

Keys:

| Key | Curve | Held by | Used for |
|---|---|---|---|
| Admin keypair | ed25519 | Team | `initialize`, `register_provider` |
| Mint authority keypair | ed25519 | Mint server | Signing `settle_batch` |
| Mint keyset private keys | secp256k1 | Mint server | Blind signatures, derived from `MINT_SEED` |
| Owner keypair | ed25519 | Owner | Paying the deposit |
| Quote key (per quote) | secp256k1 | Owner | NUT-20 quote lock. Fresh per quote |
| Provider Cashu key | secp256k1 | Provider | P2PK lock target; signs proofs at redemption |
| Provider payout account | SPL token account | Provider | Receives USDC from `settle_batch` |

Hex encodings are lowercase. secp256k1 public keys are 33-byte compressed (66 hex chars).

## 3. Token and proof formats

### 3.1 Proofs, blinded messages, signatures

Exactly as [NUT-00](https://cashubtc.github.io/nuts/00). `Proof = {amount, id, secret, C, witness?, dleq?}`. `BlindedMessage = {amount, id, B_}`. `BlindSignature = {amount, id, C_, dleq?}`. The mint includes a [NUT-12](https://cashubtc.github.io/nuts/12) DLEQ proof in every `BlindSignature`.

`Y = hash_to_curve(secret)` (hex, compressed) identifies a proof in the spent set and in [NUT-07](https://cashubtc.github.io/nuts/07).

### 3.2 Keysets

[NUT-01](https://cashubtc.github.io/nuts/01) and [NUT-02](https://cashubtc.github.io/nuts/02) unchanged. Keyset ID derived with `cashu-ts` `deriveKeysetId`.

### 3.3 Blindfold lock (P2PK, NUT-10/11)

Every token the owner issues is locked with a [NUT-11](https://cashubtc.github.io/nuts/11) P2PK secret, **1-of-N** over the **global allowlist**: the Cashu keys of every active registered provider, as returned by `GET /v1/blindfold/providers` (§5.5):

```json
["P2PK", {
  "nonce": "<32 random bytes hex>",
  "data": "<allowlist[0] pubkey>",
  "tags": [
    ["pubkeys", "<allowlist[1]>", "...", "<allowlist[N-1]>"],
    ["n_sigs", "1"],
    ["sigflag", "SIG_INPUTS"]
  ]
}]
```

| Rule | Value |
|---|---|
| Signer set | `data` plus every `pubkeys` entry |
| `n_sigs` | Always `1` (omit `pubkeys` and `n_sigs` when N = 1) |
| `sigflag` | Always `SIG_INPUTS`. The mint rejects `SIG_ALL` in the MVP |
| `locktime`, `refund` | Not used in the MVP. Reserved for the expiry add-on |
| Allowlist | **One global list for all owners** (all active providers), sorted ascending by hex. Every owner's tokens then share one lock shape, to avoid owner-specific signer sets; timing and amounts can still correlate redemptions. An owner who wants to pay fewer providers restricts the agent in code (`WALLET_ALLOWLIST`, §9), not in the lock |
| Provider set changes | New tokens use the current list. Old tokens stay valid for any key in their own lock that is still active |

With `cashu-ts`: `OutputData.createP2PKData({ pubkey: allowlist, requiredSignatures: 1, sigFlag: 'SIG_INPUTS' }, amount, keyset)`.

The mint cannot see the lock at issuance (outputs are blinded). Locking is the owner's choice and protects the owner from the agent, not the mint from anyone.

### 3.4 Encoded tokens

`cashuB` V4 tokens per [NUT-00](https://cashubtc.github.io/nuts/00), via `getEncodedToken` / `getDecodedToken`. Used in the x402 payment payload (`payload.token`, §7.2) and in the agent's token file.

**Agent token file [BF]:** a JSON file the owner CLI writes and the agent's wallet SDK reads and rewrites:

```json
{ "version": 1, "mint": "http://localhost:3338", "unit": "usd", "proofs": [ /* Proof[] without witness */ ], "pending": [ /* optional */ ] }
```

`pending` (optional) holds proofs sent in a paid retry whose outcome is not yet known: `[{ "proofs": Proof[], "url": string, "sent_at": number }]`. Readers that don't know it must preserve it.

**Wire form of a `Proof` in JSON bodies [BF]:** `amount` is a JSON number; `witness`, when present, is a JSON **string** (the serialized `P2PKWitness`). `cashu-ts` v4 serializes `amount` as a string and returns object witnesses, so clients map explicitly. The mint accepts either form on input.

## 4. Vault program (Anchor, Solana devnet)

Anchor 1.x. **Configured classic SPL mint; the intended deployment uses six-decimal USDC. Uses the classic SPL Token program** (`anchor_spl::token`, `transfer_checked`). `initialize` requires `usdc_mint` to be owned by the SPL Token program, so Token-2022 mints (and their fee or hook extensions) are rejected.

### 4.1 Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin: Pubkey`, `mint_authority: Pubkey`, `usdc_mint: Pubkey`, `vault_token: Pubkey`, `max_deposit: u64` (base units), `deposit_count: u64`, `provider_count: u32`, `last_batch_id: u64`, `bump: u8` |
| Vault token account | ATA of (`Config` PDA, `usdc_mint`) | Holds all deposited USDC. Authority is the `Config` PDA |
| `DepositRecord` | `["deposit", index.to_le_bytes()]` (u64) | `index: u64`, `depositor: Pubkey`, `amount: u64` (base units), `deposit_ref: [u8; 32]`, `slot: u64`, `timestamp: i64`, `bump: u8` |
| `ProviderRecord` | `["provider", provider_id.to_le_bytes()]` (u32) | `provider_id: u32`, `cashu_pubkey: [u8; 33]`, `payout_token: Pubkey`, `active: bool`, `bump: u8` |
| `IssuanceLog` | `["issuance"]` | `issued: u64`, `settled: u64` (cumulative base units), `seq: u64`, `updated_slot: u64`, `updated_at: i64`, `bump: u8`. Added after the first devnet deployment as a separate account, so `Config` and existing accounts keep their layout |

No reserved padding: on devnet we redeploy instead of migrating. `deposit_count`, `provider_count` and `last_batch_id` start at 0. The first deposit has index 0, the first provider id 0, the first batch id 1.

### 4.2 Types

```rust
pub struct Payout { pub provider_id: u32, pub amount: u64 } // amount in base units
```

### 4.3 Instructions

| Instruction | Args | Signer | Accounts (in order) | Effect and checks |
|---|---|---|---|---|
| `initialize` | `mint_authority: Pubkey, max_deposit: u64` | admin | `admin` (signer, mut), `config` (init), `usdc_mint`, `vault_token` (init ATA), `token_program`, `associated_token_program`, `system_program` | Creates `Config` and the vault ATA |
| `deposit` | `amount: u64, deposit_ref: [u8; 32]` | depositor | `depositor` (signer, mut), `config` (mut), `deposit_record` (init, seed = current `deposit_count`), `depositor_token` (mut), `vault_token` (mut), `usdc_mint`, `token_program`, `system_program` | `amount > 0`, `amount % 10_000 == 0`, `amount <= max_deposit`. Transfers USDC to the vault, writes `DepositRecord`, increments `deposit_count`, emits `DepositMade` |
| `register_provider` | `cashu_pubkey: [u8; 33], payout_token: Pubkey` | admin | `admin` (signer, mut), `config` (mut), `provider_record` (init, seed = current `provider_count`), `payout_token_account` (must equal `payout_token`, mint = `config.usdc_mint`), `system_program` | `cashu_pubkey[0]` is `0x02` or `0x03`. Writes `ProviderRecord` with `active = true`, increments `provider_count`, emits `ProviderRegistered` |
| `deactivate_provider` | `provider_id: u32` | admin | `admin` (signer), `config`, `provider_record` (mut, PDA for `provider_id`) | Sets `active = false`, emits `ProviderDeactivated`. One way: no reactivation in the MVP (register a new record instead, after deactivation; the old balance is not migrated) |
| `settle_batch` | `batch_id: u64, payouts: Vec<Payout>` | mint authority | `mint_authority` (signer), `config` (mut), `vault_token` (mut), `usdc_mint`, `token_program`; then `remaining_accounts` as pairs `[provider_record, payout_token (mut)]`, one pair per payout, same order, optionally followed by `issuance_log` (mut) | `vault_token == config.vault_token`; `batch_id == last_batch_id + 1`; `1 <= payouts.len() <= 8`; no `provider_id` twice; each `amount > 0` and `amount % 10_000 == 0`; each `provider_record` is the PDA for `provider_id`, is active, and its `payout_token` equals the passed account. Transfers each amount, sets `last_batch_id = batch_id`, emits `BatchSettled`. With the trailing `issuance_log` (must be the `["issuance"]` PDA, program-owned, writable, else `IssuanceLogMismatch`), adds the batch total to its `settled` |
| `init_issuance_log` | `issued: u64, settled: u64` | mint authority | `mint_authority` (signer, mut, pays rent), `config` (`has_one = mint_authority`), `issuance_log` (init, `["issuance"]`), `system_program` | Both whole cents, `issued >= settled` (`IssuanceBelowSettled`). Creates the log with `seq = 0`, emits `IssuanceLogged`. One time only. `settled` is a baseline for batches paid before the log existed, checkable against past `BatchSettled` events |
| `log_issuance` | `add: u64` | mint authority | `mint_authority` (signer), `config` (`has_one = mint_authority`), `issuance_log` (mut) | Whole cents. `issued += add` (an atomic add: mints sharing the vault cannot overwrite each other; `MathOverflow` on overflow); the result must be `>= settled` (`IssuanceBelowSettled`). Increments `seq`, records slot and time, emits `IssuanceLogged` |

The `batch_id` check prevents duplicate payouts: a retried batch fails with `BadBatchId` instead of paying twice.

Two deposits built against the same `deposit_count` collide on the `DepositRecord` seed; the second fails and the client rebuilds it with the new count and resends.

`initialize` can be called by anyone once. Initialize immediately after deployment. Deployment and initialization are separate operations; another caller can take control first.

### 4.4 Events

Emitted with `emit!`. The mint does **not** rely on events (section 6). Copycat's QuickNode Stream filter (`scripts/streams/copycat-filter.js`) decodes `DepositMade` from the `Program data:` log line (8-byte discriminator `sha256("event:DepositMade")[0..8]`, then the Borsh fields) and reports it; Copycat's signals come from USDC balance changes, not events.

| Event | Fields |
|---|---|
| `DepositMade` | `index: u64, depositor: Pubkey, amount: u64, deposit_ref: [u8; 32]` |
| `ProviderRegistered` | `provider_id: u32, cashu_pubkey: [u8; 33], payout_token: Pubkey` |
| `ProviderDeactivated` | `provider_id: u32` |
| `BatchSettled` | `batch_id: u64, total: u64, count: u8` |
| `IssuanceLogged` | `issued: u64, settled: u64, seq: u64` |

### 4.5 Errors

`InvalidAmount`, `AmountNotWholeCents`, `DepositTooLarge`, `InvalidPubkey`, `WrongMint`, `WrongVaultAccount`, `Unauthorized`, `BadBatchId`, `TooManyPayouts`, `EmptyBatch`, `DuplicateProvider`, `ProviderMismatch`, `ProviderInactive`, `PayoutAccountMismatch`, `MathOverflow`, `IssuanceBelowSettled`, `IssuanceLogMismatch` (codes 6000 + index; new errors are only appended).

The mint requires provider pubkeys to be unique among active records. A deactivated key may be re-registered under a new provider ID, but old balances remain attached to the old ID. `settle_batch` returns `ProviderInactive` for a deactivated provider. The mint stops crediting a deactivated provider (§5.6 check 6) and pays out its remaining balance before the admin deactivates it, or forfeits it (MVP: admin's call).

## 5. Mint HTTP API

Base URL `MINT_URL`. JSON bodies. Errors use the Cashu shape `{"detail": string, "code": number}` with HTTP 400, using [standard codes](https://github.com/cashubtc/nuts/blob/main/error_codes.md) where they fit and `7xxxx` for Blindfold codes.

### 5.1 Info, keys (standard)

| Endpoint | Spec | Notes |
|---|---|---|
| `GET /v1/info` | [NUT-06](https://cashubtc.github.io/nuts/06) | `nuts`: `4` with method `solana-usdc`, unit `usd`, `min_amount: 1`, `max_amount: 5000`; `5` disabled; `7`, `10`, `11`, `12`, `20` `{"supported": true}` |
| `GET /v1/keys`, `GET /v1/keys/{keyset_id}` | NUT-01 | |
| `GET /v1/keysets` | NUT-02 | Lists **all** keysets, including inactive ones. The mint signs only with the active keyset; redemption also requires available private keys; this implementation loads only the seed-derived active keyset. Rotation is not supported |
| `POST /v1/checkstate` | NUT-07 | `{"Ys": [hex]}` → `{"states": [{"Y", "state": "UNSPENT"|"SPENT", "witness": null}]}` |

**[BF] Not offered in the MVP:** `POST /v1/swap` (NUT-03) and melt (NUT-05). Without swap, locked tokens can only leave the system through `/v1/blindfold/redeem`.

### 5.2 Payment method `solana-usdc` [BF]

A custom [NUT-04](https://cashubtc.github.io/nuts/04) method. A vault deposit replaces a Lightning invoice. `request` is a random `deposit_ref`, which the owner passes to the `deposit` instruction. The quote id never goes onchain (NUT-04 requires it to stay secret), and [NUT-20](https://cashubtc.github.io/nuts/20) is mandatory so that seeing a `deposit_ref` onchain is not enough to mint.

### 5.3 Mint quote

`POST /v1/mint/quote/solana-usdc`

```json
{ "unit": "usd", "amount": 500, "pubkey": "<33-byte hex, required>" }
```

`200`:

```json
{
  "quote": "<uuid v7>",
  "request": "<deposit_ref: 32 random bytes, hex>",
  "unit": "usd",
  "method": "solana-usdc",
  "amount": 500,
  "expiry": 1763170000,
  "pubkey": "<same as request>",
  "amount_paid": 0,
  "amount_issued": 0,
  "updated_at": 1763166400,
  "vault_program": "<base58 program id>",
  "usdc_mint": "<base58>",
  "amount_base_units": "5000000"
}
```

Errors: `11013` unit not `usd`; `11006` amount outside `1..5000`; `20009` missing `pubkey`.

`GET /v1/mint/quote/solana-usdc/{quote}` returns `404 {"detail", "code": 20001}` for an unknown quote, otherwise the same shape with current `amount_paid` / `amount_issued` / `updated_at`.

`amount_paid` is the sum, in cents, of all `DepositRecord`s whose `deposit_ref` matches, even if it differs from `amount`. `expiry` is advertised as a payment deadline, but the current poller does not enforce it: matching deposits are credited even after expiry. A paid quote can be minted after expiry. Do not rely on the timestamp as a spending or refund control.

### 5.4 Mint tokens

`POST /v1/mint/solana-usdc`

```json
{ "quote": "<uuid>", "outputs": [ /* BlindedMessage[] */ ], "signature": "<NUT-20 schnorr sig hex>" }
```

`200`: `{ "signatures": [ /* BlindSignature[] with dleq */ ] }`

| Check | Error |
|---|---|
| Quote exists and `amount_paid > 0` | `20001` |
| `1 <= outputs.length <= 256` | `11015` |
| NUT-20 signature valid for the quote `pubkey` | `20008` |
| `sum(outputs.amount) <= amount_paid - amount_issued` | `20002` if nothing mintable, else `11006` |
| No duplicate `B_` in request | `11008` |
| No `B_` signed before | `11003` |
| Keyset known and active, amount in keyset | `12001`, `12002` |

`amount_issued` increases and the signatures are stored in one DB transaction.

**Replay of a lost response:** if every `B_` in the request was already signed **for this same quote** and the set matches a previous request exactly, the mint returns the stored signatures with `200` and changes nothing. Partial overlap is `11003`.

### 5.5 Providers

`GET /v1/blindfold/providers` (public) → `200`:

```json
[ { "provider_id": 0, "pubkey": "<hex33>", "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5, "topics": ["sol", "btc", "eth"], "active": true } ]
```

`provider_id`, `pubkey` and `active` come from `ProviderRecord` accounts. `name`, `url`, `price_cents` (advisory list price, used by the owner to plan denominations) and `topics` (what the provider sells, used by the agent to choose) come from `config/providers.json`:

```json
[ { "provider_id": 0, "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5, "topics": ["sol", "btc", "eth"] } ]
```

A registered provider missing from the file is listed with `name: null, url: null, price_cents: null, topics: []`. Inactive providers are listed with `active: false`. Used by the owner CLI to build the global allowlist (active entries only) and by the agent to find APIs.

### 5.5a Reserves (public) [BF]

`GET /v1/blindfold/reserves` → `200`:

```json
{ "issued": 1000, "settled": 400, "outstanding": 600, "keyset_id": "<active keyset id>", "updated_at": 1763166400 }
```

All cents. `outstanding = issued - settled`: tokens not yet redeemed plus redeemed-but-unpaid provider balances, i.e. everything the vault still owes. The agent compares it with the vault balance it reads **itself** from the chain (§7.6).

Trust limit: these numbers are the mint's report. Once the vault has an `IssuanceLog` (§4.1), the agent also reads `issued - settled` from it and uses the larger of the two (§7.6). Without a log, the check catches a vault that was drained or underfunded; it does not catch a mint that under-reports issuance.

### 5.6 Redeem [BF]

`POST /v1/blindfold/redeem`, called by the provider's x402 facilitator during settle (§7.3).

```json
{ "proofs": [ /* Proof[], each with witness = "{\"signatures\":[\"<schnorr sig hex>\"]}" */ ] }
```

The signature is the provider's NUT-11 signature over the proof's `secret` string, made with the provider's Cashu key (`cashu-ts` `signP2PKProofs`).

`200`: `{ "provider_id": 0, "amount": 5, "redemption_id": "<uuid>" }`

The mint, in order:

| # | Check | Error |
|---|---|---|
| 1 | `1 <= proofs.length <= 64`, no duplicate `secret` | `11014`, `11007` |
| 2 | Keyset known, unit `usd`; private key available for the denomination | `12001`, `12002` |
| 3 | `C` valid for `secret` and amount | `10001` |
| 4 | Secret is NUT-10 `P2PK`, well formed per NUT-11, only the tags `pubkeys`, `n_sigs` (= 1), `sigflag` (= `SIG_INPUTS`) present. Duplicate tags/signers and any `locktime` or `refund` tag are rejected in the MVP | `70001` |
| 5 | Exactly one signer-set key produced a valid signature in `witness` | `10001` |
| 6 | That key is the `cashu_pubkey` of an active registered provider | `70002` |
| 7 | All proofs in the request were signed by the same provider | `70003` |
| 8 | In **one DB transaction**: insert every `Y` into the spent set (unique), add `sum(amount)` to that provider's balance, insert the redemption row. Any `Y` already present aborts the whole transaction | `11001` |

The credited provider is the one whose key signed, never one named in the request.

### 5.7 Admin

Header `Authorization: Bearer <MINT_ADMIN_TOKEN>`. `401 {"detail":"unauthorized"}` otherwise.

| Endpoint | Response |
|---|---|
| `GET /v1/blindfold/admin/balances` | `[{ "provider_id": 0, "balance": 15 }]` (cents, unsettled; positive balances only) |
| `POST /v1/blindfold/admin/settle` | Runs one settlement now under the same hold and unit policy as the timer (at most 8 providers, largest payable amounts first; the rest wait for the next run). `{ "batch_id": 1, "payouts": [{ "provider_id": 0, "amount": 15 }], "tx": "<signature>" }` or `{ "batch_id": null }` if nothing is payable yet |
| `POST /v1/blindfold/admin/poll-deposits` | Polls deposits now (§6) and returns `{ "processed": n }`. A hint, e.g. from a QuickNode Stream `DepositMade`; joins a poll already in flight. Credits only from `DepositRecord` accounts |
| `POST /v1/blindfold/admin/log-issuance` | Publishes cumulative issuance to the `IssuanceLog` now. `{ "result": "initialized" \| "logged" \| "unchanged" \| "deferred" \| "pending" \| "unsupported" }` (`deferred`: a batch is in flight, so the log is not created or joined yet; `pending`: a sent transaction is not confirmed yet; `unsupported`: the program predates the log) |
| `GET /v1/blindfold/admin/reconcile` | `{ "vault_balance": c, "deposited": c, "issued": c, "redeemed": c, "settled": c }` (all cents). Lets tests check `vault_balance == deposited - settled` |

Settlement can also return HTTP 409 (`70010`: another run holds the lock; `70011`: a batch is still in flight) or HTTP 502 (`70012`: a batch failed and balances were restored). Retry according to batch state, not as a new payment. Reconciliation is a diagnostic read, not an atomic snapshot across chain and database.

## 6. Deposit detection (MVP: polling)

The mint reads vault-owned **account state**, not transaction logs or raw instructions. A DepositRecord is written only after a successful token transfer; a transfer-like instruction alone is not evidence of payment.

Every `DEPOSIT_POLL_MS`, at `confirmed` commitment:

1. Read `Config.deposit_count`.
2. For each index from the stored cursor up to `deposit_count - 1`, fetch `DepositRecord` at `["deposit", index]`. Check the account owner is the vault program.
3. In one DB transaction per record: insert the deposit (unique on `index`), find the quote whose `request == deposit_ref`, add `amount / 10_000` to its `amount_paid`, bump `updated_at`, advance the cursor.
4. A deposit with no matching quote is stored as unmatched. (Refunds are deferred.)

A QuickNode Stream `DepositMade` event triggers this same poll immediately through `POST /v1/blindfold/admin/poll-deposits` (§5.7). It never credits a deposit by itself, because the mint credits only from vault-owned account state; a forged event causes at most an extra poll.

## 7. Payment handshake: x402 v2, scheme `blindfold`

Headers, encodings and types are exactly [x402 v2 HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md): `PAYMENT-REQUIRED` (server to client), `PAYMENT-SIGNATURE` (client to server) and `PAYMENT-RESPONSE` (server to client), each a base64-encoded JSON object. Only the scheme is ours.

Prior art: [`x402-cashu`](https://github.com/orangerabbit-io/x402-cashu) carries sat-denominated Cashu over x402 as scheme `exact` on network `cashu:mainnet`. We share its payload shape (`payload.token`, `extra.mints`, `extra.unit`) but use our own scheme name, `blindfold`, rather than a generic `cashu`, because the payment is not interchangeable with standard Cashu: our value is Solana USDC, the lock is a required 1-of-N, and settlement is a redeem rather than a swap. Do not depend on that package (hackathon rule: no building on pre-existing projects).

Use the SDKs rather than hand-rolling headers: `@x402/hono` `paymentMiddleware` + `x402ResourceServer` on the provider, `@x402/fetch` `wrapFetchWithPayment` + `x402Client` in the wallet.

### 7.1 Server: payment required

An unpaid request gets `402` with `PAYMENT-REQUIRED` decoding to an x402 `PaymentRequired`:

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:4000/v1/data/sol", "description": "market data", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "cashu",
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "asset": "<USDC_MINT>",
    "amount": "50000",
    "payTo": "<provider Cashu pubkey hex33>",
    "maxTimeoutSeconds": 60,
    "extra": {
      "mints": ["http://localhost:3338"],
      "unit": "usd",
      "nut10": { "k": "P2PK", "d": "<provider Cashu pubkey hex33>" },
      "paymentFlow": "upfront"
    }
  }]
}
```

| Field | Rule |
|---|---|
| `amount` | USDC base units, always a whole number of cents (`PRICE_CENTS * 10_000`) |
| `payTo` | The provider's Cashu pubkey. Must equal `extra.nut10.d` |
| `extra.mints`, `extra.unit`, `extra.nut10` | Same meaning as NUT-18 `m`, `u`, `nut10`. Added by the server scheme's `enhancePaymentRequirements` |
| `extra.paymentFlow` | Added by the SDK. Always `upfront`: settle (redeem) runs **before** the route handler |
| Other `accepts` entries | Allowed. The add-on 1 baseline appends a standard `exact` entry on the same route (03); clients pick the scheme they have registered |

### 7.2 Client: paid retry

Same method, URL and body, plus `PAYMENT-SIGNATURE` decoding to an x402 `PaymentPayload`:

```json
{ "x402Version": 2, "resource": { ... }, "accepted": { /* the chosen accepts entry, unchanged */ }, "payload": { "token": "cashuB..." } }
```

The `cashuB` token (§3.4) holds proofs that:

| Rule | Note |
|---|---|
| Come from a mint in `extra.mints`, unit `extra.unit` | |
| Sum to **exactly** `amount / 10_000` cents | **[BF]** There is no change, so overpayment would be lost |
| Each have `extra.nut10.d` in their signer set (§3.3) | A 1-of-N lock that includes the provider's key counts as a match |
| Carry no witness | The provider adds its signature at settle |

### 7.3 Server: facilitator and result

The provider passes `x402ResourceServer` a **Blindfold facilitator**: an in-process object implementing x402's `FacilitatorClient` interface. It lives with the provider because it signs with the provider's key.

| Method | Behaviour |
|---|---|
| `getSupported()` | `{ kinds: [{ x402Version: 2, scheme: "cashu", network: <devnet CAIP-2> }], extensions: [], signers: {} }` |
| `verify(payload, req)` | Structural checks only. Not called in the `upfront` flow; return `{ isValid: true }` if the token decodes |
| `settle(payload, req)` | Decode token, run the §7.2 checks, sign every proof with the provider key (`signP2PKProofs`), call `POST /v1/blindfold/redeem` (§5.6). Return an x402 `SettleResponse` |

`SettleResponse` on success: `{ "success": true, "transaction": "<redemption_id>", "network": "<CAIP-2>", "amount": "<base units>" }`. Like x402's `batch-settlement` scheme, `transaction` is a commitment id, not an onchain signature: the USDC moves later in `settle_batch`.

On failure: `{ "success": false, "errorReason": "<reason>", "transaction": "", "network": "<CAIP-2>" }`, reason one of `malformed_token`, `wrong_mint`, `wrong_unit`, `wrong_amount`, `wrong_lock`, `unexpected_witness`, `redeem_failed_<mint code>` (e.g. `redeem_failed_11001` for a replay), `mint_unavailable`.

| Case | What the client sees |
|---|---|
| Settled | `200` with the data and a `PAYMENT-RESPONSE` header (the `SettleResponse`) |
| Any settle failure | `402` again (SDK behaviour). The route handler does not run. Clients must not rely on the reason reaching them |

### 7.4 Client: wallet configuration and recovery

| Piece | Rule |
|---|---|
| Scheme registration | `new x402Client().register(<devnet CAIP-2>, cashuClientScheme)`. The wallet registers only `blindfold`, so it never pays with any other scheme |
| Spend controls | `setSpendControls({ allowedAssets: [{ network, asset: USDC_MINT, maxAmountPerPayment: String(MAX_PER_CALL_CENTS * 10_000) }] })`. Required: x402 rejects non-default assets for custom schemes otherwise. This is also the first per-call cap |
| `createPaymentPayload` | Runs the Blindfold refusals (allowlist, signer set, exact sum, mint, unit, cap) and throws `PaymentRefused` before any proof leaves. Then, for a price above `APPROVAL_OVER_CENTS`, asks the owner's approver and refuses with `approval_denied` or `approval_timeout` unless it approves in time ([04](04-wallet-sdk.md#owner-approval)). Moves chosen proofs to `pending` |
| `schemeHooks.onPaymentResponse` | Success: drop the pending proofs. Failure or no `SettleResponse`: `POST /v1/checkstate` (NUT-07) for them; `UNSPENT` go back, `SPENT` are dropped. This also covers a lost `200` |

### 7.5 Mock API paid endpoint

The mock provider is a token data feed in the style of the Solana DeFi feeds that sell per call over x402.

`GET /v1/data/:topic` (whale flow), priced at `PRICE_CENTS`. `200` body:

```json
{ "topic": "sol", "feed": "whale-flow", "price": 114.1, "change_24h_pct": 0.9, "volume_24h": 33370933,
  "whale_netflow": 14151, "window": "1h", "whale_buys": 7, "whale_sells": 3, "largest_trade_usd": 123456, "as_of": 1763166400 }
```

`whale_netflow` is net USD bought by whale wallets over `window` (negative: net selling).

`GET /v1/data/:topic/depth` (order-book depth), default 10 cents: `{ topic, feed: "depth", bids: [{price, size}] x5, asks: [{price, size}] x5, spread_bps, as_of }`.

`GET /v1/data/:topic/signals` (premium trade signal), default 25 cents, above the default approval threshold: `{ topic, feed: "signals", signal: "BUY" | "SELL" | "HOLD", confidence, horizon: "1h", as_of }`. The signal follows `whale_netflow` (above +20,000 BUY, below -20,000 SELL).

Fake, deterministic per topic. `GET /health` is free.

**`exact` memos.** With the `exact` baseline, a provider may set x402's `extra.memo` on a route's `exact` entry; the payer's transaction then carries that text in an SPL Memo instruction, onchain. Sellers use memos to reconcile payments. The demo provider tags its listed tokens' routes `whale-flow/<TOKEN>`, `depth/<TOKEN>` and `signals/<TOKEN>` (`ExactOptions.memoTopics`); other `exact` payments carry the payer's random nonce memo. `blindfold` entries never carry a memo.

### 7.6 Agent reserve check [BF]

Before its first paid call in a session, and again every `RESERVE_CHECK_EVERY` paid calls (default 10), the agent:

1. Reads the vault token account (`vaultAta`, §4.1) balance from Solana RPC itself (`getTokenAccountBalance`, `confirmed`), and the `Config` account to confirm it is owned by the vault program and `usdc_mint` matches `USDC_MINT`.
2. Reads the `IssuanceLog` PDA if it exists (owner must be the vault program; `settled > issued` fails). Onchain liabilities = `floor((issued - settled) / 10_000)` cents.
3. Fetches `GET /v1/blindfold/reserves` (§5.5a).
4. Uses `outstanding = max(onchain, reported)`: a mint may have issued tokens it has not logged yet. Proceeds only if `floor(vault_balance / 10_000) >= outstanding` (count only whole cents; direct transfers may add sub-cent dust).

The result carries `verified: true` when the log was read. Failure modes are **fail closed**: an RPC error, a bad or foreign log, or, when there is no log, a mint error. With a log, a mint error is reported in `note` and the check proceeds on the onchain number alone. Without a log, `note` says the liabilities are unverified.

What the log proves: the mint's liability claim is public, timestamped and can only grow, so the mint cannot show the agent a smaller number than it published. What it doesn't prove: a mint can still issue tokens it never logs. That claim is now auditable, not impossible.

## 8. Shared TypeScript package: `packages/protocol`

Build this package before components that import its `dist/` output. The recursive workspace build orders dependencies automatically.

| Export | Contents |
|---|---|
| `constants` | Everything in §2 |
| `types` | Re-exports `Proof`, `BlindedMessage`, etc. from `cashu-ts`; `TokenFile`, `ProviderInfo`, `RedeemRequest/Response`, `MintQuoteSolanaUsdcRequest/Response`, error code enum (§5) |
| `lock` | `buildLockOptions(allowlist: string[]): P2PKOptions` (sorted, §3.3); `signerSet(secret: string): string[]` |
| `x402` | `CASHU_SCHEME`, `SOLANA_DEVNET_CAIP2`; types `CashuExtra`, `CashuPayload` (`{ token }`); `parseCashuRequirements(req): { cents, mints, unit, providerPubkey }` (throws if `amount` is not whole cents or `payTo != nut10.d`); `cashuExtra({ mintUrl, providerPubkey })` |
| `units` | `centsToBaseUnits`, `baseUnitsToCents` (throws if not whole cents) |
| `reserves` | `checkReserves({ connection, programId, usdcMint, mintUrl }): Promise<{ ok: boolean; vaultCents: number; outstandingCents: number; reason?: string }>` (§7.6) |
| `vault` | PDA helpers (`configPda`, `depositPda(index)`, `providerPda(id)`, `vaultAta`), account decoders and instruction builders from the Anchor IDL (`@anchor-lang/core`) |
| `env` | Zod-validated loader for §9 |

The checked-in IDL is `packages/protocol/src/idl.ts`. After changing the vault, compare it with `target/idl/vault.json` from `anchor build`, including account order and signer/writable flags. The generated build output does not automatically update this TypeScript file.

### 8.1 Wallet SDK surface (`packages/wallet`)

What the agent and other callers may rely on. Details in `04-wallet-sdk.md`.

```ts
class AgentWallet {
  static open(opts?: {
    tokenFile?: string; maxPerCallCents?: number; allowlist?: string[]; fetch?: typeof fetch;
    approvalOverCents?: number; approve?: Approver; approvalTimeoutMs?: number; // owner approval (04)
  }): Promise<AgentWallet>;
  balance(): number;          // spendable cents (excludes pending)
  payFetch(url: string | URL, init?: RequestInit): Promise<Response>; // fetch-compatible
}
class PaymentRefused extends Error { reason: RefusalReason }  // thrown before any proof leaves the wallet
class PaymentFailed extends Error { status: number; errorReason?: string } // paid retry not settled (after checkstate recovery). status is 402 for any settle failure (§7.3); errorReason only if the SDK surfaced it
```

`payFetch` wraps `@x402/fetch` (§7.4). It returns non-402 responses unchanged and never throws for them. x402 wraps errors thrown inside a scheme ("Failed to create payment payload: ..."), and its spend controls refuse over-cap requests before our scheme runs; `payFetch` unwraps both into `PaymentRefused` (the latter as `over_cap`). `RefusalReason` includes `provider_not_allowed`, `provider_not_in_signer_set`, `over_cap`, `insufficient_balance`, `insufficient_exact`, `unit`, `mint`, `bad_request`, `approval_denied`, `approval_timeout`. `Approver` is `(req, signal) => Promise<boolean>`; see [04](04-wallet-sdk.md#owner-approval). Call `wallet.close()` when finished to release the file lock. If a payment was attempted, a non-2xx final response raises `PaymentFailed`; an unpaid non-402 response is returned unchanged.

## 9. Repo layout and configuration

pnpm workspace, TypeScript (ESM, Node 22+), Anchor workspace at the repo root.

```
Anchor.toml
programs/vault/        01: Anchor program
services/mint/         02: mint server
apps/mock-api/         03: mock paid API
packages/protocol/     00: shared TS contract code
packages/testkit/      shared test helpers (fake keyset, locked token issuance)
packages/wallet/       04: wallet SDK + owner CLI
agents/simple/         05: simple agent
config/providers.json  provider_id → name, url
scripts/               devnet setup, e2e test, demo, Copycat (bot.ts), streams/ (QuickNode Stream filter)
spikes/x402-cashu/     feasibility spike (reference only, not production code)
docker-compose.yml     Postgres
.env.example
```

| Env var | Used by |
|---|---|
| `SOLANA_RPC_URL` | all Solana clients |
| `VAULT_PROGRAM_ID`, `USDC_MINT` | all Solana clients |
| `ADMIN_KEYPAIR` (path) | scripts |
| `MINT_URL` | wallet, mock API, agent |
| `DATABASE_URL`, `MINT_SEED` (32-byte hex), `MINT_AUTHORITY_KEYPAIR` (path), `MINT_ADMIN_TOKEN`, `PORT` (3338) | mint |
| `PROVIDER_SECRET_KEY` (secp256k1 hex), `PROVIDER_ID`, `PRICE_CENTS` (5), `PORT` (4000), `PUBLIC_URL` (for x402 `resource.url`) | mock API |
| `OWNER_KEYPAIR` (path) | owner CLI |
| `RESERVE_CHECK_EVERY` (10) | agent; checks before calls 1, 11, 21, … by default |
| `LLM_API_KEY`, `LLM_BASE_URL` (Gemini's OpenAI-compatible endpoint), `LLM_MODEL` (`gemini-3.5-flash-lite,gemini-flash-latest`) | agent `--llm` mode ([05](05-agent.md#llm-decision-loop)); `pnpm demo` also reads `.keys/llm.key` |
| `MINT_DEV_FAKE_CHAIN` (`1` to enable), `PROVIDERS_FILE`, `DEPOSIT_POLL_MS`, `SETTLE_INTERVAL_S`, `SETTLE_HOLD_S`, `SETTLE_UNIT_CENTS` | mint; fake-chain mode is local development only |
| `QUICKNODE_API_KEY` (or `.keys/quicknode.json`), `CLOUDFLARED`, `STREAMS_WEBHOOK_URL`, `STREAMS_PORT` | Copycat's QuickNode Stream in `pnpm demo`, `pnpm bot` and `pnpm streams:setup` |
| `TOKEN_FILE`, `MAX_PER_CALL_CENTS` (10), `WALLET_ALLOWLIST` (comma list of provider pubkeys; default: union of the proofs' signer sets) | wallet SDK, agent |
| `APPROVAL_OVER_CENTS` (20; higher prices need the owner's approval), `APPROVAL_TIMEOUT_S` (60, agent only) | wallet SDK, agent ([05](05-agent.md#owner-approval)) |

**Test layers:** TypeScript tests use fakes; mint and application integration tests require PostgreSQL. Rust vault tests use LiteSVM and a built `target/deploy/vault.so`. The separate `e2e:localnet` script uses `solana-test-validator` and a six-decimal test mint; `e2e` uses a deployed devnet vault and funded keys. See [the runbook](../RUNNING.md).

## 10. End-to-end acceptance (MVP done)

`scripts/e2e.ts` on devnet:

1. Owner CLI: quote $1.00 (100 cents), deposit, wait until `amount_paid == 100`, mint tokens locked to the mock API's key, write the token file.
2. Agent: reserve check passes (§7.6), then one paid call to the mock API through the wallet SDK. Gets `402` with `PAYMENT-REQUIRED` offering scheme `blindfold`, retries with `PAYMENT-SIGNATURE`, gets `200` with data and a `PAYMENT-RESPONSE` whose `transaction` is a redemption id. Token file balance drops by `PRICE_CENTS`.
3. Replay: resend the same `PAYMENT-SIGNATURE` header. Gets `402`; the provider's settle logged `redeem_failed_11001`; its mint balance is unchanged.
4. `POST /v1/blindfold/admin/settle`. The provider's payout account receives `PRICE_CENTS * 10_000` base units of USDC on devnet.
5. `GET /v1/blindfold/admin/reconcile`: `vault_balance == deposited - settled`.
6. Reserve check fails closed: with a stub reserves endpoint reporting `outstanding` above the vault balance, the agent refuses to pay and exits non-zero.
