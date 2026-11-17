use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::IssuanceLogged;
use crate::state::*;

#[derive(Accounts)]
pub struct InitIssuanceLog<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint_authority @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(init, payer = mint_authority, space = 8 + IssuanceLog::INIT_SPACE, seeds = [ISSUANCE_SEED], bump)]
    pub issuance_log: Account<'info, IssuanceLog>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LogIssuance<'info> {
    pub mint_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint_authority @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ISSUANCE_SEED], bump = issuance_log.bump)]
    pub issuance_log: Account<'info, IssuanceLog>,
}

fn whole_cents(amount: u64) -> Result<()> {
    require!(amount % BASE_UNITS_PER_CENT == 0, VaultError::AmountNotWholeCents);
    Ok(())
}

/// Creates the log. `settled` is a one-time baseline for batches paid before the log existed;
/// anyone can check it against the history of `BatchSettled` events.
pub fn handle_init_issuance_log(ctx: Context<InitIssuanceLog>, issued: u64, settled: u64) -> Result<()> {
    whole_cents(issued)?;
    whole_cents(settled)?;
    require!(issued >= settled, VaultError::IssuanceBelowSettled);
    let clock = Clock::get()?;
    let log = &mut ctx.accounts.issuance_log;
    log.issued = issued;
    log.settled = settled;
    log.seq = 0;
    log.updated_slot = clock.slot;
    log.updated_at = clock.unix_timestamp;
    log.bump = ctx.bumps.issuance_log;
    emit!(IssuanceLogged { issued, settled, seq: 0 });
    Ok(())
}

/// Adds newly issued base units to the cumulative total. An add, not a set: two mints logging at once
/// cannot overwrite each other, and the total can never go down, so a published claim cannot be retracted.
pub fn handle_log_issuance(ctx: Context<LogIssuance>, add: u64) -> Result<()> {
    whole_cents(add)?;
    let log = &mut ctx.accounts.issuance_log;
    let issued = log.issued.checked_add(add).ok_or(VaultError::MathOverflow)?;
    require!(issued >= log.settled, VaultError::IssuanceBelowSettled);
    let clock = Clock::get()?;
    log.issued = issued;
    log.seq = log.seq.checked_add(1).ok_or(VaultError::MathOverflow)?;
    log.updated_slot = clock.slot;
    log.updated_at = clock.unix_timestamp;
    emit!(IssuanceLogged { issued, settled: log.settled, seq: log.seq });
    Ok(())
}
