pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo");

#[program]
pub mod vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, mint_authority: Pubkey, max_deposit: u64) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, mint_authority, max_deposit)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, deposit_ref: [u8; 32]) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount, deposit_ref)
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        cashu_pubkey: [u8; 33],
        payout_token: Pubkey,
    ) -> Result<()> {
        instructions::register_provider::handle_register_provider(ctx, cashu_pubkey, payout_token)
    }

    pub fn deactivate_provider(ctx: Context<DeactivateProvider>, provider_id: u32) -> Result<()> {
        instructions::deactivate_provider::handle_deactivate_provider(ctx, provider_id)
    }

    pub fn settle_batch<'info>(
        ctx: Context<'info, SettleBatch<'info>>,
        batch_id: u64,
        payouts: Vec<Payout>,
    ) -> Result<()> {
        instructions::settle_batch::handle_settle_batch(ctx, batch_id, payouts)
    }
}
