-- Onchain issuance log (02-mint.md, Issuance log). The vault's log is shared by every mint that uses the vault
-- (each devnet demo run starts its own mint, and `pnpm serve` runs a long-lived one), so each mint adds only its
-- own unlogged issuance with `log_issuance(add)`.
--
-- logged_cents: how much of this mint's net issuance (issued minus what it had settled before joining the log)
-- is already in the log. pending_*: a log transaction that was signed and may have been sent; it is resolved
-- from its signature status before anything else is sent, so a crash cannot add the same cents twice.
create table if not exists issuance_log_state (
  id int primary key check (id = 1),
  logged_cents bigint not null check (logged_cents >= 0),
  pending_kind text check (pending_kind in ('init', 'add')),
  pending_cents bigint check (pending_cents >= 0),
  pending_sig text,
  pending_valid_until bigint,
  updated_at timestamptz not null default now(),
  check ((pending_sig is null) = (pending_kind is null) and (pending_sig is null) = (pending_cents is null))
);
