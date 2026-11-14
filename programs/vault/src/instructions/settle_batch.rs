use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::VaultError;
use crate::events::BatchSettled;
use crate::state::*;

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    pub mint_authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = mint_authority @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.vault_token @ VaultError::WrongVaultAccount)]
    pub vault_token: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint @ VaultError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_batch<'info>(
    ctx: Context<'info, SettleBatch<'info>>,
    batch_id: u64,
    payouts: Vec<Payout>,
) -> Result<()> {
    require!(!payouts.is_empty(), VaultError::EmptyBatch);
    require!(payouts.len() <= MAX_PAYOUTS_PER_BATCH, VaultError::TooManyPayouts);
    require!(
        batch_id == ctx.accounts.config.last_batch_id.checked_add(1).ok_or(VaultError::MathOverflow)?,
        VaultError::BadBatchId
    );
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() == 2 * payouts.len(), VaultError::ProviderMismatch);

    let usdc_mint = ctx.accounts.usdc_mint.key();

    // First pass: validate everything, no CPI yet.
    let mut total: u64 = 0;
    for (i, payout) in payouts.iter().enumerate() {
        require!(payout.amount > 0, VaultError::InvalidAmount);
        require!(payout.amount % BASE_UNITS_PER_CENT == 0, VaultError::AmountNotWholeCents);
        require!(
            !payouts[..i].iter().any(|p| p.provider_id == payout.provider_id),
            VaultError::DuplicateProvider
        );

        let record_info = &remaining[2 * i];
        let payout_info = &remaining[2 * i + 1];

        require!(record_info.owner == &crate::ID, VaultError::ProviderMismatch);
        let record = Account::<ProviderRecord>::try_from(record_info)
            .map_err(|_| error!(VaultError::ProviderMismatch))?;
        let (expected, _) = Pubkey::find_program_address(
            &[PROVIDER_SEED, payout.provider_id.to_le_bytes().as_ref()],
            &crate::ID,
        );
        require_keys_eq!(expected, record_info.key(), VaultError::ProviderMismatch);
        require!(record.active, VaultError::ProviderInactive);
        require_keys_eq!(payout_info.key(), record.payout_token, VaultError::PayoutAccountMismatch);
        require!(payout_info.is_writable, VaultError::PayoutAccountMismatch);
        let token_account = Account::<TokenAccount>::try_from(payout_info)
            .map_err(|_| error!(VaultError::WrongMint))?;
        require_keys_eq!(token_account.mint, usdc_mint, VaultError::WrongMint);

        total = total.checked_add(payout.amount).ok_or(VaultError::MathOverflow)?;
    }

    ctx.accounts.config.last_batch_id = batch_id;
    let bump = ctx.accounts.config.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];

    // Second pass: transfers, signed by the Config PDA (authority of the vault token account).
    for (i, payout) in payouts.iter().enumerate() {
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: remaining[2 * i + 1].clone(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            payout.amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    emit!(BatchSettled { batch_id, total, count: payouts.len() as u8 });
    Ok(())
}
