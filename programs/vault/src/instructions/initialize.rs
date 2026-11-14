use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Token};

use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: must be owned by the classic SPL Token program (Token-2022 mints are rejected
    /// with `WrongMint` before any account is created). Its layout is validated by the
    /// associated token account initialization below.
    #[account(constraint = *usdc_mint.owner == token::ID @ VaultError::WrongMint)]
    pub usdc_mint: UncheckedAccount<'info>,

    /// CHECK: the vault ATA (config PDA, usdc_mint). Created in the handler, after the mint
    /// owner check, so a Token-2022 mint fails with `WrongMint` rather than inside the ATA program.
    #[account(
        mut,
        address = get_associated_token_address(&config.key(), &usdc_mint.key()) @ VaultError::WrongVaultAccount
    )]
    pub vault_token: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, mint_authority: Pubkey, max_deposit: u64) -> Result<()> {
    require!(max_deposit > 0, VaultError::InvalidAmount);
    associated_token::create(CpiContext::new(
        ctx.accounts.associated_token_program.key(),
        associated_token::Create {
            payer: ctx.accounts.admin.to_account_info(),
            associated_token: ctx.accounts.vault_token.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
    ))?;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.mint_authority = mint_authority;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.vault_token = ctx.accounts.vault_token.key();
    config.max_deposit = max_deposit;
    config.deposit_count = 0;
    config.provider_count = 0;
    config.last_batch_id = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}
