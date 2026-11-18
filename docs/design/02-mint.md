# 02: Mint server

`services/mint/` implements the [HTTP contract](00-interfaces.md#5-mint-http-api). It issues blind-signed tokens against vault deposits, redeems provider-signed proofs and pays provider balances from the vault. [Runbook](../RUNNING.md).

## 1. Dependencies and configuration

Node 22+, PostgreSQL, `@cashu/cashu-ts` 4.13.1 and the shared protocol package. Solana adapters use web3.js 1.x. Build workspace dependencies before starting the service.

Required settings: `DATABASE_URL`, `MINT_SEED` (32-byte hex), `MINT_AUTHORITY_KEYPAIR` and `MINT_ADMIN_TOKEN`. Protocol defaults supply `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID`, `USDC_MINT`, `MINT_URL` and port 3338; real deployments must verify those values match their vault. The authority key must match `Config.mint_authority` and have SOL for settlement fees.

Optional settings: `PROVIDERS_FILE`, `DEPOSIT_POLL_MS` (2000), `SETTLE_INTERVAL_S` (600), `SETTLE_HOLD_S` (defaults to the interval), `SETTLE_UNIT_CENTS` (10), `ISSUANCE_LOG_MS` (5000), and `MINT_DEV_FAKE_CHAIN=1`. Provider metadata is read at boot from `config/providers.json` unless overridden.

## 2. Supported scope

One seed-derived active `usd` keyset, denominations 1, 2, 4, …, 4096 cents, zero input fee. Boot rejects a seed inconsistent with the stored active keyset. Public key listings can contain inactive keysets, but only the active seed's private keys are loaded; key rotation and redemption of historical keys are not supported.

Supported Cashu pieces: keys/keysets, signed quotes, minting with DLEQ, restricted P2PK redemption and checkstate. No swap, melt, refunds or Temporal. A QuickNode Stream can trigger a deposit poll (never a credit), and the mint publishes cumulative issuance to the vault's onchain issuance log.

`createBlindSignature` and `createDLEQProof` are non-constant-time library helpers. Do not treat this implementation as a production signer.

## 3. Boot and jobs

`loadConfig` validates environment and provider metadata. `createMint` runs migrations, loads the keyset and syncs providers. `start()` installs non-overlapping timers for deposit polling, provider sync (30 seconds), settlement and issuance logging when supported; `start(["settlement"])` starts only the named jobs. `index.ts` then serves the Hono app. The Solana reader rejects a Config whose mint or vault account disagrees with the configured deployment, so mismatched backing cannot silently reach issuance.

Jobs log errors and try again on later ticks. Deposit polling and provider sync are relative to process startup. Settlement runs at UTC multiples of `SETTLE_INTERVAL_S`, so every deployment with the same interval settles at the same wall-clock moments ([settlement privacy](#46-settlement-privacy)). `createMint` also returns the app and context for in-process tests.

## 4. Data and transaction boundaries

The schema starts at [`migrations/001_init.sql`](../../services/mint/migrations/001_init.sql); [`002_active_provider_keys.sql`](../../services/mint/migrations/002_active_provider_keys.sql) replaces global key uniqueness with an active-only unique index. Migrations run automatically at boot. Amounts are integer cents unless a field is named `*_base`.

| Tables | Purpose and invariant |
|---|---|
| `keysets` | Public keys and active flag; private keys are derived in memory |
| `mint_quotes` | Quote key, deposit reference, payment and issuance totals; issued cannot exceed paid |
| `deposits`, `deposit_cursor` | Unique deposit index and next unread index; credit and cursor advance commit together |
| `issued_signatures` | Unique `b_`, quote/request IDs, output sequence, amount, `c_` and DLEQ; supports identical-response replay |
| `providers`, `provider_balances` | Cached registry plus metadata; provider pubkey unique among active rows, and nonnegative unsettled balances |
| `spent_proofs`, `redemptions` | Unique `y`; proof spending and provider credit commit together |
| `settlements` | Batch ID, status, payouts, transaction signature, last-valid block height and error. Partial unique batch ID excludes failed attempts |
| `issuance_log_state` | Logged issuance and at most one pending log transaction. See [issuance log](#issuance-log) |

### 4.1 Deposit polling

Read the vault-owned `Config` and fetch deposit records in chunks of 50. Stop at a temporarily missing record; throw on a foreign owner or inconsistent index. Per record, lock the cursor, insert the deposit, credit the matching quote only if the insertion is new, and advance the cursor in one transaction. Unmatched deposits remain stored; no refund path exists.

The poller uses `confirmed` commitment. A rollback after crediting is a prototype risk. The advertised quote `expiry` is not enforced by the poller: a matching late deposit is still credited. It is not an expiry/refund guarantee.

### 4.2 Provider sync

Read records `0..provider_count-1` and upsert keys, payout accounts and active flags. Merge display metadata by provider ID. Missing metadata gives null name/URL/price and empty topics. An active-only unique index rejects two active records for one key. Once the old record is deactivated, the same key can be registered at a new ID without blocking later records from syncing.

Redemption checks this cache, so deactivation takes effect after sync, not immediately when the onchain transaction lands. Admin settlement forces a sync first.

### 4.3 Blind signing

Lock the quote row and verify NUT-20 before signing. Reject unpaid/unknown quotes, more than 256 outputs, duplicates, reused outputs, excess amount, unknown/inactive keysets or unsupported denominations. Sign with DLEQ and store signatures with the issuance increment in one transaction.

A replay must match one previous request's complete output set for the same quote. It returns stored signatures without increasing issuance. Partial overlap is rejected. Persisted owner outputs allow recovery from a lost mint response.

### 4.4 Redemption

Accept 1–64 proofs. Validate amounts, mint signatures, lock shape and exactly one valid signer per proof. Only `pubkeys`, `n_sigs=1` and `sigflag=SIG_INPUTS` tags are accepted; duplicate tags/signers, time locks, refund keys and `SIG_ALL` are rejected. All proofs must be signed by one active registered provider.

In one transaction insert the redemption, insert each unique spent-proof `y` and credit that provider. A spent-proof conflict rolls back the entire request, including fresh proofs and credit. The recipient comes from the signature and registry, never a caller-supplied ID.

### 4.5 Settlement recovery

`runSettlement` holds advisory lock `(hashtext(current_schema()), 42)` on a dedicated connection. It recovers an open batch before creating another.

```text
pending -> submitted -> confirmed
   |           |
   +-----------+-----> failed (balances restored)
```

1. Lock positive balances of active providers and compute each payable amount ([settlement privacy](#46-settlement-privacy)). Take up to eight, largest first. Debit those amounts and persist the planned batch/payouts in one transaction. New redemptions add to the remaining balances.
2. Sign `settle_batch` with a unique memo, persist its signature and last-valid block height, and submit the signed transaction.
3. On recovery, confirm by signature. Wait while the transaction can still land. After expiry, retry if the batch ID is still available. A missing signature status after the ID advances, or a legacy pending row without a signature, requires operator reconciliation.
4. A deterministic program failure marks the attempt failed and restores balances atomically. Signature-status errors are terminal only at `confirmed` or `finalized` commitment; a `processed` error stays pending because its fork can disappear. A transient error leaves it open for recovery. Batch IDs prevent two transactions from settling the same batch. The signature identifies which writer paid.

A submitted batch may need more than one job tick or admin call to finish. HTTP 409 codes `70010` and `70011` mean a run is busy/in flight; HTTP 502 `70012` means an attempt failed and its balances were restored.

Settle outstanding balances **before** deactivating a provider. Inactive providers are excluded from new batches and cannot be reactivated. Re-registering creates a new provider ID and does not migrate the old ID's balance; the same pubkey can be used again only after the old record is inactive. There is no automatic recovery or refund of that stranded balance.

### 4.6 Settlement privacy

Provider payouts are public. Without a policy, a payout shortly after an owner's deposit links that owner to the provider, and the amount reveals the call count. Three rules weaken both links:

- **Fixed windows.** The timer fires at UTC multiples of `SETTLE_INTERVAL_S`, independent of activity and process start.
- **Hold.** A run pays `balance - (cents redeemed in the last SETTLE_HOLD_S)`. With the default hold of one window, a redemption is never paid in the window it happened.
- **Unit.** The payable amount rounds down to a multiple of `SETTLE_UNIT_CENTS`. The remainder stays in the balance for a later batch.

Admin settlement applies the same policy. `createMint` callers that omit `settleHoldS` and `settleUnitCents` get 0 and 1 (pay everything now); `loadConfig` always sets the defaults above. Debiting the payable amount, not zeroing the balance, keeps reconciliation and `outstanding` unchanged. These rules do not hide which registered provider was paid. Several providers in one batch, plus enough users, are what make that ambiguous.

### 4.7 Reserves and reconciliation

`GET /v1/blindfold/reserves` reads issuance and confirmed settlements in one repeatable-read transaction: `outstanding = issued - settled`. This includes unredeemed tokens and redeemed, unpaid balances. It is mint-reported accounting, not proof of total liabilities.

The reserve check also reads the issuance log. See [reserve check](00-interfaces.md#76-agent-reserve-check-bf).

The admin reconciliation endpoint additionally reads the vault, deposits and redemptions. It is a diagnostic assembled from separate reads, not an atomic chain/database snapshot. `vault_balance == deposited - settled` is expected in an isolated test after polling and confirmation, without direct transfers.

## 5. Source map

| Path under `services/mint/` | Responsibility |
|---|---|
| `src/index.ts`, `src/config.ts`, `src/mint.ts` | Process configuration, adapters, migration and job startup |
| `src/app.ts`, `src/db.ts`, `src/errors.ts` | Hono routing, database helpers and error handling |
| `src/crypto/` | Keysets, blind signatures, DLEQ and P2PK checks |
| `src/routes/info.ts` | Info, keys/keysets, providers, checkstate and reserves |
| `src/routes/quote.ts`, `src/routes/mint.ts`, `src/routes/redeem.ts`, `src/routes/admin.ts` | Payment and admin routes |
| `src/chain/vaultReader.ts`, `src/chain/settleSender.ts`, `src/chain/memory.ts` | Solana adapters and development fakes |
| `src/jobs/` | Polling, provider sync, settlement, issuance logging and timers |
| `test/` | PostgreSQL-backed tests and mocked Solana connections |
| `scripts/` | Local PostgreSQL helpers and mint HTTP smoke test |

## 6. Development and validation

`MINT_DEV_FAKE_CHAIN=1` mounts authenticated `/dev/deposit`, `/dev/provider` and `/dev/active` hooks and swaps in `MemoryVault`/`FakeSender`. Never enable it for real custody. Use a fresh disposable database after every fake-chain process restart: in-memory records reset while the database cursor, keysets and liabilities persist.

The mint tests create isolated PostgreSQL schemas. They cover issuance replay, concurrency, DLEQ, deposit cursor recovery, proof replay, provider status, reserves and settlement failures. `tests/integration` adds the real mock API, owner and agent with a fake chain. The separate real-vault `e2e:localnet` and devnet `e2e` runs are recorded in [vault deployment notes](01-vault.md#10-implementation-notes-and-decisions); they are not part of every mint unit-test run.

## Issuance log

`src/jobs/issuanceLog.ts` runs every `ISSUANCE_LOG_MS` (default 5000) and on `POST /v1/blindfold/admin/log-issuance`. Set the interval to zero to disable the timer. State lives in `issuance_log_state`: `logged_cents` (how much of this mint's issuance is in the log) and at most one pending transaction.

1. A pending transaction is resolved first from its signature status: confirmed moves its cents into `logged_cents`; failed or expired clears it; otherwise the run returns `pending` and sends nothing.
2. No log onchain: if a settlement is `pending` or `submitted`, return `deferred` (a batch sent before the log exists cannot add itself to it). Otherwise send `init_issuance_log(issued, confirmed settled)`.
3. A log this mint has no state for (another mint created it on the same vault): also deferred while a batch is in flight; otherwise set `logged_cents` to the confirmed payouts known to have omitted the log. Legacy rows with unknown coverage remain in the liability calculation.
4. Send `log_issuance(add = issued - logged_cents)` when positive; otherwise `unchanged`. The program adds, so two mints logging at once never overwrite each other.
5. Every transaction is signed, recorded as pending with its signature and expiry, then sent. A preflight rejection clears it; a lost response is resolved from the chain. A program without the instructions returns `unsupported`, and the timer warns once.

`SolanaSettleSender` adds the log as the trailing `settle_batch` account whenever it exists, so `settled` is advanced by the program, not reported by the mint. The sync and settlement jobs share a per-schema PostgreSQL lock. A pending initialization also defers settlement until its baseline is confirmed or the attempt expires.

## Deposit poll hints

`POST /v1/blindfold/admin/poll-deposits` runs the deposit poll now and returns `{ processed }`. The timer and hints share one in-flight poll. `pnpm demo` calls it when Copycat's QuickNode Stream delivers a `DepositMade`; `pnpm bot` does when `MINT_URL` and `MINT_ADMIN_TOKEN` are set. Crediting is unchanged: only `DepositRecord` accounts count.
