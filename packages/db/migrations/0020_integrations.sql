-- HRP Synapse · 0020 integrations: Gmail / Outlook mailboxes and calendars, Razorpay payment links,
-- Meta and Google lead ads, Exotel telephony.
--
-- integrations      one connected account per row (a person's mailbox, a workspace's Razorpay or
--                   Exotel account, a Facebook page, a Google Ads lead form endpoint). Secrets are
--                   AES-GCM encrypted with the tenant id as AAD; config holds non-secret settings.
-- external_refs     idempotency: a provider's id (email message, payment, call, lead) is processed once.
-- payment_links     online collection for invoices and order milestones.

create table integrations (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  provider           text not null check (provider in ('google', 'microsoft', 'razorpay', 'exotel', 'meta_leads', 'google_leads')),
  -- mailboxes belong to one person; everything else is workspace-wide
  user_id            uuid,
  label              text check (length(label) <= 200),
  -- provider-side identity: mailbox address, Razorpay key id, Exotel SID, Facebook page id …
  account_ref        text not null check (length(account_ref) between 1 and 320),
  config             jsonb not null default '{}'::jsonb,
  secret_ciphertext  text,
  status             text not null default 'active' check (status in ('active', 'error', 'disabled')),
  -- inbound webhooks address the workspace through this unguessable key (public_routes)
  route_key          text not null unique default encode(gen_random_bytes(18), 'hex'),
  sync_state         jsonb not null default '{}'::jsonb,
  last_sync_at       timestamptz,
  last_event_at      timestamptz,
  last_error         text check (length(last_error) <= 1000),
  error_count        integer not null default 0,
  created_by         uuid default app.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, account_ref),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index integrations_provider on integrations (tenant_id, provider) where status <> 'disabled';
create unique index integrations_one_mailbox_per_person on integrations (tenant_id, user_id, provider) where user_id is not null;

create table external_refs (
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  provider     text not null check (length(provider) <= 80),
  external_id  text not null check (length(external_id) between 1 and 400),
  object_key   text not null,
  record_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, provider, external_id)
);
create index external_refs_record on external_refs (tenant_id, object_key, record_id);

create table payment_links (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  integration_id   uuid not null,
  invoice_id       uuid,
  sales_order_id   uuid,
  milestone_id     uuid,
  account_id       uuid,
  amount           numeric(14, 2) not null check (amount > 0),
  currency         char(3) not null default 'INR',
  purpose          text check (length(purpose) <= 300),
  external_id      text,
  short_url        text check (short_url ~ '^https://'),
  status           text not null default 'created' check (status in ('created', 'paid', 'partially_paid', 'cancelled', 'expired', 'failed')),
  amount_paid      numeric(14, 2) not null default 0,
  payment_id       uuid,
  expires_at       timestamptz,
  paid_at          timestamptz,
  created_by       uuid default app.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check (invoice_id is not null or sales_order_id is not null),
  foreign key (tenant_id, integration_id) references integrations (tenant_id, id) on delete restrict,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, milestone_id) references order_milestones (tenant_id, id) on delete set null (milestone_id),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id) on delete set null (payment_id)
);
create index payment_links_invoice on payment_links (tenant_id, invoice_id);
create index payment_links_order on payment_links (tenant_id, sales_order_id);
create unique index payment_links_external on payment_links (tenant_id, external_id) where external_id is not null;

-- people's own phone (click-to-call rings it first) and sending through their own mailbox
alter table users add column phone text check (phone ~ '^\+?[0-9 ()-]{6,20}$');
alter table messages add column mailbox_id uuid;
alter table messages add column thread_ref text check (length(thread_ref) <= 400);
alter table messages add constraint messages_mailbox_fk foreign key (tenant_id, mailbox_id) references integrations (tenant_id, id) on delete set null (mailbox_id);
-- CRM events mirrored into the owner's Google / Outlook calendar
alter table events add column calendar_ref jsonb;

-- phone matching for calls and WhatsApp: last ten digits
create or replace function app.phone_key(p text) returns text
language sql immutable parallel safe
as $$ select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '') $$;
create index leads_phone_key on leads (tenant_id, app.phone_key(phone)) where deleted_at is null;
create index contacts_phone_key on contacts (tenant_id, app.phone_key(phone)) where deleted_at is null;
create index accounts_phone_key on accounts (tenant_id, app.phone_key(phone)) where deleted_at is null;
create index leads_email_lower on leads (tenant_id, lower(email)) where deleted_at is null;
create index contacts_email_lower on contacts (tenant_id, lower(email)) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- webhook routing: an active integration answers at its route key; Facebook pages also by page id
-- ---------------------------------------------------------------------------------------------
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page'));

create or replace function app.sync_integration_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public_routes where kind in ('integration', 'meta_page') and target_id = old.id;
    return old;
  end if;
  delete from public_routes where kind in ('integration', 'meta_page') and target_id = new.id;
  if new.status <> 'disabled' then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (new.route_key, new.tenant_id, 'integration', new.id);
    if new.provider = 'meta_leads' then
      -- a page can feed one workspace only; a second workspace connecting it is refused (unique key)
      insert into public_routes (route_key, tenant_id, kind, target_id) values ('fbpage-' || new.account_ref, new.tenant_id, 'meta_page', new.id);
    end if;
  end if;
  return new;
end
$$;
create trigger integrations_public_route after insert or update or delete on integrations
  for each row execute function app.sync_integration_route();

do $$
declare t text;
begin
  foreach t in array array['integrations', 'external_refs', 'payment_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger integrations_touch  before update on integrations  for each row execute function app.touch_row();
create trigger payment_links_touch before update on payment_links for each row execute function app.touch_row();
-- secrets never reach the audit log: only the connection facts are recorded
create or replace function app.audit_integration() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, changes)
  values (coalesce(new.tenant_id, old.tenant_id), app.current_user_id(), lower(tg_op), 'integration', coalesce(new.id, old.id),
          jsonb_build_object('provider', coalesce(new.provider, old.provider), 'account', coalesce(new.account_ref, old.account_ref), 'status', coalesce(new.status, old.status)));
  return null;
end
$$;
create trigger integrations_audit after insert or delete or update of status, account_ref, secret_ciphertext on integrations
  for each row execute function app.audit_integration();
