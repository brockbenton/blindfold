use anchor_lang::prelude::*;

/// 1 cent = 10_000 USDC base units (6 decimals).
pub const BASE_UNITS_PER_CENT: u64 = 10_000;
pub const MAX_PAYOUTS_PER_BATCH: usize = 8;

pub const CONFIG_SEED: &[u8] = b"config";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const PROVIDER_SEED: &[u8] = b"provider";

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub mint_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault_token: Pubkey,
    /// Base units.
    pub max_deposit: u64,
    pub deposit_count: u64,
    pub provider_count: u32,
    pub last_batch_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DepositRecord {
    pub index: u64,
    pub depositor: Pubkey,
    /// Base units.
    pub amount: u64,
    pub deposit_ref: [u8; 32],
    pub slot: u64,
    pub timestamp: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProviderRecord {
    pub provider_id: u32,
    pub cashu_pubkey: [u8; 33],
    pub payout_token: Pubkey,
    pub active: bool,
    pub bump: u8,
}

/// `amount` is in base units.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payout {
    pub provider_id: u32,
    pub amount: u64,
}
