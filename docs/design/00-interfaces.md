# 00: Interfaces

The contract every MVP component builds against. If a component doc disagrees with this file, this file wins. Change it only by team agreement, then update the affected component docs.

Where a Cashu NUT already defines something, we use it unchanged and link it. Blindfold-specific deviations are marked **[BF]**.

## 1. Overview

```
Owner CLI ──deposit(amount, deposit_ref)──▶ Vault program (Solana devnet)
    │                                            ▲   │ DepositRecord accounts
    │ NUT-04/20 quote + mint (blinded)           │   ▼ (polled)
    └──────────────────────────────▶ Mint ◀──────┘  settle_batch
                                      ▲  ▲
         cashuB token file            │  │ POST /v1/blindfold/redeem
Owner ───────────────▶ Agent ─ Wallet SDK ─HTTP 402 / X-Cashu─▶ Mock API
```

| Step | From → To | Interface |
|---|---|---|
| 1. Quote | Owner (wallet SDK) → Mint | `POST /v1/mint/quote/solana-usdc` (§5.3) |
| 2. Deposit | Owner → Vault | `deposit` instruction (§4.3) |
| 3. Detect | Mint → Vault | Poll `Config.deposit_count` + `DepositRecord` (§6) |
| 4. Issue | Owner → Mint | `POST /v1/mint/solana-usdc` with locked blinded outputs (§5.4, §3.3) |
| 5. Hand over | Owner → Agent | `cashuB` token file (§3.4) |
| 6. Pay | Agent (wallet SDK) → Mock API | HTTP 402 + `X-Cashu` (§7) |
| 7. Redeem | Mock API → Mint | `POST /v1/blindfold/redeem` (§5.6) |
| 8. Settle | Mint → Vault | `settle_batch` instruction (§4.3) |

## 2. Constants and conventions

| Name | Value | Notes |
|---|---|---|
| Cashu unit | `usd` | Amounts are **integer cents** everywhere offchain |
| USDC decimals | 6 | |
| `BASE_UNITS_PER_CENT` | `10_000` | Conversion happens only at the vault boundary |
| Keyset amounts | `1, 2, 4, ... 4096` (2^0 to 2^12) | One active keyset, `input_fee_ppk = 0` |
| `MAX_DEPOSIT_CENTS` | `5000` ($50) | Not-a-mixer cap; enforced onchain and in quotes |
| `QUOTE_EXPIRY_S` | `3600` | Payment deadline only (NUT-04) |
| `DEPOSIT_POLL_MS` | `2000` | |
| `SETTLE_INTERVAL_S` | `60` | |
| `MAX_PAYOUTS_PER_BATCH` | `8` | Keeps `settle_batch` under the tx size limit |
| Solana commitment | `confirmed` | Demo only; real deployment would use `finalized` |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle devnet USDC, classic SPL Token program. Configurable via `USDC_MINT` |
| Mint URL | `http://localhost:3338` | Configurable via `MINT_URL` |

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

Every token the owner issues is locked with a [NUT-11](https://cashubtc.github.io/nuts/11) P2PK secret, **1-of-N** over the allowlisted providers' Cashu keys:

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
| Allowlist order | Sorted ascending by hex, so all of one owner's tokens share one secret shape |

With `cashu-ts`: `OutputData.createP2PKData({ pubkey: allowlist, requiredSignatures: 1, sigFlag: 'SIG_INPUTS' }, amount, keyset)`.

The mint cannot see the lock at issuance (outputs are blinded). Locking is the owner's choice and protects the owner from the agent, not the mint from anyone.

### 3.4 Encoded tokens

`cashuB` V4 tokens per [NUT-00](https://cashubtc.github.io/nuts/00), via `getEncodedToken` / `getDecodedToken`. Used in the `X-Cashu` retry header and in the agent's token file.

**Agent token file [BF]:** a JSON file the owner CLI writes and the agent's wallet SDK reads and rewrites:

```json
{ "version": 1, "mint": "http://localhost:3338", "unit": "usd", "proofs": [ /* Proof[] without witness */ ], "pending": [ /* optional */ ] }
```

`pending` (optional) holds proofs sent in a paid retry whose outcome is not yet known: `[{ "proofs": Proof[], "url": string, "sent_at": number }]`. Readers that don't know it must preserve it.

**Wire form of a `Proof` in JSON bodies [BF]:** `amount` is a JSON number; `witness`, when present, is a JSON **string** (the serialized `P2PKWitness`). `cashu-ts` v4 serializes `amount` as a string and returns object witnesses, so clients map explicitly. The mint accepts either form on input.

## 4. Vault program (Anchor, Solana devnet)

Anchor 1.x. Token CPIs use `anchor_spl::token_interface` and `transfer_checked`.

### 4.1 Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin: Pubkey`, `mint_authority: Pubkey`, `usdc_mint: Pubkey`, `vault_token: Pubkey`, `max_deposit: u64` (base units), `deposit_count: u64`, `provider_count: u32`, `last_batch_id: u64`, `bump: u8` |
| Vault token account | ATA of (`Config` PDA, `usdc_mint`) | Holds all deposited USDC. Authority is the `Config` PDA |
| `DepositRecord` | `["deposit", index.to_le_bytes()]` (u64) | `index: u64`, `depositor: Pubkey`, `amount: u64` (base units), `deposit_ref: [u8; 32]`, `slot: u64`, `timestamp: i64`, `bump: u8` |
| `ProviderRecord` | `["provider", provider_id.to_le_bytes()]` (u32) | `provider_id: u32`, `cashu_pubkey: [u8; 33]`, `payout_token: Pubkey`, `active: bool`, `bump: u8` |

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
| `settle_batch` | `batch_id: u64, payouts: Vec<Payout>` | mint authority | `mint_authority` (signer), `config` (mut), `vault_token` (mut), `usdc_mint`, `token_program`; then `remaining_accounts` as pairs `[provider_record, payout_token (mut)]`, one pair per payout, same order | `vault_token == config.vault_token`; `batch_id == last_batch_id + 1`; `1 <= payouts.len() <= 8`; no `provider_id` twice; each `amount > 0` and `amount % 10_000 == 0`; each `provider_record` is the PDA for `provider_id`, is active, and its `payout_token` equals the passed account. Transfers each amount, sets `last_batch_id = batch_id`, emits `BatchSettled` |

The `batch_id` check makes `settle_batch` idempotent: a retried batch fails with `BadBatchId` instead of paying twice.

Two deposits built against the same `deposit_count` collide on the `DepositRecord` seed; the second fails and the client rebuilds it with the new count and resends.

`initialize` can be called by anyone once. The deploy script calls it immediately after deploying (accepted hackathon risk).

### 4.4 Events

Emitted with `emit!`. The MVP mint does **not** rely on events; they exist for the QuickNode Stream and the competitor bot add-ons.

| Event | Fields |
|---|---|
| `DepositMade` | `index: u64, depositor: Pubkey, amount: u64, deposit_ref: [u8; 32]` |
| `ProviderRegistered` | `provider_id: u32, cashu_pubkey: [u8; 33], payout_token: Pubkey` |
| `BatchSettled` | `batch_id: u64, total: u64, count: u8` |

### 4.5 Errors

`InvalidAmount`, `AmountNotWholeCents`, `DepositTooLarge`, `InvalidPubkey`, `WrongMint`, `WrongVaultAccount`, `Unauthorized`, `BadBatchId`, `TooManyPayouts`, `EmptyBatch`, `DuplicateProvider`, `ProviderMismatch`, `ProviderInactive`, `PayoutAccountMismatch`, `MathOverflow`.

`ProviderInactive` is unreachable in the MVP (no deactivate instruction yet); keep the check for later.

## 5. Mint HTTP API

Base URL `MINT_URL`. JSON bodies. Errors use the Cashu shape `{"detail": string, "code": number}` with HTTP 400, using [standard codes](https://github.com/cashubtc/nuts/blob/main/error_codes.md) where they fit and `7xxxx` for Blindfold codes.

### 5.1 Info, keys (standard)

| Endpoint | Spec | Notes |
|---|---|---|
| `GET /v1/info` | [NUT-06](https://cashubtc.github.io/nuts/06) | `nuts`: `4` with method `solana-usdc`, unit `usd`, `min_amount: 1`, `max_amount: 5000`; `5` disabled; `7`, `10`, `11`, `12`, `20` `{"supported": true}` |
| `GET /v1/keys`, `GET /v1/keys/{keyset_id}` | NUT-01 | |
| `GET /v1/keysets` | NUT-02 | Lists **all** keysets, including inactive ones. The mint signs only with the active keyset; redeem accepts any known `usd` keyset |
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

`amount_paid` is the sum, in cents, of all `DepositRecord`s whose `deposit_ref` matches, even if it differs from `amount`. `expiry` limits payment only; a paid quote can be minted after expiry.

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
[ { "provider_id": 0, "pubkey": "<hex33>", "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5, "active": true } ]
```

`provider_id`, `pubkey` and `active` come from `ProviderRecord` accounts. `name`, `url` and `price_cents` (advisory list price, used by the owner to plan denominations) come from `config/providers.json`:

```json
[ { "provider_id": 0, "name": "mock-api", "url": "http://localhost:4000", "price_cents": 5 } ]
```

A registered provider missing from the file is listed with `name: null, url: null, price_cents: null`. Used by the owner CLI to build the allowlist and by the agent to find APIs.

### 5.6 Redeem [BF]

`POST /v1/blindfold/redeem`, called by providers.

```json
{ "proofs": [ /* Proof[], each with witness = "{\"signatures\":[\"<schnorr sig hex>\"]}" */ ] }
```

The signature is the provider's NUT-11 signature over the proof's `secret` string, made with the provider's Cashu key (`cashu-ts` `signP2PKProofs`).

`200`: `{ "provider_id": 0, "amount": 5, "redemption_id": "<uuid>" }`

The mint, in order:

| # | Check | Error |
|---|---|---|
| 1 | `1 <= proofs.length <= 64`, no duplicate `secret` | `11014`, `11007` |
| 2 | Keyset known, unit `usd` | `12001` |
| 3 | `C` valid for `secret` and amount | `10001` |
| 4 | Secret is NUT-10 `P2PK`, well formed per NUT-11, only the tags `pubkeys`, `n_sigs` (= 1), `sigflag` (= `SIG_INPUTS`) present. Any `locktime` or `refund` tag is rejected in the MVP | `70001` |
| 5 | Exactly one signer-set key produced a valid signature in `witness` | `10001` |
| 6 | That key is the `cashu_pubkey` of an active registered provider | `70002` |
| 7 | All proofs in the request were signed by the same provider | `70003` |
| 8 | In **one DB transaction**: insert every `Y` into the spent set (unique), add `sum(amount)` to that provider's balance, insert the redemption row. Any `Y` already present aborts the whole transaction | `11001` |

The credited provider is the one whose key signed, never one named in the request.

### 5.7 Admin

Header `Authorization: Bearer <MINT_ADMIN_TOKEN>`. `401` otherwise.

| Endpoint | Response |
|---|---|
| `GET /v1/blindfold/admin/balances` | `[{ "provider_id": 0, "balance": 15 }]` (cents, unsettled) |
| `POST /v1/blindfold/admin/settle` | Runs one settlement now (at most 8 providers, largest balances first; the rest wait for the next run). `{ "batch_id": 1, "payouts": [{ "provider_id": 0, "amount": 15 }], "tx": "<signature>" }` or `{ "batch_id": null }` if no balances |
| `GET /v1/blindfold/admin/reconcile` | `{ "vault_balance": c, "deposited": c, "issued": c, "redeemed": c, "settled": c }` (all cents). Lets tests check `vault_balance == deposited - settled` |

## 6. Deposit detection (MVP: polling)

The mint reads vault **account state**, not transaction logs or raw instructions. (V12 Critical 2: a facilitator was fooled by parsing an `ApproveChecked` as a `TransferChecked`. Account state written by our own program after a successful `transfer_checked` can't be faked that way.)

Every `DEPOSIT_POLL_MS`, at `confirmed` commitment:

1. Read `Config.deposit_count`.
2. For each index from the stored cursor up to `deposit_count - 1`, fetch `DepositRecord` at `["deposit", index]`. Check the account owner is the vault program.
3. In one DB transaction per record: insert the deposit (unique on `index`), find the quote whose `request == deposit_ref`, add `amount / 10_000` to its `amount_paid`, bump `updated_at`, advance the cursor.
4. A deposit with no matching quote is stored as unmatched. (Refunds are deferred.)

Later, the QuickNode Stream add-on posts to an internal webhook that triggers the same poll immediately. No other code changes.

## 7. HTTP 402 handshake (NUT-24)

Per [NUT-24](https://cashubtc.github.io/nuts/24) with a [NUT-18](https://cashubtc.github.io/nuts/18) payment request.

### 7.1 Server: payment required

```
HTTP/1.1 402 Payment Required
X-Cashu: creqA...
Content-Type: application/json

{ "error": "payment_required", "amount": 5, "unit": "usd" }
```

Decoded request:

```json
{ "a": 5, "u": "usd", "m": ["http://localhost:3338"], "nut10": { "k": "P2PK", "d": "<provider pubkey hex33>" } }
```

Build with `cashu-ts` `PaymentRequest` and encode as `creqA`. Wallets must decode both `creqA` and `creqB` (`decodePaymentRequest` handles both).

### 7.2 Client: paid retry

Same method, URL and body, plus `X-Cashu: cashuB...` holding proofs that:

| Rule | Source |
|---|---|
| Come from a mint in `m`, unit `u` | NUT-24 |
| Sum to **exactly** `a` | **[BF]** NUT-24 allows `>= a`, but Blindfold has no change, so overpayment is lost. The wallet must send an exact sum |
| Each have `nut10.d` in their signer set (§3.3) | **[BF]** NUT-24 expects the lock to match `nut10`. A 1-of-N lock that includes `d` counts as a match |
| Carry no witness | The provider adds its signature |

### 7.3 Server: result

| Case | Status |
|---|---|
| Redeemed, data served | `200` with the data |
| Client error, token not redeemed | `400` `{ "error": "<reason>" }`, reason one of `malformed_token`, `wrong_mint`, `wrong_unit`, `wrong_amount` (sum `!= a`), `wrong_lock` (provider key not in signer set), `unexpected_witness` |
| Mint rejected redemption (spent, invalid) | `400` `{ "error": "redeem_failed", "code": <mint code> }` |
| Mint unreachable or `5xx` | `502` `{ "error": "mint_unavailable" }` |

### 7.4 Client: after a failed retry

On any non-2xx paid retry, the wallet calls `POST /v1/checkstate` for the proofs it sent. `UNSPENT` proofs go back into the wallet; `SPENT` proofs are dropped. This also covers a lost `200`.

### 7.5 Mock API paid endpoint

`GET /v1/data/:topic`, priced at `PRICE_CENTS`. `200` body:

```json
{ "topic": "sol", "price": 172.4, "change_24h_pct": -1.2, "volume_24h": 123456789, "whale_netflow": 42000, "as_of": 1763166400 }
```

Fake, deterministic per topic. `GET /health` is free.

## 8. Shared TypeScript package: `packages/protocol`

Built **first**, before the components, by whoever starts. Every TS component imports it.

| Export | Contents |
|---|---|
| `constants` | Everything in §2 |
| `types` | Re-exports `Proof`, `BlindedMessage`, etc. from `cashu-ts`; `TokenFile`, `ProviderInfo`, `RedeemRequest/Response`, `MintQuoteSolanaUsdcRequest/Response`, error code enum (§5) |
| `lock` | `buildLockOptions(allowlist: string[]): P2PKOptions` (sorted, §3.3); `signerSet(secret: string): string[]` |
| `paymentRequest` | `buildPaymentRequest({amount, mintUrl, providerPubkey}): string` (`creqA`); `parsePaymentRequest(header): {amount, unit, mints, providerPubkey}` |
| `units` | `centsToBaseUnits`, `baseUnitsToCents` (throws if not whole cents) |
| `vault` | PDA helpers (`configPda`, `depositPda(index)`, `providerPda(id)`, `vaultAta`), account decoders and instruction builders from the Anchor IDL (`@anchor-lang/core`) |
| `env` | Zod-validated loader for §9 |

The IDL is copied from `target/idl/vault.json` after `anchor build`. Until the vault exists, `vault` exports a hand-written IDL matching §4.

### 8.1 Wallet SDK surface (`packages/wallet`)

What the agent and other callers may rely on. Details in `04-wallet-sdk.md`.

```ts
class AgentWallet {
  static open(opts?: { tokenFile?: string; maxPerCallCents?: number; allowlist?: string[]; fetch?: typeof fetch }): Promise<AgentWallet>;
  balance(): number;          // spendable cents (excludes pending)
  payFetch(url: string | URL, init?: RequestInit): Promise<Response>; // fetch-compatible
}
class PaymentRefused extends Error { reason: RefusalReason }  // thrown before any proof leaves the wallet
class PaymentFailed extends Error { status: number }          // paid retry returned non-2xx (after checkstate recovery)
```

`payFetch` returns non-402 responses unchanged and never throws for them. `RefusalReason` includes `provider_not_allowed`, `provider_not_in_signer_set`, `over_cap`, `insufficient_balance`, `insufficient_exact`, `unit`, `mint`, `bad_request`, `amount_mismatch`.

## 9. Repo layout and configuration

pnpm workspace, TypeScript (ESM, Node 22+), Anchor workspace at the repo root.

```
Anchor.toml
programs/vault/        01: Anchor program
services/mint/         02: mint server
apps/mock-api/         03: mock paid API
packages/protocol/     00: shared TS contract code
packages/wallet/       04: wallet SDK + owner CLI
agents/simple/         05: simple agent
config/providers.json  provider_id → name, url
scripts/               devnet setup (initialize, register provider), e2e test
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
| `PROVIDER_SECRET_KEY` (secp256k1 hex), `PROVIDER_ID`, `PRICE_CENTS` (5), `PORT` (4000) | mock API |
| `OWNER_KEYPAIR` (path) | owner CLI |
| `TOKEN_FILE`, `MAX_PER_CALL_CENTS` (10), `WALLET_ALLOWLIST` (comma list of provider pubkeys; default: union of the proofs' signer sets) | wallet SDK, agent |

**Test networks:** unit tests run against `solana-test-validator` (or LiteSVM) with a locally created 6-decimal SPL mint standing in for USDC. The demo runs on devnet with Circle devnet USDC from faucet.circle.com.

## 10. End-to-end acceptance (MVP done)

`scripts/e2e.ts` on devnet:

1. Owner CLI: quote $1.00 (100 cents), deposit, wait until `amount_paid == 100`, mint tokens locked to the mock API's key, write the token file.
2. Agent: one paid call to the mock API through the wallet SDK. Gets `402`, retries, gets `200` with data. Token file balance drops by `PRICE_CENTS`.
3. Replay: resend the same `cashuB` to the mock API. Gets `400` with mint code `11001`.
4. `POST /v1/blindfold/admin/settle`. The provider's payout account receives `PRICE_CENTS * 10_000` base units of USDC on devnet.
5. `GET /v1/blindfold/admin/reconcile`: `vault_balance == deposited - settled`.
