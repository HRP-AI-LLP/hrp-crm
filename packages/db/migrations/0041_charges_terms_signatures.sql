-- 0041: what a services business bills, and how its documents are signed.
--
--  * tax_inclusive        quotes, orders, purchase orders, invoices and bills: "Prices include GST"; the
--                         taxable value is worked back from each line's amount
--  * payment_terms        invoices and customers: Due on receipt, Net N, end of (next) month, custom; the
--                         due date follows the terms. invoices.subject is printed above the lines
--  * deal_charges         a deal's one-time and recurring charges (a website build and its monthly
--                         maintenance); a won deal sets up the project, the invoice for the one-time
--                         charges and the recurring invoice for the rest
--  * recurring_profiles   know their deal, project and customer; recurring_price_changes changes the
--                         price from a date onward, keeping the history
--  * signatures           saved signatures (image, name, designation) and who may sign with each;
--                         document_signatures records a document being signed (who, when, a hash of
--                         what was signed, and a code anyone can check)

alter table quotes add column tax_inclusive boolean not null default false;
alter table sales_orders add column tax_inclusive boolean not null default false;
alter table purchase_orders add column tax_inclusive boolean not null default false;
alter table invoices add column tax_inclusive boolean not null default false;
alter table bills add column tax_inclusive boolean not null default false;

alter table invoices add column payment_terms text check (payment_terms ~ '^(due_on_receipt|net_[0-9]{1,3}|end_of_month|end_of_next_month|custom)$');
alter table invoices add column subject text check (length(subject) <= 500);
alter table invoices add column deal_id uuid;
alter table invoices add column recurring_profile_id uuid;
alter table invoices add constraint invoices_deal foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id);
alter table accounts add column payment_terms text check (payment_terms ~ '^(due_on_receipt|net_[0-9]{1,3}|end_of_month|end_of_next_month|custom)$');
create index invoices_deal on invoices (tenant_id, deal_id) where deal_id is not null;

alter table deals add column one_time_total numeric(18, 2);
alter table deals add column recurring_monthly numeric(18, 2);
alter table deals add column billing_setup_at timestamptz;

create table deal_charges (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  deal_id       uuid not null,
  position      integer not null default 1,
  kind          text not null check (kind in ('one_time', 'recurring')),
  product_id    uuid,
  name          text not null check (length(name) between 1 and 200),
  description   text check (length(description) <= 2000),
  hsn_sac       text check (length(hsn_sac) <= 20),
  quantity      numeric(18, 3) not null default 1 check (quantity > 0),
  unit_price    numeric(18, 2) not null check (unit_price >= 0),
  tax_rate      numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  tax_inclusive boolean not null default false,
  frequency     text check (frequency in ('monthly', 'quarterly', 'half_yearly', 'yearly')),
  start_date    date,
  periods       integer check (periods between 1 and 600),
  check ((kind = 'recurring') = (frequency is not null)),
  unique (tenant_id, id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);
create index deal_charges_deal on deal_charges (tenant_id, deal_id, position);

alter table recurring_profiles add column deal_id uuid;
alter table recurring_profiles add column project_id uuid;
alter table recurring_profiles add column account_id uuid;
alter table recurring_profiles add constraint recurring_profiles_deal foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id);
alter table recurring_profiles add constraint recurring_profiles_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id);
alter table recurring_profiles add constraint recurring_profiles_account foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id);
alter table invoices add constraint invoices_recurring foreign key (tenant_id, recurring_profile_id) references recurring_profiles (tenant_id, id) on delete set null (recurring_profile_id);

create table recurring_price_changes (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  profile_id      uuid not null,
  effective_from  date not null,
  lines           jsonb not null,
  tax_inclusive   boolean not null default false,
  note            text check (length(note) <= 500),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, profile_id, effective_from),
  foreign key (tenant_id, profile_id) references recurring_profiles (tenant_id, id) on delete cascade
);

-- partners / directors: the details the organisation profile keeps about them
alter table acct_persons add column designation text check (length(designation) <= 120);
alter table acct_persons add column phone text check (length(phone) <= 25);
alter table acct_persons add column email text check (length(email) <= 200);
alter table acct_persons add column pan text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
alter table acct_persons add column din text check (din ~ '^[0-9]{8}$');
alter table acct_persons add column share_pct numeric(6, 3) check (share_pct between 0 and 100);
alter table acct_persons add column joined_on date;
alter table acct_persons add column user_id uuid;
alter table acct_persons add constraint acct_persons_user foreign key (tenant_id, user_id) references users (tenant_id, id) on delete set null (user_id);

create table signatures (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  signer_name  text not null check (length(signer_name) between 1 and 120),
  designation  text check (length(designation) <= 120),
  image        text not null check (image ~ '^data:image/(png|jpeg|webp);base64,' and length(image) <= 400000),
  user_ids     uuid[] not null default '{}',
  is_active    boolean not null default true,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id)
);

create table document_signatures (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key    text not null check (object_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  record_id     uuid not null,
  signature_id  uuid,
  signer_name   text not null,
  designation   text,
  image         text not null,
  doc_hash      text not null check (doc_hash ~ '^[0-9a-f]{64}$'),
  verify_code   text not null check (verify_code ~ '^[A-Z0-9]{12}$'),
  signed_by     uuid default app.current_user_id(),
  signed_at     timestamptz not null default now(),
  revoked_at    timestamptz,
  revoke_reason text check (length(revoke_reason) <= 500),
  unique (tenant_id, id),
  unique (verify_code),
  foreign key (tenant_id, signature_id) references signatures (tenant_id, id) on delete set null (signature_id)
);
create index document_signatures_record on document_signatures (tenant_id, object_key, record_id);

do $$
declare t text;
begin
  foreach t in array array['deal_charges', 'recurring_price_changes', 'signatures', 'document_signatures'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end $$;
