# 01: Vault program

## 1. Purpose

The Anchor program that custodies deposited USDC and pays registered providers in batches when the mint authority signs. It validates deposit and payout account relationships and amounts. The mint still controls settlement amounts, and deployment authorities remain trusted.

## 2. Depends on / used by

| Item | Ref |
|---|---|
| Implements accounts `Config`, `DepositRecord`, `ProviderRecord`, vault ATA | 00 §4.1 |
| Implements `Payout` | 00 §4.2 |
| Implements instructions `initialize`, `deposit`, `register_provider`, `deactivate_provider`, `settle_batch` | 00 §4.3 |
| Emits `DepositMade`, `ProviderRegistered`, `ProviderDeactivated`, `BatchSettled` | 00 §4.4 |
| Returns the error enum | 00 §4.5 |
| Constants `BASE_UNITS_PER_CENT`, `MAX_DEPOSIT_CENTS`, `MAX_PAYOUTS_PER_BATCH` | 00 §2 |
| Calls | Token program only (`transfer_checked`, ATA creation) |
| Used by | 02 mint (reads `Config`, `DepositRecord`, `ProviderRecord`; sends `settle_batch`), 04 wallet/owner CLI (`deposit`), `scripts/` (`initialize`, `register_provider`), `packages/protocol` `vault` module (IDL from `target/idl/vault.json`) |

## 3. MVP scope

- All five instructions, four events, all 15 errors, exactly as in 00 §4.
- Configured classic SPL mint (six-decimal USDC in the intended deployment), classic SPL Token program (`anchor_spl::token`, `transfer_checked`). `initialize` rejects a `usdc_mint` not owned by the SPL Token program, so Token-2022 mints are rejected.
- Tests on a local validator or LiteSVM with a 6-decimal fake USDC mint, then a devnet deployment with Circle devnet USDC.
- The Anchor IDL is the deliverable consumed by `packages/protocol`.

## 4. Out of scope

Later add-ons, not specified here:

- Issuance log (onchain blinded values) and the reconciliation view
- Refunds of unmatched or unminted deposits
- Hidden provider revenue and fresh payout addresses (this would remove the "only registered providers" guarantee in §5.5)
- Provider reactivation (`deactivate_provider` is one way; register a new record instead)
- Admin and mint authority rotation
- Per-window outflow cap
- Token-2022 and its extensions (transfer fees, hooks, confidential transfers): not supported, `initialize` rejects any mint not owned by the SPL Token program

## 5. Design

### 5.1 Data model

Anchor discriminator is 8 bytes on every account. Field sizes: `Pubkey` 32, `u64`/`i64` 8, `u32` 4, `u8`/`bool` 1.

| Account | Math | Bytes |
|---|---|---|
| `Config` | 8 + 4x32 (`admin`, `mint_authority`, `usdc_mint`, `vault_token`) + 8 (`max_deposit`) + 8 (`deposit_count`) + 4 (`provider_count`) + 8 (`last_batch_id`) + 1 (`bump`) = 165 | **165** |
| `DepositRecord` | 8 + 8 (`index`) + 32 (`depositor`) + 8 (`amount`) + 32 (`deposit_ref`) + 8 (`slot`) + 8 (`timestamp`) + 1 (`bump`) = 105 | **105** |
| `ProviderRecord` | 8 + 4 (`provider_id`) + 33 (`cashu_pubkey`) + 32 (`payout_token`) + 1 (`active`) + 1 (`bump`) = 79 | **79** |

Use `#[derive(InitSpace)]` and `space = 8 + Config::INIT_SPACE`, and assert the numbers above in a test. There is no reserved padding (00 §4.1): on devnet we redeploy instead of migrating.

### 5.2 PDA and signer seeds

| PDA | Seeds | Bump stored |
|---|---|---|
| `Config` | `[b"config"]` | `Config.bump` |
| `DepositRecord` | `[b"deposit", index.to_le_bytes()]` (u64, 8 bytes) | `bump` |
| `ProviderRecord` | `[b"provider", id.to_le_bytes()]` (u32, 4 bytes) | `bump` |

The vault ATA is `get_associated_token_address_with_program_id(config, usdc_mint, token_program)`. Its authority is the `Config` PDA, so the only way USDC leaves is a CPI signed by `Config`:

```rust
let signer_seeds: &[&[&[u8]]] = &[&[b"config", &[config.bump]]];
// CpiContext::new_with_signer(token_program, TransferChecked { from: vault_token,
//   mint: usdc_mint, to: payout_token, authority: config }, signer_seeds)
// token::transfer_checked(ctx, amount, usdc_mint.decimals)
```

Read the bump from the stored `Config.bump`, not by re-deriving it. In `settle_batch`, `config` is a `Account<Config>` and must be `mut`; take its `AccountInfo` for the CPI authority before mutating fields, or copy `bump` and `last_batch_id` first to avoid borrow conflicts.

### 5.3 Key logic per instruction

**`initialize(mint_authority, max_deposit)`**
1. `config` is `init` with seeds `[b"config"]`, payer `admin`.
2. `vault_token` is a writable `UncheckedAccount` constrained to the expected ATA of `config` and `usdc_mint`. The handler creates it through an associated-token-program CPI after mint-owner validation.
3. `usdc_mint` is an `UncheckedAccount` with an explicit owner constraint, and `token_program` is `Program<Token>`. Constraint on `usdc_mint`: `*usdc_mint.to_account_info().owner == token::ID` (`WrongMint` otherwise), so a Token-2022 mint is rejected even if the account types are loosened later.
4. Set `admin = admin.key()`, `mint_authority`, `usdc_mint`, `vault_token = vault_token.key()`, `max_deposit`, counts to 0, `bump = ctx.bumps.config`.
5. `max_deposit` must be greater than 0 (else `InvalidAmount`). The deploy script passes `MAX_DEPOSIT_CENTS * 10_000 = 50_000_000`.

**`deposit(amount, deposit_ref)`**
1. `amount > 0` else `InvalidAmount`; `amount % 10_000 == 0` else `AmountNotWholeCents`; `amount <= config.max_deposit` else `DepositTooLarge`.
2. `deposit_record` seeds use `config.deposit_count.to_le_bytes()` (Anchor allows `seeds = [b"deposit", config.deposit_count.to_le_bytes().as_ref()]` because `config` is declared earlier in the struct).
3. `transfer_checked(depositor_token -> vault_token, amount, decimals)`, authority `depositor`.
4. Write record: `index = deposit_count`, `slot = Clock::get()?.slot`, `timestamp = Clock::get()?.unix_timestamp`.
5. `deposit_count = deposit_count.checked_add(1).ok_or(MathOverflow)?`. Emit `DepositMade`.

**`register_provider(cashu_pubkey, payout_token)`**
1. `admin` must equal `config.admin` (`has_one = admin @ Unauthorized`).
2. `cashu_pubkey[0]` is 2 or 3 else `InvalidPubkey`. This is a prefix check only, not a curve check (see Open questions).
3. `payout_token_account` is `Account<TokenAccount>`, `key() == payout_token`, `mint == config.usdc_mint` else `WrongMint` (`usdc_mint` is not in this instruction's account list, so compare against `config`).
4. Write record with `active = true`; `provider_count` checked add; emit `ProviderRegistered`.
5. No uniqueness check on `cashu_pubkey` or `payout_token` in the MVP (admin-only; the mint rejects duplicate active keys; deactivate the old record before re-registering a key. Old balances stay attached to the old ID).

**`deactivate_provider(provider_id)`**
1. `admin` must equal `config.admin` (`has_one = admin @ Unauthorized`).
2. `provider_record` is `mut` with seeds `[b"provider", provider_id.to_le_bytes()]`; a wrong or missing record fails the seed check.
3. Set `active = false` and emit `ProviderDeactivated { provider_id }`. Idempotent: deactivating an already inactive provider succeeds as a no-op and emits no event. No reactivation.

**`settle_batch(batch_id, payouts)`**
1. `mint_authority.key() == config.mint_authority` else `Unauthorized`. `usdc_mint.key() == config.usdc_mint` else `WrongMint`; `vault_token.key() == config.vault_token` else `WrongVaultAccount`.
2. `payouts.len() >= 1` else `EmptyBatch`; `<= 8` else `TooManyPayouts`.
3. `batch_id == config.last_batch_id + 1` (checked add) else `BadBatchId`.
4. `remaining_accounts.len() == 2 * payouts.len()` else `ProviderMismatch`.
5. For each payout `i` with `provider_record = remaining[2i]`, `payout_token = remaining[2i+1]`:
   - `amount > 0` else `InvalidAmount`; `amount % 10_000 == 0` else `AmountNotWholeCents`
   - `provider_id` not seen earlier in this batch else `DuplicateProvider`
   - `provider_record.owner == program_id`, then deserialize as `ProviderRecord` (`Account::try_from`); a failure maps to `ProviderMismatch`
   - Recompute `find_program_address([b"provider", provider_id.to_le_bytes()], program_id)` and require it equals `provider_record.key()` else `ProviderMismatch`
   - `provider_record.active` else `ProviderInactive`
   - `payout_token.key() == provider_record.payout_token` else `PayoutAccountMismatch`
   - `payout_token` is deserialized as `Account<TokenAccount>` with `mint == usdc_mint` else `WrongMint`, and is writable
   - `total = total.checked_add(amount).ok_or(MathOverflow)?`
   - `transfer_checked(vault_token -> payout_token, amount)` signed by `Config`
6. Set `last_batch_id = batch_id`, emit `BatchSettled { batch_id, total, count: payouts.len() as u8 }`.

Do all validation in a first loop and all transfers in a second, so that no CPI runs before every check passed (a failed tx reverts anyway, but this keeps the logic reviewable).

### 5.4 Errors

| Error | Raised when |
|---|---|
| `InvalidAmount` | deposit amount 0; payout amount 0; `max_deposit` 0 |
| `AmountNotWholeCents` | deposit or payout not a multiple of 10_000 |
| `DepositTooLarge` | deposit above `max_deposit` |
| `InvalidPubkey` | `cashu_pubkey[0]` not 2 or 3 |
| `WrongMint` | mint account or any token account's mint differs from `config.usdc_mint` |
| `WrongVaultAccount` | `vault_token` is not `config.vault_token` in `settle_batch` |
| `Unauthorized` | signer is not `admin` (register, deactivate) or `mint_authority` (settle) |
| `BadBatchId` | `batch_id != last_batch_id + 1` |
| `TooManyPayouts` / `EmptyBatch` | more than 8 / 0 payouts |
| `DuplicateProvider` | same `provider_id` twice in one batch |
| `ProviderMismatch` | wrong remaining-account count, wrong owner, wrong PDA, undecodable record |
| `ProviderInactive` | `active == false` in `settle_batch` |
| `PayoutAccountMismatch` | passed payout account differs from the registered one |
| `MathOverflow` | any `checked_*` failure |

Not in the enum, left to the token program: insufficient vault balance in `settle_batch`, insufficient depositor balance, depositor token account not owned by the depositor.

### 5.5 Security checks

| Risk | Control |
|---|---|
| Fake or foreign vault token account | `vault_token` constrained to `address = config.vault_token` in `deposit` and `settle_batch` |
| Wrong mint | `usdc_mint` constrained to `config.usdc_mint`; `transfer_checked` re-verifies mint and decimals; depositor token account `mint == config.usdc_mint` |
| Wrong token program | `Program<Token>` (classic SPL Token only); `initialize` rejects a mint not owned by it; `transfer_checked` CPI fails if the program does not own the accounts |
| Fake `Config` | Anchor `Account<Config>` checks owner and discriminator; seeds fix the address |
| Fake `ProviderRecord` in `remaining_accounts` | Owner check, discriminator (via `try_from`) and PDA recompute from `provider_id`. Without these an attacker-built account could redirect funds |
| Redirected payout | Payout token account must equal the address stored at registration by the admin |
| Replay or double pay | See below |
| Overflow | `checked_add` on counters, batch id and totals; no unchecked casts (`count` cast is safe as len <= 8) |
| Reentrancy | Only CPI is to the token program; state (`last_batch_id`) is written before transfers or, equally safe, in the same tx |
| Arbitrary signer | `mint_authority` and `admin` compared against `Config` fields, not just `Signer` |
| Unauthorized `initialize` | Anyone can call it once (the PDA is a singleton, the first caller becomes admin). Initialize immediately after deployment. Deployment and initialization are separate; no script makes them atomic. Upgrade authority is not checked |

Two deposits built against the same `deposit_count` collide on the `DepositRecord` seed; the second fails and the client rebuilds it with the new count and resends.

**Why `batch_id` gives idempotency:** each batch must carry exactly `last_batch_id + 1`, and success increments it in the same transaction as the transfers. If the mint resends a batch after a timeout, either the first copy landed (retry fails with `BadBatchId`, nothing paid twice) or it did not (retry succeeds). The mint must persist its planned batch (id and payouts) before sending, and on `BadBatchId` read `Config.last_batch_id` to learn whether its batch landed.

**Why the mint authority can only pay registered providers:** a payout recipient is never chosen by the caller. The caller passes a `provider_id`; the program derives the `ProviderRecord` PDA, which only `register_provider` (admin-signed) can create, and pays only the `payout_token` stored in it. A compromised mint key can still drain the vault to registered providers' addresses (and to nobody else), and can inflate amounts: custodial trust in the mint remains, as in 00 / design.md.

## 6. File layout

```
Anchor.toml                         (repo root; [programs.localnet|devnet] vault = <id>, [provider] cluster, wallet)
Cargo.toml                          (workspace, members = ["programs/*"])
programs/vault/Cargo.toml           (anchor-lang 1.2.2; anchor-spl 1.2.2 features token, associated_token; idl-build)
programs/vault/src/lib.rs           declare_id!, #[program] with five thin handlers
programs/vault/src/state.rs         Config, DepositRecord, ProviderRecord, Payout, constants
programs/vault/src/errors.rs        VaultError (the 15 variants, in the 00 §4.5 order)
programs/vault/src/events.rs        DepositMade, ProviderRegistered, ProviderDeactivated, BatchSettled
programs/vault/src/instructions/    mod.rs, initialize.rs, deposit.rs, register_provider.rs, deactivate_provider.rs, settle_batch.rs
programs/vault/tests/vault.rs       Rust LiteSVM tests (requires target/deploy/vault.so)
scripts/devnet/initialize.ts        initialize vault
scripts/devnet/register-provider.ts register provider
scripts/devnet/deactivate-provider.ts deactivate provider
```

Keep `anchor-lang` and `anchor-spl` on the same version (1.2.2). Constants (`BASE_UNITS_PER_CENT = 10_000`, `MAX_PAYOUTS_PER_BATCH = 8`) live in `state.rs`.

## 7. Stubs and local testing

Nothing else needs to exist. The vault is testable alone.

| Need | How |
|---|---|
| Fake USDC | Rust tests use `litesvm-token` to create a six-decimal classic mint, fund accounts and test Token-2022 rejection |
| Runner | `anchor build`, then `cargo test --locked -p vault`: Rust LiteSVM tests load `target/deploy/vault.so`. No TypeScript/Mocha vault suite is configured |
| Keypairs | Generate test keypairs and fund them through LiteSVM |
| Provider payout | Create a token account for the fake mint owned by a throwaway keypair |
| Devnet script | `scripts/devnet/initialize.ts` reads `ADMIN_KEYPAIR`, `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID`, `USDC_MINT` and `MINT_AUTHORITY` (public key, defaults to admin), and skips initialization if Config exists. `register-provider.ts <cashu-pubkey> <payout-token-account>` registers a provider separately |
| Devnet USDC | Open faucet.circle.com, choose Solana and Devnet, USDC, paste the depositor wallet address. Needs devnet SOL too (`solana airdrop 2` or the Solana faucet). Provider payout token account: `spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --owner <provider>` |
| Mint stub | The test's `mint_auth` keypair sends `settle_batch` directly |
| IDL hand-off | After `anchor build`, compare `target/idl/vault.json` with `packages/protocol/src/idl.ts` and update the checked-in IDL when interfaces change (00 §8) |

## 8. Done when

Local (all must pass, each failure asserts the exact error name from 00 §4.5):

| Test | Expect |
|---|---|
| `initialize` | `Config` fields correct, vault ATA exists with authority `Config`, sizes match §5.1 |
| `deposit` happy path | 1 USDC (1_000_000) moves to the vault, record 0 correct (`depositor`, `deposit_ref`, `slot`), `deposit_count == 1`, `DepositMade` emitted; second deposit gets index 1 |
| `deposit` amount 0 | `InvalidAmount` |
| `deposit` 1_000_001 | `AmountNotWholeCents` |
| `deposit` above max (50_010_000) and exactly max (50_000_000) | `DepositTooLarge`, then success |
| `deposit` with other mint | `WrongMint` (or the constraint error; document which) |
| Two deposits built against the same `deposit_count` | second fails on the seed; rebuilt with the new count it succeeds |
| `register_provider` happy path | id 0, then id 1; `active`, `provider_count` correct, event emitted |
| `register_provider` non-admin | `Unauthorized` |
| `register_provider` pubkey prefix `0x04` | `InvalidPubkey` |
| `register_provider` payout account of another mint | `WrongMint` |
| `deactivate_provider` happy path | `active == false`, `ProviderDeactivated` emitted, other providers untouched |
| `deactivate_provider` non-admin | `Unauthorized` |
| `deactivate_provider` twice | second call succeeds as a no-op, no second event |
| `settle_batch` happy path | batch 1 with 2 payouts: balances move, `last_batch_id == 1`, `BatchSettled.total` correct |
| `settle_batch` 8 payouts | succeeds and fits in one tx (fixes the `MAX_PAYOUTS_PER_BATCH` assumption) |
| Replay batch 1 | `BadBatchId`; batch 3 after 1 also `BadBatchId`; balances unchanged |
| 9 payouts / 0 payouts | `TooManyPayouts` / `EmptyBatch` |
| Non-mint-authority signer | `Unauthorized` |
| Payout amount 0 | `InvalidAmount` |
| Payout amount 1_000_001 | `AmountNotWholeCents` |
| Same `provider_id` twice in a batch | `DuplicateProvider` |
| Wrong `vault_token` account | `WrongVaultAccount` |
| Payout token account not the registered one | `PayoutAccountMismatch` |
| `provider_record` for a different id than the payout's | `ProviderMismatch` |
| `provider_record` that is not a program account (for example a `DepositRecord` or system account) | `ProviderMismatch` |
| Odd `remaining_accounts` count | `ProviderMismatch` |
| Deactivate a provider, then settle a payout to it | `ProviderInactive`, balances unchanged |
| Overflow: two payouts summing past `u64::MAX` | `MathOverflow` (runs before transfers; vault balance irrelevant) |
| Vault short of funds | token program error, `last_batch_id` unchanged |
| `initialize` with a Token-2022 mint | `WrongMint` (rejected before any account is created) |

Devnet:

1. `anchor deploy --provider.cluster devnet`; program id in `.env.example` and `Anchor.toml`.
2. `scripts/devnet/initialize.ts` creates `Config` and vault ATA for the Circle mint; `scripts/devnet/register-provider.ts` registers a provider.
3. Deposit 1 devnet USDC from a faucet-funded wallet; `DepositRecord` 0 readable with `confirmed` commitment.
4. `settle_batch` from the mint authority key pays the provider's token account on Solana Explorer (devnet).

## 9. Open questions

1. **`cashu_pubkey` validity.** Only the 0x02/0x03 prefix is checked, so an off-curve key can be registered. The registration script validates curve membership with `ECDH.convertKey` before sending. Direct calls can bypass that offchain validation; onchain validation remains prefix-only.

## 10. Implementation notes and decisions

- **Program id:** `EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo`. The program keypair is `.keys/vault-keypair.json`, copied to `target/deploy/vault-keypair.json` for `anchor deploy`; both paths are gitignored. Keep it to upgrade at this id; otherwise run `anchor keys sync`, rebuild, then update `packages/protocol/src/idl.ts`.
- **Redeployed 2026-11-16.** The 2026-11-14 deployment (`3nVcHrZ9PC2kEPGYxvqedudeCfHXtZj1BRzwfxWqAanT`) lost its admin and mint authority keys, so it can no longer register providers, settle or be upgraded. Do not use it. Keep every key in `.keys/` with an offline backup; never deploy from a temporary directory.
- **Recorded devnet status:** deployed 2026-11-16 (slot 522942459), initialized, provider 0 registered.

| Item | Address |
|---|---|
| Program | `EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo` (upgrade authority = admin) |
| Config PDA | `mb1FNxcJ3bqyBZEA6Sxo8AUsYcThp7aVKA8GbzbX3n2` |
| Vault USDC ATA | `Bg9e9gBW5gDBqWCvV2o2YfcX4E5esER1uPrf7bj4DWuD` |
| Admin / deployer | `3LTGrCEhfZYxR6EKSE9dGthJEij65k2CSfRrE2tmvRi7` (`.keys/deployer.json`) |
| Mint authority | `88v4wTeaFJmWxThVSwj476ZbsR2BaFteR3aWGsvfzpXS` (`.keys/mint-authority.json`) |
| Provider 0 record | `5kkKoRhsaR1PhE2rV8sc98hZUAaAY6ByeT4UYkbjCZHx` |
| Provider 0 cashu pubkey | `02ecccaa03363b841d81e5f9ea3532aed78d6afd007ce9c8ccd4accdd6b206db28` (secret in `.keys/provider-secret.hex`) |
| Provider 0 payout (USDC ATA) | `GVaF8JseaBhMCKWWyTzdxW3Z3SDzSB3ZeX6AWK1WVECe` (owner `.keys/provider-payout.json`) |

`max_deposit` = 50,000,000 base units ($50).

**Devnet e2e (00 §10) passed 2026-11-16** via `pnpm --filter @blindfold/scripts e2e`: deposit `2oKFkSFeqVevKKtyi9HMY5iLkN9xHQ7WJZt9LtHAcgwcqJzSuQ9z4n9QXHvVHdX2wMxzsgAeN34zTB9JKyF8Mpcg`, settle_batch `nPKEiF8GVBENWPKYVxzTLCc9nSgyqbwmABK1Lrd16mXGK74RcMMX8EZRbR7n7gEwTLknzHrkd1SDyTUPAL7Ret9`. The run registered provider 1 with a throwaway key and deactivated it on exit. Owner `2DnMnsBJzzyHaecLX7Rmgz7E7muDDUQPs7cwTEdcxFru` (`.keys/owner.json`) holds the remaining devnet USDC. Key files are not in Git. The addresses and transaction IDs are deployment records, not proof of current access or availability.
- **Dependencies:** `anchor-spl 1.2.2` needs features `token`, `associated_token`, `token_2022`, `solana-v3`. `token_2022` is required only because anchor-spl's `idl-build` references `token_interface`; the program itself uses the classic token program only.
- **`initialize` implementation:** `vault_token` is an `UncheckedAccount` (address constrained to the ATA of `config` and `usdc_mint`, else `WrongVaultAccount`) and the ATA is created by a CPI in the handler. With an ATA `init` constraint Anchor creates the ATA before field constraints run, so a Token-2022 mint failed inside the ATA program instead of returning `WrongMint`. The account list, order and flags are unchanged from 00 §4.3.
- **Errors where 5.4 was silent:** `deposit` with a vault account that is not `config.vault_token` returns `WrongVaultAccount`; `register_provider` with `payout_token_account.key() != payout_token` returns `PayoutAccountMismatch`; a non-writable or undecodable payout account in `settle_batch` returns `PayoutAccountMismatch` / `WrongMint`. `deposit` with a foreign mint account returns `WrongMint` (the `usdc_mint` address constraint).
- **Tests:** `programs/vault/tests/vault.rs`, 34 LiteSVM tests (`litesvm 0.15`, `litesvm-token =0.15.2`; 0.18.x needs a newer Rust than the pinned 1.89). `anchor build` first, then `cargo test --locked -p vault`. The Rust suite loads the SBF artifact; the default TypeScript suite does not run it.
- **IDL:** the generated IDL lists instructions alphabetically and adds `pda`, `relations` and `docs` metadata; keep names, arg types, account order and writable/signer flags aligned with the checked-in TypeScript IDL.
