-- 0039: the workspace's own money moving between its own hands. The accounts desk books a bank line
-- as a transfer, never as sales, expenses or a new customer, when its narration names one of:
--
--  * acct_persons      an owner, partner or director: money in from them / out to them goes to their
--                      own ledger (partner's current account, loan from director, capital / drawings)
--  * acct_identifiers  what identifies a person's personal accounts (mobile numbers behind UPI, UPI
--                      ids, account numbers, the name the bank prints) or one of the company's other
--                      bank accounts (its account number, UPI id): a line naming a company account is
--                      a transfer between the company's own accounts (a contra entry)

create table acct_persons (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 150),
  role          text not null default 'partner' check (role in ('partner', 'director', 'proprietor', 'other')),
  account_in    uuid not null,
  account_out   uuid not null,
  is_active     boolean not null default true,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_in) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, account_out) references gl_accounts (tenant_id, id) on delete restrict
);

create table acct_identifiers (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  person_id        uuid,
  bank_account_id  uuid,
  kind             text not null check (kind in ('mobile', 'upi', 'account', 'name')),
  value            text not null check (length(value) between 2 and 120),
  match_key        text not null check (length(match_key) between 2 and 120),
  created_at       timestamptz not null default now(),
  check ((person_id is null) <> (bank_account_id is null)),
  unique (tenant_id, kind, match_key),
  foreign key (tenant_id, person_id) references acct_persons (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id) on delete cascade
);
create index acct_identifiers_person on acct_identifiers (tenant_id, person_id);

-- proposals now say which own-account entry they came from
alter table acct_proposals drop constraint if exists acct_proposals_source_check;
alter table acct_proposals add constraint acct_proposals_source_check check (source in ('rule', 'ledger', 'invoice', 'bill', 'gateway', 'history', 'keyword', 'ai', 'person', 'missing', 'own'));

do $$
declare t text;
begin
  foreach t in array array['acct_persons', 'acct_identifiers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end $$;
