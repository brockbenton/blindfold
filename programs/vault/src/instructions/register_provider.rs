use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::errors::VaultError;
use crate::events::ProviderRegistered;
use crate::state::*;

#[derive(Accounts)]
#[instruction(cashu_pubkey: [u8; 33], payout_token: Pubkey)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + ProviderRecord::INIT_SPACE,
        seeds = [PROVIDER_SEED, config.provider_count.to_le_bytes().as_ref()],
        bump
    )]
    pub provider_record: Account<'info, ProviderRecord>,

    #[account(
        constraint = payout_token_account.key() == payout_token @ VaultError::PayoutAccountMismatch,
        constraint = payout_token_account.mint == config.usdc_mint @ VaultError::WrongMint,
    )]
    pub payout_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handle_register_provider(
    ctx: Context<RegisterProvider>,
    cashu_pubkey: [u8; 33],
    payout_token: Pubkey,
) -> Result<()> {
    require!(cashu_pubkey[0] == 2 || cashu_pubkey[0] == 3, VaultError::InvalidPubkey);

    let config = &mut ctx.accounts.config;
    let provider_id = config.provider_count;
    config.provider_count = provider_id.checked_add(1).ok_or(VaultError::MathOverflow)?;

    let record = &mut ctx.accounts.provider_record;
    record.provider_id = provider_id;
    record.cashu_pubkey = cashu_pubkey;
    record.payout_token = payout_token;
    record.active = true;
    record.bump = ctx.bumps.provider_record;

    emit!(ProviderRegistered { provider_id, cashu_pubkey, payout_token });
    Ok(())
}
