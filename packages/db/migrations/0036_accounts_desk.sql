-- 0036: the accounts desk — a small department of agents that keeps the books complete, with people
-- approving what matters.
--
--  * acct_desk_settings   how much the agents may do on their own (one row per workspace)
--  * acct_runs            each time an agent worked: what triggered it, what it did, its summary
--  * acct_proposals       what the bookkeeper wants to do with a bank line (match, record a receipt or
--                         a vendor payment, categorise, exclude) — applied automatically when sure,
--                         otherwise waiting for a person to approve, change or reject
--  * acct_findings        what the compliance clerk and the controller found (GST / TDS gaps,
--                         month-end checklist items), open until done or dismissed
--  * bank_feeds           live transaction feeds (RazorpayX first); credentials sealed with the
--                         server's DATA_ENCRYPTION_KEY, never readable back
--  * gateway_settlements  payouts from the payment gateway (Razorpay): net amount, fee and GST on the
--                         fee, UTR — so a settlement credit in the bank is booked as net + fee + GST
--                         against the gateway clearing account the online receipts went to
--  * bank_transactions gains where a line came from and the provider's id for it

create table acct_desk_settings (
  tenant_id       uuid primary key default app.current_tenant_id() references tenants (id) on delete cascade,
  enabled         boolean not null default true,
  autonomy        text not null default 'auto_sure' check (autonomy in ('suggest', 'auto_sure', 'auto_all')),
  min_confidence  numeric(4, 3) not null default 0.6 check (min_confidence between 0 and 1),
  use_ai          boolean not null default true,
  updated_by      uuid default app.current_user_id(),
  updated_at      timestamptz not null default now()
);

create table acct_runs (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  agent        text not null check (agent in ('bank_clerk', 'bookkeeper', 'compliance', 'controller')),
  trigger      text not null default 'manual' check (trigger in ('manual', 'schedule', 'import', 'feed')),
  period       text check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  stats        jsonb not null default '{}'::jsonb,
  summary      text check (length(summary) <= 20000),
  model        text,
  error        text check (length(error) <= 2000),
  started_by   uuid default app.current_user_id(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (tenant_id, id)
);
create index acct_runs_recent on acct_runs (tenant_id, agent, started_at desc);

create table acct_proposals (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id        uuid,
  agent         text not null default 'bookkeeper' check (agent in ('bank_clerk', 'bookkeeper', 'compliance', 'controller')),
  bank_txn_id   uuid,
  kind          text not null check (kind in ('match', 'receipt', 'vendor_payment', 'categorize', 'exclude', 'settlement')),
  title         text not null check (length(title) between 1 and 300),
  reason        text check (length(reason) <= 1000),
  payload       jsonb not null default '{}'::jsonb,
  confidence    numeric(4, 3) not null check (confidence between 0 and 1),
  source        text not null check (source in ('rule', 'ledger', 'invoice', 'bill', 'gateway', 'history', 'keyword', 'ai', 'person')),
  status        text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'failed', 'stale')),
  applied_by    text check (applied_by in ('agent', 'person')),
  decided_by    uuid,
  decided_at    timestamptz,
  result        jsonb,
  error         text check (length(error) <= 1000),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, bank_txn_id) references bank_transactions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, run_id) references acct_runs (tenant_id, id) on delete set null (run_id)
);
-- one open proposal per bank line
create unique index acct_proposals_one_pending on acct_proposals (tenant_id, bank_txn_id) where status = 'pending';
create index acct_proposals_queue on acct_proposals (tenant_id, status, created_at desc);

create table acct_findings (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id       uuid,
  agent        text not null check (agent in ('bank_clerk', 'bookkeeper', 'compliance', 'controller')),
  key          text not null check (length(key) between 1 and 160),
  kind         text not null check (length(kind) between 1 and 60),
  severity     text not null default 'info' check (severity in ('info', 'warn', 'risk')),
  title        text not null check (length(title) between 1 and 300),
  body         text check (length(body) <= 4000),
  link         text check (length(link) <= 300),
  period       text,
  amount       numeric(18, 2),
  status       text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  seen_at      timestamptz not null default now(),
  resolved_by  uuid,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, run_id) references acct_runs (tenant_id, id) on delete set null (run_id)
);
-- a finding is one row while it stays open; the next run refreshes it or closes it
create unique index acct_findings_one_open on acct_findings (tenant_id, key) where status = 'open';

create table bank_feeds (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bank_account_id   uuid not null,
  provider          text not null check (provider in ('razorpayx')),
  label             text check (length(label) <= 120),
  account_ref       text not null check (length(account_ref) between 3 and 40),
  secret_ciphertext text not null,
  status            text not null default 'active' check (status in ('active', 'paused', 'error')),
  synced_from       date,
  cursor            text,
  last_synced_at    timestamptz,
  last_error        text check (length(last_error) <= 1000),
  created_by        uuid default app.current_user_id(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, account_ref),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id) on delete cascade
);

create table gateway_settlements (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  provider       text not null check (provider in ('razorpay')),
  settlement_id  text not null check (length(settlement_id) between 1 and 60),
  amount         numeric(18, 2) not null,
  fees           numeric(18, 2) not null default 0,
  tax            numeric(18, 2) not null default 0,
  utr            text check (length(utr) <= 60),
  status         text not null,
  settled_at     timestamptz not null,
  bank_txn_id    uuid,
  journal_id     uuid,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, settlement_id)
);
create index gateway_settlements_open on gateway_settlements (tenant_id, settled_at) where bank_txn_id is null;

alter table bank_transactions
  add column source text not null default 'statement' check (source in ('statement', 'feed', 'manual')),
  add column external_id text check (length(external_id) <= 120),
  add column counterparty text check (length(counterparty) <= 200);

do $$
declare t text;
begin
  foreach t in array array['acct_desk_settings', 'acct_runs', 'acct_proposals', 'acct_findings', 'bank_feeds', 'gateway_settlements'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end $$;
