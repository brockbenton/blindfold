use anchor_lang::prelude::*;

#[event]
pub struct DepositMade {
    pub index: u64,
    pub depositor: Pubkey,
    pub amount: u64,
    pub deposit_ref: [u8; 32],
}

#[event]
pub struct ProviderRegistered {
    pub provider_id: u32,
    pub cashu_pubkey: [u8; 33],
    pub payout_token: Pubkey,
}

#[event]
pub struct ProviderDeactivated {
    pub provider_id: u32,
}

#[event]
pub struct BatchSettled {
    pub batch_id: u64,
    pub total: u64,
    pub count: u8,
}

#[event]
pub struct IssuanceLogged {
    pub issued: u64,
    pub settled: u64,
    pub seq: u64,
}
