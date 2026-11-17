use anchor_lang::prelude::*;

// Order is part of the contract (00 section 4.5): codes are 6000 + index.
#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Amount must be a whole number of cents")]
    AmountNotWholeCents,
    #[msg("Deposit exceeds the maximum deposit")]
    DepositTooLarge,
    #[msg("Cashu public key must be a compressed secp256k1 point (prefix 0x02 or 0x03)")]
    InvalidPubkey,
    #[msg("Token mint is not the vault USDC mint")]
    WrongMint,
    #[msg("Vault token account is not the configured vault account")]
    WrongVaultAccount,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Batch id must be last_batch_id + 1")]
    BadBatchId,
    #[msg("Too many payouts in one batch")]
    TooManyPayouts,
    #[msg("Batch has no payouts")]
    EmptyBatch,
    #[msg("Provider appears twice in one batch")]
    DuplicateProvider,
    #[msg("Provider record account is missing, invalid or does not match the payout")]
    ProviderMismatch,
    #[msg("Provider is inactive")]
    ProviderInactive,
    #[msg("Payout token account differs from the registered one")]
    PayoutAccountMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Logged issuance cannot be below the settled total")]
    IssuanceBelowSettled,
    #[msg("Issuance log account is invalid")]
    IssuanceLogMismatch,
}
