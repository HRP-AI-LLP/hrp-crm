-- HRP Synapse · 0049 Mail intake: GeM bids, bills and invoices read from the workspace's mailboxes
--
-- intake_mailboxes   mailboxes the workspace reads: IMAP (GoDaddy / Titan / Zoho / any, Gmail with an
--                    app password) or a connected Google / Microsoft account; where reading got to
-- intake_items       mail that matters to the business: GeM alerts, bills, invoices, statements and payment
--                    receipts (others are not kept; from a personal mailbox only mail naming the business)
-- gem_bids           GeM bids the seller follows: from alert mails, corrigenda, the bid document's
--                    eligibility, the documents it asks for, and the pursuit (review → submit → result)

create table intake_mailboxes (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  label              text not null check (length(label) between 1 and 120),
  email              text not null check (length(email) <= 200),
  provider           text not null default 'imap' check (provider in ('imap', 'google', 'microsoft')),
  host               text check (length(host) <= 200),
  port               integer check (port between 1 and 65535),
  tls                boolean not null default true,
  username           text check (length(username) <= 200),
  secret_ciphertext  text,
  integration_id     uuid,
  folder             text not null default 'INBOX' check (length(folder) <= 200),
  read_gem           boolean not null default true,
  read_bills         boolean not null default true,
  -- a personal mailbox: only mail that names the business (its GSTIN, name or a partner) is taken in
  business_only      boolean not null default false,
  uid_validity       bigint,
  last_uid           bigint,
  first_days         integer not null default 7 check (first_days between 1 and 90),
  status             text not null default 'active' check (status in ('active', 'paused', 'error')),
  last_error         text check (length(last_error) <= 1000),
  last_sync_at       timestamptz,
  last_count         integer,
  created_by         uuid default app.current_user_id(),
  created_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, email, folder)
);

create table intake_items (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  mailbox_id    uuid,
  message_id    text not null check (length(message_id) <= 500),
  received_at   timestamptz,
  from_address  text,
  from_name     text,
  subject       text,
  body          text check (length(body) <= 30000),
  kind          text not null check (kind in ('gem_new_bids', 'gem_corrigendum', 'gem_update', 'bill', 'invoice', 'statement', 'payment')),
  matched_on    text check (length(matched_on) <= 200),
  status        text not null default 'new' check (status in ('new', 'done', 'ignored')),
  data          jsonb not null default '{}'::jsonb,
  attachments   jsonb not null default '[]'::jsonb,
  link_object   text,
  link_id       uuid,
  note          text check (length(note) <= 1000),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, message_id),
  foreign key (tenant_id, mailbox_id) references intake_mailboxes (tenant_id, id) on delete set null (mailbox_id)
);
create index intake_items_open on intake_items (tenant_id, status, received_at desc);

create table gem_bids (
  id                   uuid primary key default app.uuidv7(),
  tenant_id            uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bid_number           text not null check (bid_number ~ '^GEM/\d{4}/[A-Z]/\d+$'),
  title                text check (length(title) <= 1000),
  category             text check (length(category) <= 1000),
  quantity             numeric(18, 2),
  ministry             text check (length(ministry) <= 300),
  department           text check (length(department) <= 300),
  organisation         text check (length(organisation) <= 300),
  bid_date             date,
  start_at             timestamptz,
  end_at               timestamptz,
  opening_at           timestamptz,
  emd_amount           numeric(18, 2),
  epbg_percent         numeric(6, 2),
  min_turnover         numeric(18, 2),
  experience_years     numeric(6, 2),
  mse_exempt           boolean,
  startup_exempt       boolean,
  documents_required   jsonb not null default '[]'::jsonb,
  bid_type             text check (length(bid_type) <= 100),
  status               text not null default 'new' check (status in ('new', 'reviewing', 'preparing', 'submitted', 'technically_qualified', 'won', 'lost', 'skipped', 'cancelled')),
  corrigenda           integer not null default 0,
  last_corrigendum_at  timestamptz,
  document_file_id     uuid,
  notes                text check (length(notes) <= 10000),
  owner_id             uuid,
  deal_id              uuid,
  source_item_id       uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, bid_number),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id)
);
create index gem_bids_open on gem_bids (tenant_id, status, end_at);

do $$
declare t text;
begin
  foreach t in array array['intake_mailboxes', 'intake_items', 'gem_bids'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
