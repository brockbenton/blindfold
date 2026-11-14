use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::VaultError;
use crate::events::DepositMade;
use crate::state::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = depositor,
        space = 8 + DepositRecord::INIT_SPACE,
        seeds = [DEPOSIT_SEED, config.deposit_count.to_le_bytes().as_ref()],
        bump
    )]
    pub deposit_record: Account<'info, DepositRecord>,

    #[account(
        mut,
        constraint = depositor_token.mint == config.usdc_mint @ VaultError::WrongMint,
        constraint = depositor_token.key() != config.vault_token @ VaultError::WrongVaultAccount,
    )]
    pub depositor_token: Account<'info, TokenAccount>,

    #[account(mut, address = config.vault_token @ VaultError::WrongVaultAccount)]
    pub vault_token: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint @ VaultError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64, deposit_ref: [u8; 32]) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    require!(amount % BASE_UNITS_PER_CENT == 0, VaultError::AmountNotWholeCents);
    require!(amount <= ctx.accounts.config.max_deposit, VaultError::DepositTooLarge);

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.depositor_token.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    let index = config.deposit_count;

    let record = &mut ctx.accounts.deposit_record;
    record.index = index;
    record.depositor = ctx.accounts.depositor.key();
    record.amount = amount;
    record.deposit_ref = deposit_ref;
    record.slot = clock.slot;
    record.timestamp = clock.unix_timestamp;
    record.bump = ctx.bumps.deposit_record;

    config.deposit_count = index.checked_add(1).ok_or(VaultError::MathOverflow)?;

    emit!(DepositMade { index, depositor: record.depositor, amount, deposit_ref });
    Ok(())
}
