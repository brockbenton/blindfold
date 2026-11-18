-- True if the signed settlement transaction includes the issuance PDA.
-- Legacy rows have unknown coverage and cannot safely reduce issuance when joining an existing log.
alter table settlements add column if not exists issuance_accounted boolean;

-- A legacy pending row does not show whether an unsigned-in-the-database attempt was sent.
alter table settlements add column if not exists signed_before_send boolean not null default false;
