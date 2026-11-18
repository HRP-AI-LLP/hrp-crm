-- Industry gaps for IT services and manufacturing: account hierarchy and credit control, why deals are
-- lost, tiered and customer price lists, RFQs, promise dates, warranties, spare parts on tickets,
-- complaints with CAPA, rebates and dealer schemes (with a dealer portal), client IT assets with their
-- history, an encrypted credentials vault, technical documents, email sequences, ticket escalation,
-- a public knowledge base, and connectors (Teams / Slack webhooks, Jira, Azure DevOps, Asana, ERPs).

-- ───── accounts: parent company, credit limit, own price list, territory, dealer tier, dealer portal ─────
alter table accounts
  add column parent_account_id uuid,
  add column credit_limit      numeric(18, 2) check (credit_limit is null or credit_limit >= 0),
  add column credit_hold       boolean not null default false,
  add column price_book_id     uuid,
  add column territory         text check (length(territory) <= 80),
  add column dealer_tier       text check (length(dealer_tier) <= 40),
  add column public_token      text unique,
  add constraint accounts_parent foreign key (tenant_id, parent_account_id) references accounts (tenant_id, id) on delete set null (parent_account_id),
  add constraint accounts_price_book foreign key (tenant_id, price_book_id) references price_books (tenant_id, id) on delete set null (price_book_id),
  add constraint accounts_not_own_parent check (parent_account_id is null or parent_account_id <> id);
create index accounts_parent on accounts (tenant_id, parent_account_id) where parent_account_id is not null;

-- ───── deals: why they were lost ─────
alter table deals
  add column loss_reason text check (length(loss_reason) <= 80),
  add column lost_to     text check (length(lost_to) <= 120),
  add column loss_note   text check (length(loss_note) <= 2000);

-- ───── pricing: quantity tiers, customer-specific lists with validity ─────
alter table price_book_entries add column min_qty numeric(14, 3) not null default 1 check (min_qty > 0);
alter table price_book_entries drop constraint price_book_entries_pkey;
alter table price_book_entries add primary key (tenant_id, price_book_id, product_id, min_qty);
alter table price_books
  add column account_id  uuid,
  add column valid_from  date,
  add column valid_to    date,
  add constraint price_books_account foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade;

-- ───── products: warranty, spares, specifications ─────
alter table products
  add column warranty_months integer check (warranty_months between 0 and 240),
  add column is_spare        boolean not null default false,
  add column spare_for_id    uuid,
  add column specifications  text check (length(specifications) <= 8000),
  add constraint products_spare_for foreign key (tenant_id, spare_for_id) references products (tenant_id, id) on delete set null (spare_for_id);

-- ───── RFQs are quotes that start as the customer's request ─────
alter table quotes drop constraint quotes_status_check;
alter table quotes add constraint quotes_status_check check (status in ('rfq', 'draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'));
alter table quotes
  add column rfq_number      text check (length(rfq_number) <= 80),
  add column rfq_received_on date,
  add column rfq_due_on      date,
  add column customer_ref    text check (length(customer_ref) <= 120);

-- ───── when each order line can be delivered ─────
alter table sales_order_lines add column promise_date date;

-- ───── tickets: escalation level ─────
alter table tickets add column escalation_level integer not null default 0;

-- ───── public knowledge base ─────
alter table kb_documents add column is_public boolean not null default false;
alter table kb_documents add column category text check (length(category) <= 80);

create table kb_sites (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade unique,
  title         text not null default 'Help centre' check (length(title) <= 120),
  public_token  text unique,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id)
);

create table warranties (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id      uuid,
  account_id      uuid,
  sales_order_id  uuid,
  serial_no       text check (length(serial_no) <= 80),
  quantity        numeric(14, 3) not null default 1 check (quantity > 0),
  starts_on       date not null,
  ends_on         date not null,
  status          text not null default 'active' check (status in ('active', 'void')),
  notes           text check (length(notes) <= 2000),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id)
);
create index warranties_account on warranties (tenant_id, account_id);
create index warranties_serial on warranties (tenant_id, lower(serial_no)) where serial_no is not null;
create unique index warranties_order_line on warranties (tenant_id, sales_order_id, product_id, coalesce(serial_no, '')) where sales_order_id is not null;

create table ticket_parts (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  ticket_id     uuid not null,
  product_id    uuid not null,
  warehouse_id  uuid,
  quantity      numeric(14, 3) not null check (quantity > 0),
  unit_price    numeric(18, 2) not null default 0 check (unit_price >= 0),
  chargeable    boolean not null default false,
  under_warranty boolean not null default false,
  issued_by     uuid default app.current_user_id(),
  issued_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict
);

create table capas (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  number              text,
  ticket_id           uuid,
  account_id          uuid,
  product_id          uuid,
  title               text not null check (length(title) between 1 and 200),
  severity            text not null default 'minor' check (severity in ('minor', 'major', 'critical')),
  root_cause_category text check (root_cause_category in ('man', 'machine', 'method', 'material', 'measurement', 'environment', 'design', 'supplier', 'other')),
  root_cause          text check (length(root_cause) <= 4000),
  containment         text check (length(containment) <= 4000),
  corrective_action   text check (length(corrective_action) <= 4000),
  preventive_action   text check (length(preventive_action) <= 4000),
  owner_id            uuid,
  due_on              date,
  status              text not null default 'open' check (status in ('open', 'investigating', 'action', 'verifying', 'closed')),
  verified_on         date,
  effective           boolean,
  created_by          uuid default app.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete set null (ticket_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

create table rebate_agreements (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  account_id  uuid not null,
  name        text not null check (length(name) between 1 and 150),
  starts_on   date not null,
  ends_on     date not null,
  basis       text not null default 'value' check (basis in ('value', 'quantity')),
  product_id  uuid,
  slabs       jsonb not null default '[]'::jsonb,   -- [{ "from": 1000000, "pct": 2 }, …] the highest reached applies to all
  status      text not null default 'active' check (status in ('active', 'settled', 'cancelled')),
  notes       text check (length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);

create table dealer_schemes (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name        text not null check (length(name) between 1 and 150),
  starts_on   date not null,
  ends_on     date not null,
  basis       text not null default 'won_deals' check (basis in ('won_deals', 'invoices')),
  dealer_tier text check (length(dealer_tier) <= 40),
  rate_pct    numeric(5, 2) not null check (rate_pct between 0 and 100),
  min_value   numeric(18, 2) not null default 0,
  status      text not null default 'active' check (status in ('active', 'closed')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);

-- ───── IT services: client assets and their history, vault, technical documents ─────
create table client_assets (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  account_id       uuid not null,
  contact_id       uuid,
  kind             text not null default 'laptop' check (kind in ('laptop', 'desktop', 'server', 'network', 'printer', 'mobile', 'peripheral', 'software', 'license', 'cloud', 'domain', 'certificate', 'other')),
  name             text not null check (length(name) between 1 and 150),
  make             text check (length(make) <= 80),
  model            text check (length(model) <= 120),
  serial_no        text check (length(serial_no) <= 120),
  asset_tag        text check (length(asset_tag) <= 60),
  location         text check (length(location) <= 150),
  vendor_name      text check (length(vendor_name) <= 150),
  purchased_on     date,
  cost             numeric(18, 2),
  warranty_ends_on date,
  renews_on        date,
  seats            integer check (seats >= 0),
  seats_used       integer check (seats_used >= 0),
  status           text not null default 'in_use' check (status in ('in_use', 'in_stock', 'repair', 'retired')),
  notes            text check (length(notes) <= 4000),
  reminded_on      date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references contacts (tenant_id, id) on delete set null (contact_id)
);
create index client_assets_account on client_assets (tenant_id, account_id);

create table asset_events (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  asset_id    uuid not null,
  kind        text not null check (kind in ('added', 'assigned', 'returned', 'repair', 'retired', 'renewed', 'note')),
  contact_id  uuid,
  note        text check (length(note) <= 1000),
  actor_id    uuid default app.current_user_id(),
  at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, asset_id) references client_assets (tenant_id, id) on delete cascade
);

create table client_secrets (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  account_id        uuid not null,
  project_id        uuid,
  title             text not null check (length(title) between 1 and 150),
  url               text check (length(url) <= 500),
  username          text check (length(username) <= 200),
  secret_ciphertext text not null,
  notes             text check (length(notes) <= 2000),
  created_by        uuid default app.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_revealed_at  timestamptz,
  last_revealed_by  uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade
);

create table tech_docs (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  account_id  uuid not null,
  project_id  uuid,
  kind        text not null default 'runbook' check (kind in ('runbook', 'architecture', 'configuration', 'sop', 'network', 'other')),
  title       text not null check (length(title) between 1 and 200),
  body        text check (length(body) <= 200000),
  version     integer not null default 1,
  updated_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade
);

-- ───── email sequences ─────
create table email_sequences (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 150),
  steps         jsonb not null default '[]'::jsonb,     -- [{ "day": 0, "subject": "…", "body": "…" }]
  stop_on_reply boolean not null default true,
  status        text not null default 'active' check (status in ('active', 'paused')),
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create table sequence_enrollments (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  sequence_id  uuid not null,
  object       text not null check (object in ('lead', 'contact')),
  record_id    uuid not null,
  email        text not null check (length(email) <= 320),
  step         integer not null default 0,
  next_at      timestamptz,
  status       text not null default 'active' check (status in ('active', 'completed', 'stopped', 'replied', 'failed')),
  sender_id    uuid default app.current_user_id(),
  last_error   text check (length(last_error) <= 500),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, sequence_id, object, record_id),
  foreign key (tenant_id, sequence_id) references email_sequences (tenant_id, id) on delete cascade
);
create index sequence_due on sequence_enrollments (tenant_id, next_at) where status = 'active';

-- ───── connectors ─────
alter table integrations drop constraint integrations_provider_check;
alter table integrations add constraint integrations_provider_check
  check (provider in ('google', 'microsoft', 'razorpay', 'exotel', 'meta_leads', 'google_leads', 'tally', 'teams', 'slack', 'gchat', 'jira', 'azure_devops', 'asana', 'dynamics_bc', 'sap_b1', 'netsuite'));
alter table projects add column external jsonb;          -- { "provider": "jira", "integrationId": "…", "key": "PROJ" }
alter table project_tasks add column external_key text check (length(external_key) <= 120);
alter table project_tasks add column external_url text check (length(external_url) <= 500);

-- ───── public routes for the dealer portal and the help centre ─────
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request', 'dashboard', 'portal', 'roadmap', 'dealer', 'kb'));
create trigger accounts_dealer_route after insert or update of public_token or delete on accounts for each row execute function app.sync_token_route('dealer');
create trigger kb_sites_route after insert or update of public_token or delete on kb_sites for each row execute function app.sync_token_route('kb');

do $$
declare t text;
begin
  foreach t in array array['kb_sites', 'warranties', 'ticket_parts', 'capas', 'rebate_agreements', 'dealer_schemes', 'client_assets', 'asset_events', 'client_secrets', 'tech_docs', 'email_sequences', 'sequence_enrollments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger warranties_audit      after insert or update or delete on warranties      for each row execute function app.audit_row_change('warranty');
create trigger ticket_parts_audit    after insert or update or delete on ticket_parts    for each row execute function app.audit_row_change('ticket_part');
create trigger capas_audit           after insert or update or delete on capas           for each row execute function app.audit_row_change('capa');
create trigger rebates_audit         after insert or update or delete on rebate_agreements for each row execute function app.audit_row_change('rebate_agreement');
create trigger dealer_schemes_audit  after insert or update or delete on dealer_schemes  for each row execute function app.audit_row_change('dealer_scheme');
create trigger client_assets_audit   after insert or update or delete on client_assets   for each row execute function app.audit_row_change('client_asset');
create trigger client_secrets_audit  after insert or update or delete on client_secrets  for each row execute function app.audit_row_change('client_secret');
create trigger tech_docs_audit       after insert or update or delete on tech_docs       for each row execute function app.audit_row_change('tech_doc');
create trigger email_sequences_audit after insert or update or delete on email_sequences for each row execute function app.audit_row_change('email_sequence');

-- an account cannot sit under itself, directly or further up the chain
create or replace function app.guard_account_parent() returns trigger language plpgsql as $$
declare cur uuid := new.parent_account_id; depth int := 0;
begin
  while cur is not null loop
    if cur = new.id then raise exception 'An account cannot be its own parent company' using errcode = '23514'; end if;
    depth := depth + 1;
    if depth > 50 then exit; end if;
    select parent_account_id into cur from accounts where tenant_id = new.tenant_id and id = cur;
  end loop;
  return new;
end $$;
create trigger accounts_parent_guard before insert or update of parent_account_id on accounts for each row
  when (new.parent_account_id is not null) execute function app.guard_account_parent();

-- an order over the customer's credit limit (or on credit hold) needs someone to approve it
alter table sales_orders
  add column credit_approved_by uuid,
  add column credit_approved_at timestamptz,
  add column credit_note        text check (length(credit_note) <= 1000);

-- people can be added to the team before they get a login: no email needed, onboarded later
alter table users alter column email drop not null;
alter table users drop constraint users_status_check;
alter table users add constraint users_status_check check (status in ('profile', 'invited', 'active', 'disabled'));

-- project milestones: in progress, closing needs the customer's approval (a letter or an email),
-- and a finished milestone links to the invoices, receipts, bills and vendor payments it produced
alter table project_milestones drop constraint project_milestones_status_check;
alter table project_milestones add constraint project_milestones_status_check check (status in ('open', 'in_progress', 'done'));
alter table project_milestones
  add column approval_file_id     uuid,
  add column approval_activity_id uuid,
  add column approval_note        text check (length(approval_note) <= 2000),
  add column approved_by          uuid,
  add column approved_at          timestamptz;
-- milestones already closed keep working; the rule applies from now on
create table milestone_links (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  milestone_id  uuid not null,
  kind          text not null check (kind in ('invoice', 'payment', 'bill', 'vendor_payment')),
  target_id     uuid not null,
  linked_by     uuid default app.current_user_id(),
  linked_at     timestamptz not null default now(),
  primary key (tenant_id, milestone_id, kind, target_id),
  foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete cascade
);
alter table milestone_links enable row level security;
alter table milestone_links force row level security;
create policy tenant_isolation on milestone_links as permissive for all to public
  using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on milestone_links to synapse_app;

-- a won IT / software deal opens its contract; the contract keeps the deal it came from
alter table service_contracts add column deal_id uuid;
alter table service_contracts add constraint service_contracts_deal foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id);
create unique index service_contracts_one_per_deal on service_contracts (tenant_id, deal_id) where deal_id is not null;
