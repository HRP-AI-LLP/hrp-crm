-- GeM bids read from GeM itself (the public bid search and bid documents), and cards in full:
-- company or personal (a partner's), network, limit, statement and due days.

alter table gem_bids
  add column gem_id          bigint,
  add column details         jsonb not null default '{}'::jsonb,
  add column files           jsonb not null default '[]'::jsonb,
  add column fetched_at      timestamptz,
  add column fetch_error     text check (length(fetch_error) <= 500),
  add column fetch_attempts  integer not null default 0;

alter table bank_accounts
  add column holder          text not null default 'company' check (holder in ('company', 'personal')),
  add column person_id       uuid,
  add column card_network    text check (card_network is null or card_network in ('visa', 'mastercard', 'rupay', 'amex', 'diners', 'discover', 'other')),
  add column credit_limit    numeric(18, 2) check (credit_limit is null or credit_limit >= 0),
  add column statement_day   smallint check (statement_day between 1 and 31),
  add column due_day         smallint check (due_day between 1 and 31),
  add column card_label      text check (length(card_label) <= 120),
  add foreign key (tenant_id, person_id) references acct_persons (tenant_id, id) on delete set null (person_id);

create index bank_accounts_last4 on bank_accounts (tenant_id, account_last4) where account_last4 is not null;
