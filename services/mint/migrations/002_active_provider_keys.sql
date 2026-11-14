-- A deactivated key can be registered under a new provider ID. Historical
-- records retain their balances; only an active signing identity must be unique.
alter table providers drop constraint providers_pubkey_key;
create unique index providers_active_pubkey on providers (pubkey) where active;
