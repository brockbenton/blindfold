use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::ProviderDeactivated;
use crate::state::*;

#[derive(Accounts)]
#[instruction(provider_id: u32)]
pub struct DeactivateProvider<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [PROVIDER_SEED, provider_id.to_le_bytes().as_ref()], bump = provider_record.bump)]
    pub provider_record: Account<'info, ProviderRecord>,
}

pub fn handle_deactivate_provider(ctx: Context<DeactivateProvider>, provider_id: u32) -> Result<()> {
    let record = &mut ctx.accounts.provider_record;
    if record.active {
        record.active = false;
        emit!(ProviderDeactivated { provider_id });
    }
    Ok(())
}
