//! LiteSVM tests for the vault program. Requires `anchor build` first (loads target/deploy/vault.so).
use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    base64::Engine,
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    litesvm_token::{
        get_spl_account,
        spl_token::{self, state::Account as TokenAcc},
        CreateAccount, CreateAssociatedTokenAccount, CreateMint, MintTo,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
    vault::{Config, DepositRecord, Payout, ProviderRecord, VaultError},
};

type Res = Result<TransactionMetadata, FailedTransactionMetadata>;

const USDC: u64 = 1_000_000;
const MAX_DEPOSIT: u64 = 50_000_000;

struct Provider {
    record: Pubkey,
    token: Pubkey,
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    mint_auth: Keypair,
    depositor: Keypair,
    depositor_token: Pubkey,
    usdc: Pubkey,
    vault_token: Pubkey,
    config: Pubkey,
    providers: Vec<Provider>,
    next_deposit: u64,
}

fn pid() -> Pubkey {
    vault::id()
}
fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &pid()).0
}
fn provider_pda(id: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"provider", &id.to_le_bytes()], &pid()).0
}
fn deposit_pda(i: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"deposit", &i.to_le_bytes()], &pid()).0
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
        &Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap(),
    )
    .0
}

fn load_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/vault.so"));
    svm.add_program(pid(), bytes).unwrap();
    svm
}

fn send_with(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Res {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    svm.send_transaction(tx)
}

fn err_code(res: &Res) -> Option<u32> {
    use solana_transaction_error::TransactionError;
    match res {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, solana_instruction::error::InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
fn assert_vault_err(res: &Res, e: VaultError) {
    let want = anchor_lang::error::ERROR_CODE_OFFSET + e as u32;
    assert_eq!(
        err_code(res),
        Some(want),
        "expected {e:?} ({want}), got {:?}",
        res.as_ref().err().map(|f| (&f.err, f.meta.logs.clone()))
    );
}

fn events<T: Discriminator + AnchorDeserialize>(meta: &TransactionMetadata) -> Vec<T> {
    let mut out = vec![];
    for line in &meta.logs {
        if let Some(b64) = line.strip_prefix("Program data: ") {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            if bytes.len() >= 8 && &bytes[..8] == T::DISCRIMINATOR {
                out.push(T::deserialize(&mut &bytes[8..]).unwrap());
            }
        }
    }
    out
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acc = svm.get_account(key).expect("account missing");
    T::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

fn token_amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    get_spl_account::<TokenAcc>(svm, key).unwrap().amount
}

fn new_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
    CreateMint::new(svm, payer).decimals(6).send().unwrap()
}

fn initialize_ix(admin: &Pubkey, mint_auth: &Pubkey, usdc: &Pubkey, max_deposit: u64) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &vault::instruction::Initialize { mint_authority: *mint_auth, max_deposit }.data(),
        vault::accounts::Initialize {
            admin: *admin,
            config: config_pda(),
            usdc_mint: *usdc,
            vault_token: ata(&config_pda(), usdc),
            token_program: spl_token::ID,
            associated_token_program: Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn setup() -> Env {
    let mut svm = load_svm();
    let admin = Keypair::new();
    let mint_auth = Keypair::new();
    let depositor = Keypair::new();
    for k in [&admin, &mint_auth, &depositor] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let usdc = new_mint(&mut svm, &admin);
    let depositor_token = CreateAssociatedTokenAccount::new(&mut svm, &admin, &usdc)
        .owner(&depositor.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut svm, &admin, &usdc, &depositor_token, 1_000 * USDC).send().unwrap();
    let ix = initialize_ix(&admin.pubkey(), &mint_auth.pubkey(), &usdc, MAX_DEPOSIT);
    send_with(&mut svm, &[ix], &admin, &[]).unwrap();
    Env {
        svm,
        admin,
        mint_auth,
        depositor,
        depositor_token,
        usdc,
        vault_token: ata(&config_pda(), &usdc),
        config: config_pda(),
        providers: vec![],
        next_deposit: 0,
    }
}

impl Env {
    fn deposit_ix_full(&self, depositor: &Pubkey, dep_token: &Pubkey, mint: &Pubkey, vault_token: &Pubkey, index: u64, amount: u64, r: u8) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &vault::instruction::Deposit { amount, deposit_ref: [r; 32] }.data(),
            vault::accounts::Deposit {
                depositor: *depositor,
                config: self.config,
                deposit_record: deposit_pda(index),
                depositor_token: *dep_token,
                vault_token: *vault_token,
                usdc_mint: *mint,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn deposit(&mut self, amount: u64, r: u8) -> Res {
        let ix = self.deposit_ix_full(
            &self.depositor.pubkey(),
            &self.depositor_token,
            &self.usdc,
            &self.vault_token,
            self.next_deposit,
            amount,
            r,
        );
        let dep = self.depositor.insecure_clone();
        let res = send_with(&mut self.svm, &[ix], &dep, &[]);
        if res.is_ok() {
            self.next_deposit += 1;
        }
        res
    }

    fn register_ix(&self, admin: &Pubkey, id: u32, key: [u8; 33], payout_token: Pubkey, acct: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &vault::instruction::RegisterProvider { cashu_pubkey: key, payout_token }.data(),
            vault::accounts::RegisterProvider {
                admin: *admin,
                config: self.config,
                provider_record: provider_pda(id),
                payout_token_account: acct,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn new_payout_account(&mut self) -> Pubkey {
        let owner = Keypair::new();
        let admin = self.admin.insecure_clone();
        let usdc = self.usdc;
        CreateAccount::new(&mut self.svm, &admin, &usdc).owner(&owner.pubkey()).send().unwrap()
    }

    /// Registers the next provider with a fresh payout account; returns its id.
    fn register(&mut self) -> u32 {
        let id = self.providers.len() as u32;
        let token = self.new_payout_account();
        let mut key = [7u8; 33];
        key[0] = 2 + (id % 2) as u8;
        let ix = self.register_ix(&self.admin.pubkey(), id, key, token, token);
        let admin = self.admin.insecure_clone();
        send_with(&mut self.svm, &[ix], &admin, &[]).unwrap();
        self.providers.push(Provider { record: provider_pda(id), token });
        id
    }

    fn remaining(&self, payouts: &[Payout]) -> Vec<AccountMeta> {
        payouts
            .iter()
            .flat_map(|p| {
                let pr = &self.providers[p.provider_id as usize];
                [AccountMeta::new_readonly(pr.record, false), AccountMeta::new(pr.token, false)]
            })
            .collect()
    }

    fn settle_ix(&self, signer: &Pubkey, vault_token: &Pubkey, batch_id: u64, payouts: Vec<Payout>, remaining: Vec<AccountMeta>) -> Instruction {
        let mut metas = vault::accounts::SettleBatch {
            mint_authority: *signer,
            config: self.config,
            vault_token: *vault_token,
            usdc_mint: self.usdc,
            token_program: spl_token::ID,
        }
        .to_account_metas(None);
        metas.extend(remaining);
        Instruction::new_with_bytes(pid(), &vault::instruction::SettleBatch { batch_id, payouts }.data(), metas)
    }

    fn settle(&mut self, batch_id: u64, payouts: Vec<Payout>) -> Res {
        let rem = self.remaining(&payouts);
        let ix = self.settle_ix(&self.mint_auth.pubkey(), &self.vault_token, batch_id, payouts, rem);
        let ma = self.mint_auth.insecure_clone();
        send_with(&mut self.svm, &[ix], &ma, &[])
    }

    fn send_ix(&mut self, ix: Instruction, payer: &Keypair) -> Res {
        send_with(&mut self.svm, &[ix], payer, &[])
    }

    fn cfg(&self) -> Config {
        load(&self.svm, &self.config)
    }

    fn bal(&self, k: &Pubkey) -> u64 {
        token_amount(&self.svm, k)
    }

    fn fund_vault(&mut self, cents_usdc: u64) {
        // Use several deposits of at most max_deposit.
        let mut left = cents_usdc * USDC;
        while left > 0 {
            let a = left.min(MAX_DEPOSIT);
            self.deposit(a, 1).unwrap();
            left -= a;
        }
    }
}

fn p(provider_id: u32, amount: u64) -> Payout {
    Payout { provider_id, amount }
}

fn deactivate_ix(env: &Env, admin: &Pubkey, id: u32, record: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &vault::instruction::DeactivateProvider { provider_id: id }.data(),
        vault::accounts::DeactivateProvider { admin: *admin, config: env.config, provider_record: record }
            .to_account_metas(None),
    )
}

// ---------------------------------------------------------------- initialize

#[test]
fn initialize_sets_config_and_vault() {
    let env = setup();
    let c = env.cfg();
    assert_eq!(c.admin, env.admin.pubkey());
    assert_eq!(c.mint_authority, env.mint_auth.pubkey());
    assert_eq!(c.usdc_mint, env.usdc);
    assert_eq!(c.vault_token, env.vault_token);
    assert_eq!(c.max_deposit, MAX_DEPOSIT);
    assert_eq!((c.deposit_count, c.provider_count, c.last_batch_id), (0, 0, 0));
    assert_eq!(c.bump, Pubkey::find_program_address(&[b"config"], &pid()).1);
    let v = get_spl_account::<TokenAcc>(&env.svm, &env.vault_token).unwrap();
    assert_eq!(v.owner, env.config);
    assert_eq!(v.mint, env.usdc);
    // sizes (no padding)
    assert_eq!(8 + Config::INIT_SPACE, 165);
    assert_eq!(8 + DepositRecord::INIT_SPACE, 105);
    assert_eq!(8 + ProviderRecord::INIT_SPACE, 79);
    assert_eq!(env.svm.get_account(&env.config).unwrap().data.len(), 165);
}

#[test]
fn initialize_rejects_token_2022_mint() {
    let mut svm = load_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    let t22 = Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();
    let mint = Pubkey::new_unique();
    let mut data = vec![0u8; 82];
    data[44] = 6; // decimals
    data[45] = 1; // is_initialized
    svm.set_account(
        mint,
        solana_account::Account { lamports: 10_000_000, data, owner: t22, executable: false, rent_epoch: 0 },
    )
    .unwrap();
    let ix = initialize_ix(&admin.pubkey(), &admin.pubkey(), &mint, MAX_DEPOSIT);
    let res = send_with(&mut svm, &[ix], &admin, &[]);
    assert_vault_err(&res, VaultError::WrongMint);
    assert!(svm.get_account(&config_pda()).is_none());
}

#[test]
fn initialize_rejects_zero_max_deposit_and_second_call() {
    let mut svm = load_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    let usdc = new_mint(&mut svm, &admin);
    let ix = initialize_ix(&admin.pubkey(), &admin.pubkey(), &usdc, 0);
    assert_vault_err(&send_with(&mut svm, &[ix], &admin, &[]), VaultError::InvalidAmount);
    let ix = initialize_ix(&admin.pubkey(), &admin.pubkey(), &usdc, 1);
    send_with(&mut svm, &[ix], &admin, &[]).unwrap();
    let ix = initialize_ix(&admin.pubkey(), &admin.pubkey(), &usdc, 1);
    assert!(send_with(&mut svm, &[ix], &admin, &[]).is_err());
}

// ------------------------------------------------------------------- deposit

#[test]
fn deposit_happy_path_and_second_index() {
    let mut env = setup();
    let before = env.bal(&env.depositor_token);
    let res = env.deposit(USDC, 9).unwrap();
    assert_eq!(env.bal(&env.vault_token), USDC);
    assert_eq!(env.bal(&env.depositor_token), before - USDC);
    let rec: DepositRecord = load(&env.svm, &deposit_pda(0));
    assert_eq!(rec.index, 0);
    assert_eq!(rec.depositor, env.depositor.pubkey());
    assert_eq!(rec.amount, USDC);
    assert_eq!(rec.deposit_ref, [9u8; 32]);
    assert_eq!(rec.slot, env.svm.get_sysvar::<solana_clock::Clock>().slot);
    assert_eq!(env.cfg().deposit_count, 1);
    let ev = events::<vault::DepositMade>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].index, ev[0].amount, ev[0].deposit_ref), (0, USDC, [9u8; 32]));
    assert_eq!(ev[0].depositor, env.depositor.pubkey());

    env.deposit(2 * USDC, 8).unwrap();
    let rec1: DepositRecord = load(&env.svm, &deposit_pda(1));
    assert_eq!((rec1.index, rec1.amount), (1, 2 * USDC));
    assert_eq!(env.cfg().deposit_count, 2);
}

#[test]
fn deposit_amount_zero() {
    let mut env = setup();
    assert_vault_err(&env.deposit(0, 0), VaultError::InvalidAmount);
}

#[test]
fn deposit_not_whole_cents() {
    let mut env = setup();
    assert_vault_err(&env.deposit(1_000_001, 0), VaultError::AmountNotWholeCents);
}

#[test]
fn deposit_max_boundary() {
    let mut env = setup();
    assert_vault_err(&env.deposit(50_010_000, 0), VaultError::DepositTooLarge);
    env.deposit(50_000_000, 0).unwrap();
    assert_eq!(env.bal(&env.vault_token), 50_000_000);
}

#[test]
fn deposit_other_mint_is_wrong_mint() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let other = new_mint(&mut env.svm, &admin);
    let other_tok = CreateAssociatedTokenAccount::new(&mut env.svm, &admin, &other)
        .owner(&env.depositor.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut env.svm, &admin, &other, &other_tok, 10 * USDC).send().unwrap();
    // other mint account in the usdc_mint slot
    let ix = env.deposit_ix_full(&env.depositor.pubkey(), &other_tok, &other, &env.vault_token, 0, USDC, 0);
    let dep = env.depositor.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &dep), VaultError::WrongMint);
    // right mint account but a depositor token account of the other mint
    let ix = env.deposit_ix_full(&env.depositor.pubkey(), &other_tok, &env.usdc, &env.vault_token, 0, USDC, 0);
    assert_vault_err(&env.send_ix(ix, &dep), VaultError::WrongMint);
}

#[test]
fn deposit_wrong_vault_account() {
    let mut env = setup();
    let other = env.new_payout_account();
    let ix = env.deposit_ix_full(&env.depositor.pubkey(), &env.depositor_token, &env.usdc, &other, 0, USDC, 0);
    let dep = env.depositor.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &dep), VaultError::WrongVaultAccount);
}

#[test]
fn deposit_same_count_collides_then_rebuild_works() {
    let mut env = setup();
    let dep = env.depositor.insecure_clone();
    let a = env.deposit_ix_full(&env.depositor.pubkey(), &env.depositor_token, &env.usdc, &env.vault_token, 0, USDC, 1);
    let b = env.deposit_ix_full(&env.depositor.pubkey(), &env.depositor_token, &env.usdc, &env.vault_token, 0, USDC, 2);
    env.send_ix(a, &dep).unwrap();
    assert!(env.send_ix(b, &dep).is_err());
    assert_eq!(env.cfg().deposit_count, 1);
    let b2 = env.deposit_ix_full(&env.depositor.pubkey(), &env.depositor_token, &env.usdc, &env.vault_token, 1, USDC, 2);
    env.send_ix(b2, &dep).unwrap();
    assert_eq!(env.cfg().deposit_count, 2);
}

// ---------------------------------------------------------- register_provider

#[test]
fn register_provider_happy_path() {
    let mut env = setup();
    let t0 = env.new_payout_account();
    let mut key = [5u8; 33];
    key[0] = 2;
    let ix = env.register_ix(&env.admin.pubkey(), 0, key, t0, t0);
    let admin = env.admin.insecure_clone();
    let res = env.send_ix(ix, &admin).unwrap();
    let ev = events::<vault::ProviderRegistered>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].provider_id, ev[0].cashu_pubkey, ev[0].payout_token), (0, key, t0));
    let rec: ProviderRecord = load(&env.svm, &provider_pda(0));
    assert_eq!((rec.provider_id, rec.cashu_pubkey, rec.payout_token, rec.active), (0, key, t0, true));
    assert_eq!(env.cfg().provider_count, 1);

    let t1 = env.new_payout_account();
    key[0] = 3;
    let ix = env.register_ix(&env.admin.pubkey(), 1, key, t1, t1);
    env.send_ix(ix, &admin).unwrap();
    let rec: ProviderRecord = load(&env.svm, &provider_pda(1));
    assert_eq!((rec.provider_id, rec.cashu_pubkey[0], rec.active), (1, 3, true));
    assert_eq!(env.cfg().provider_count, 2);
}

#[test]
fn register_provider_non_admin() {
    let mut env = setup();
    let t0 = env.new_payout_account();
    let mut key = [5u8; 33];
    key[0] = 2;
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = env.register_ix(&attacker.pubkey(), 0, key, t0, t0);
    assert_vault_err(&env.send_ix(ix, &attacker), VaultError::Unauthorized);
}

#[test]
fn register_provider_bad_prefix() {
    let mut env = setup();
    let t0 = env.new_payout_account();
    let mut key = [5u8; 33];
    let admin = env.admin.insecure_clone();
    for prefix in [4u8, 0u8] {
        key[0] = prefix;
        let ix = env.register_ix(&env.admin.pubkey(), 0, key, t0, t0);
        assert_vault_err(&env.send_ix(ix, &admin), VaultError::InvalidPubkey);
    }
}

#[test]
fn register_provider_other_mint_payout() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let other = new_mint(&mut env.svm, &admin);
    let acct = CreateAccount::new(&mut env.svm, &admin, &other).send().unwrap();
    let mut key = [5u8; 33];
    key[0] = 2;
    let ix = env.register_ix(&env.admin.pubkey(), 0, key, acct, acct);
    assert_vault_err(&env.send_ix(ix, &admin), VaultError::WrongMint);
}

#[test]
fn register_provider_payout_arg_mismatch() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let a = env.new_payout_account();
    let b = env.new_payout_account();
    let mut key = [5u8; 33];
    key[0] = 2;
    let ix = env.register_ix(&env.admin.pubkey(), 0, key, a, b);
    assert_vault_err(&env.send_ix(ix, &admin), VaultError::PayoutAccountMismatch);
}

// -------------------------------------------------------- deactivate_provider

#[test]
fn deactivate_happy_path_and_idempotent() {
    let mut env = setup();
    env.register();
    env.register();
    let admin = env.admin.insecure_clone();
    let ix = deactivate_ix(&env, &admin.pubkey(), 0, provider_pda(0));
    let res = env.send_ix(ix, &admin).unwrap();
    let ev = events::<vault::ProviderDeactivated>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].provider_id, 0);
    assert!(!load::<ProviderRecord>(&env.svm, &provider_pda(0)).active);
    assert!(load::<ProviderRecord>(&env.svm, &provider_pda(1)).active);
    // second call: no-op, no event
    let ix = deactivate_ix(&env, &admin.pubkey(), 0, provider_pda(0));
    let res = env.send_ix(ix, &admin).unwrap();
    assert!(events::<vault::ProviderDeactivated>(&res).is_empty());
    assert!(!load::<ProviderRecord>(&env.svm, &provider_pda(0)).active);
}

#[test]
fn deactivate_non_admin() {
    let mut env = setup();
    env.register();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = deactivate_ix(&env, &attacker.pubkey(), 0, provider_pda(0));
    assert_vault_err(&env.send_ix(ix, &attacker), VaultError::Unauthorized);
    assert!(load::<ProviderRecord>(&env.svm, &provider_pda(0)).active);
}

#[test]
fn deactivate_wrong_record_fails() {
    let mut env = setup();
    env.register();
    env.register();
    let admin = env.admin.insecure_clone();
    let ix = deactivate_ix(&env, &admin.pubkey(), 0, provider_pda(1));
    assert!(env.send_ix(ix, &admin).is_err());
}

// -------------------------------------------------------------- settle_batch

#[test]
fn settle_happy_path_two_payouts() {
    let mut env = setup();
    env.register();
    env.register();
    env.fund_vault(10);
    let res = env.settle(1, vec![p(0, 3 * USDC), p(1, 2_500_000)]).unwrap();
    assert_eq!(env.bal(&env.providers[0].token), 3 * USDC);
    assert_eq!(env.bal(&env.providers[1].token), 2_500_000);
    assert_eq!(env.bal(&env.vault_token), 10 * USDC - 5_500_000);
    assert_eq!(env.cfg().last_batch_id, 1);
    let ev = events::<vault::BatchSettled>(&res);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].batch_id, ev[0].total, ev[0].count), (1, 5_500_000, 2));
}

#[test]
fn settle_eight_payouts_one_tx() {
    let mut env = setup();
    for _ in 0..8 {
        env.register();
    }
    env.fund_vault(100);
    let payouts: Vec<Payout> = (0..8).map(|i| p(i, USDC)).collect();
    let res = env.settle(1, payouts).unwrap();
    for i in 0..8 {
        assert_eq!(env.bal(&env.providers[i].token), USDC);
    }
    assert_eq!(events::<vault::BatchSettled>(&res)[0].total, 8 * USDC);
}

#[test]
fn settle_replay_and_gap_bad_batch_id() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    env.settle(1, vec![p(0, USDC)]).unwrap();
    let vault_bal = env.bal(&env.vault_token);
    assert_vault_err(&env.settle(1, vec![p(0, USDC)]), VaultError::BadBatchId);
    assert_vault_err(&env.settle(3, vec![p(0, USDC)]), VaultError::BadBatchId);
    assert_vault_err(&env.settle(0, vec![p(0, USDC)]), VaultError::BadBatchId);
    assert_eq!(env.bal(&env.vault_token), vault_bal);
    assert_eq!(env.bal(&env.providers[0].token), USDC);
    assert_eq!(env.cfg().last_batch_id, 1);
    env.settle(2, vec![p(0, USDC)]).unwrap();
}

#[test]
fn settle_nine_and_zero_payouts() {
    let mut env = setup();
    for _ in 0..9 {
        env.register();
    }
    env.fund_vault(100);
    let nine: Vec<Payout> = (0..9).map(|i| p(i, USDC)).collect();
    assert_vault_err(&env.settle(1, nine), VaultError::TooManyPayouts);
    assert_vault_err(&env.settle(1, vec![]), VaultError::EmptyBatch);
}

#[test]
fn settle_non_mint_authority() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    let payouts = vec![p(0, USDC)];
    let rem = env.remaining(&payouts);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = env.settle_ix(&attacker.pubkey(), &env.vault_token, 1, payouts.clone(), rem.clone());
    assert_vault_err(&env.send_ix(ix, &attacker), VaultError::Unauthorized);
    // admin is not the mint authority either
    let admin = env.admin.insecure_clone();
    let ix = env.settle_ix(&admin.pubkey(), &env.vault_token, 1, payouts, rem);
    assert_vault_err(&env.send_ix(ix, &admin), VaultError::Unauthorized);
}

#[test]
fn settle_payout_amount_checks() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    assert_vault_err(&env.settle(1, vec![p(0, 0)]), VaultError::InvalidAmount);
    assert_vault_err(&env.settle(1, vec![p(0, 1_000_001)]), VaultError::AmountNotWholeCents);
}

#[test]
fn settle_duplicate_provider() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    assert_vault_err(&env.settle(1, vec![p(0, USDC), p(0, USDC)]), VaultError::DuplicateProvider);
}

#[test]
fn settle_wrong_vault_token() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    let other = env.new_payout_account();
    let payouts = vec![p(0, USDC)];
    let rem = env.remaining(&payouts);
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &other, 1, payouts, rem);
    let ma = env.mint_auth.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::WrongVaultAccount);
}

#[test]
fn settle_payout_account_mismatch() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    let other = env.new_payout_account();
    let payouts = vec![p(0, USDC)];
    let rem = vec![
        AccountMeta::new_readonly(env.providers[0].record, false),
        AccountMeta::new(other, false),
    ];
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts, rem);
    let ma = env.mint_auth.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::PayoutAccountMismatch);
    assert_eq!(env.bal(&other), 0);
}

#[test]
fn settle_record_for_different_id() {
    let mut env = setup();
    env.register();
    env.register();
    env.fund_vault(10);
    let payouts = vec![p(0, USDC)];
    // record of provider 1 with payout token of provider 1, but payout says provider 0
    let rem = vec![
        AccountMeta::new_readonly(env.providers[1].record, false),
        AccountMeta::new(env.providers[1].token, false),
    ];
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts, rem);
    let ma = env.mint_auth.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
}

#[test]
fn settle_record_not_a_program_account() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    let tok = env.providers[0].token;
    let payouts = vec![p(0, USDC)];
    // system account (the mint authority itself) instead of the record
    let rem = vec![AccountMeta::new_readonly(env.admin.pubkey(), false), AccountMeta::new(tok, false)];
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts.clone(), rem);
    let ma = env.mint_auth.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
    // a DepositRecord (program owned, wrong discriminator)
    let dep = deposit_pda(0);
    let rem = vec![AccountMeta::new_readonly(dep, false), AccountMeta::new(tok, false)];
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts.clone(), rem);
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
    // the Config account (program owned, wrong discriminator)
    let rem = vec![AccountMeta::new_readonly(env.config, false), AccountMeta::new(tok, false)];
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts, rem);
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
}

#[test]
fn settle_odd_remaining_count() {
    let mut env = setup();
    env.register();
    env.fund_vault(10);
    let payouts = vec![p(0, USDC)];
    let mut rem = env.remaining(&payouts);
    rem.pop();
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts.clone(), rem);
    let ma = env.mint_auth.insecure_clone();
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
    let mut rem = env.remaining(&payouts);
    rem.push(AccountMeta::new(env.providers[0].token, false));
    let ix = env.settle_ix(&env.mint_auth.pubkey(), &env.vault_token, 1, payouts, rem);
    assert_vault_err(&env.send_ix(ix, &ma), VaultError::ProviderMismatch);
}

#[test]
fn settle_inactive_provider() {
    let mut env = setup();
    env.register();
    env.register();
    env.fund_vault(10);
    let admin = env.admin.insecure_clone();
    let ix = deactivate_ix(&env, &admin.pubkey(), 1, provider_pda(1));
    env.send_ix(ix, &admin).unwrap();
    let vault_bal = env.bal(&env.vault_token);
    assert_vault_err(&env.settle(1, vec![p(0, USDC), p(1, USDC)]), VaultError::ProviderInactive);
    assert_eq!(env.bal(&env.vault_token), vault_bal);
    assert_eq!(env.bal(&env.providers[0].token), 0);
    assert_eq!(env.cfg().last_batch_id, 0);
}

#[test]
fn settle_math_overflow() {
    let mut env = setup();
    env.register();
    env.register();
    // multiples of 10_000 whose sum exceeds u64::MAX
    let half = (u64::MAX / 2 / 10_000 + 1) * 10_000;
    assert!(half.checked_add(half).is_none());
    assert_vault_err(&env.settle(1, vec![p(0, half), p(1, half)]), VaultError::MathOverflow);
}

#[test]
fn settle_vault_short_of_funds() {
    let mut env = setup();
    env.register();
    env.fund_vault(1);
    let res = env.settle(1, vec![p(0, 2 * USDC)]);
    assert!(res.is_err());
    let code = err_code(&res);
    assert!(code.map_or(true, |c| c < anchor_lang::error::ERROR_CODE_OFFSET), "should be a token program error");
    assert_eq!(env.cfg().last_batch_id, 0);
    assert_eq!(env.bal(&env.vault_token), USDC);
    assert_eq!(env.bal(&env.providers[0].token), 0);
}

#[test]
fn error_codes_follow_contract_order() {
    // 00 section 4.5 order; codes are 6000 + index
    let order = [
        VaultError::InvalidAmount,
        VaultError::AmountNotWholeCents,
        VaultError::DepositTooLarge,
        VaultError::InvalidPubkey,
        VaultError::WrongMint,
        VaultError::WrongVaultAccount,
        VaultError::Unauthorized,
        VaultError::BadBatchId,
        VaultError::TooManyPayouts,
        VaultError::EmptyBatch,
        VaultError::DuplicateProvider,
        VaultError::ProviderMismatch,
        VaultError::ProviderInactive,
        VaultError::PayoutAccountMismatch,
        VaultError::MathOverflow,
    ];
    for (i, e) in order.iter().enumerate() {
        assert_eq!(*e as u32, i as u32);
    }
}
