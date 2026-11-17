-- Settlement's hold window sums each provider's recent redemptions (02-mint.md, settlement privacy).
create index if not exists redemptions_provider_created_idx on redemptions (provider_id, created_at);
