-- Mint schema (docs/design/02-mint.md 4.2). Money columns are cents unless named *_base.
create table keysets (
  id text primary key,
  unit text not null,
  active boolean not null,
  input_fee_ppk int not null default 0,
  pubkeys jsonb not null,
  created_at timestamptz not null default now()
);
create unique index keysets_one_active on keysets (unit) where active;

create table mint_quotes (
  id uuid primary key,
  deposit_ref text not null unique check (deposit_ref ~ '^[0-9a-f]{64}$'),
  unit text not null,
  amount bigint not null check (amount between 1 and 5000),
  pubkey text not null,
  expiry bigint not null,
  amount_paid bigint not null default 0,
  amount_issued bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_issued <= amount_paid)
);

create table deposits (
  index bigint primary key,
  depositor text not null,
  amount_base bigint not null,
  amount_cents bigint not null,
  deposit_ref text not null,
  slot bigint not null,
  block_time bigint not null,
  quote_id uuid references mint_quotes (id),
  created_at timestamptz not null default now()
);
create index deposits_ref on deposits (deposit_ref);

create table deposit_cursor (
  id int primary key check (id = 1),
  next_index bigint not null default 0
);
insert into deposit_cursor (id, next_index) values (1, 0);

create table issued_signatures (
  b_ text primary key,
  quote_id uuid not null references mint_quotes (id),
  request_id uuid not null,
  seq int not null,
  keyset_id text not null,
  amount int not null,
  c_ text not null,
  dleq_s text not null,
  dleq_e text not null,
  created_at timestamptz not null default now()
);
create index issued_signatures_quote on issued_signatures (quote_id);
create index issued_signatures_request on issued_signatures (request_id);

create table providers (
  provider_id int primary key,
  pubkey text not null unique,
  payout_token text not null,
  active boolean not null,
  name text,
  url text,
  price_cents int,
  topics jsonb not null default '[]',
  synced_at timestamptz not null default now()
);

create table provider_balances (
  provider_id int primary key references providers (provider_id),
  balance bigint not null default 0 check (balance >= 0)
);

create table redemptions (
  id uuid primary key,
  provider_id int not null references providers (provider_id),
  amount bigint not null,
  proof_count int not null,
  created_at timestamptz not null default now()
);

create table spent_proofs (
  y text primary key,
  amount int not null,
  keyset_id text not null,
  redemption_id uuid not null references redemptions (id),
  created_at timestamptz not null default now()
);

create table settlements (
  id bigserial primary key,
  batch_id bigint not null,
  status text not null check (status in ('pending', 'submitted', 'confirmed', 'failed')),
  payouts jsonb not null,
  tx_sig text,
  last_valid bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index settlements_batch_live on settlements (batch_id) where status <> 'failed';
