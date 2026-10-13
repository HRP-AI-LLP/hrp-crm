-- HRP Synapse · 0013 sales productivity: products, price books, quotes, email templates,
-- calendar events, notifications, quotas/forecasting, reports and dashboards.

-- ---------------------------------------------------------------------------------------------
-- Products (standard object: lists, views, custom fields, layouts, import/export all apply)
-- ---------------------------------------------------------------------------------------------
create table products (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null,
  sku          text,
  family       text,
  unit         text,
  description  text,
  list_price   numeric(18, 2),
  -- GST rate in percent (0, 5, 12, 18, 28 …)
  tax_rate     numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  hsn_sac      text,
  is_active    boolean not null default true,
  owner_id     uuid,
  custom       jsonb not null default '{}'::jsonb,
  created_by   uuid default app.current_user_id(),
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  merged_into  uuid,
  version      integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index products_sku on products (tenant_id, lower(sku)) where sku is not null and deleted_at is null;
create index products_name_trgm on products using gin (name gin_trgm_ops);

create table price_books (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  description  text,
  currency     char(3) not null default 'INR',
  is_default   boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create unique index price_books_one_default on price_books (tenant_id) where is_default;

create table price_book_entries (
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  price_book_id  uuid not null,
  product_id     uuid not null,
  unit_price     numeric(18, 2) not null check (unit_price >= 0),
  primary key (tenant_id, price_book_id, product_id),
  foreign key (tenant_id, price_book_id) references price_books (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Quotes + line items (totals are computed by the API and stored for reporting)
-- ---------------------------------------------------------------------------------------------
create table quotes (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name            text not null,
  quote_number    text,
  status          text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  deal_id         uuid,
  account_id      uuid,
  contact_id      uuid,
  price_book_id   uuid,
  currency        char(3) not null default 'INR',
  valid_until     date,
  subtotal        numeric(18, 2) not null default 0,
  discount_total  numeric(18, 2) not null default 0,
  tax_total       numeric(18, 2) not null default 0,
  grand_total     numeric(18, 2) not null default 0,
  terms           text,
  notes           text,
  bill_to         jsonb,
  share_token     text unique,
  accepted_at     timestamptz,
  accepted_by     text,
  owner_id        uuid,
  custom          jsonb not null default '{}'::jsonb,
  created_by      uuid default app.current_user_id(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  merged_into     uuid,
  version         integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, contact_id) references contacts (tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, price_book_id) references price_books (tenant_id, id) on delete set null (price_book_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index quotes_number on quotes (tenant_id, quote_number) where quote_number is not null;
create index quotes_deal on quotes (tenant_id, deal_id) where deleted_at is null;
create index quotes_name_trgm on quotes using gin (name gin_trgm_ops);

create table quote_lines (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  quote_id       uuid not null,
  position       integer not null default 0,
  product_id     uuid,
  name           text not null,
  description    text,
  hsn_sac        text,
  unit           text,
  quantity       numeric(14, 3) not null default 1 check (quantity > 0),
  unit_price     numeric(18, 2) not null default 0 check (unit_price >= 0),
  discount_pct   numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  tax_rate       numeric(5, 2) not null default 0 check (tax_rate between 0 and 100),
  line_subtotal  numeric(18, 2) not null default 0,
  line_tax       numeric(18, 2) not null default 0,
  line_total     numeric(18, 2) not null default 0,
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id) references quotes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);
create index quote_lines_quote on quote_lines (tenant_id, quote_id, position);

-- per-tenant counters (quote numbers, …) — row lock makes them gap-free under concurrency
create table tenant_counters (
  tenant_id  uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key        text not null,
  value      bigint not null default 0,
  primary key (tenant_id, key)
);

create or replace function app.next_counter(p_key text) returns bigint
language sql as $$
  insert into tenant_counters (tenant_id, key, value) values (app.current_tenant_id(), p_key, 1)
  on conflict (tenant_id, key) do update set value = tenant_counters.value + 1
  returning value
$$;
grant execute on function app.next_counter(text) to synapse_app;

-- public quote links resolve through the platform route table (like web forms)
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote'));

create or replace function app.sync_public_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  k     text := tg_argv[0];
  r     jsonb;
  route text;
begin
  if tg_op = 'DELETE' then
    delete from public_routes where kind = k and target_id = old.id;
    return old;
  end if;
  r := to_jsonb(new);
  route := case k
    when 'form' then case when r ->> 'kind' = 'public' and (r ->> 'is_active')::boolean then r ->> 'public_key' end
    when 'quote' then case when r ->> 'deleted_at' is null and r ->> 'status' in ('sent', 'accepted', 'rejected') then r ->> 'share_token' end
    else case when r ->> 'status' = 'active' then r ->> 'inbound_key' end
  end;
  delete from public_routes where kind = k and target_id = new.id;
  if route is not null then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (route, new.tenant_id, k, new.id);
  end if;
  return new;
end
$$;
create trigger quotes_public_route after insert or update or delete on quotes for each row execute function app.sync_public_route('quote');

-- ---------------------------------------------------------------------------------------------
-- Email templates
-- ---------------------------------------------------------------------------------------------
create table email_templates (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  object_key  text,
  category    text,
  subject     text not null check (length(subject) <= 300),
  body        text not null check (length(body) <= 20000),
  is_shared   boolean not null default true,
  owner_id    uuid default app.current_user_id(),
  use_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

-- ---------------------------------------------------------------------------------------------
-- Calendar events (meetings, calls, site visits) + reminders + in-app notifications
-- ---------------------------------------------------------------------------------------------
create table events (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  title            text not null check (length(title) between 1 and 200),
  kind             text not null default 'meeting' check (kind in ('meeting', 'call', 'site_visit', 'demo', 'other')),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  all_day          boolean not null default false,
  location         text,
  description      text,
  status           text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  outcome          text,
  related_object   text,
  related_id       uuid,
  owner_id         uuid default app.current_user_id(),
  -- [{"userId": "..."} | {"email": "...", "name": "..."}]
  attendees        jsonb not null default '[]'::jsonb,
  reminder_minutes integer check (reminder_minutes between 0 and 10080),
  -- starts_at − reminder_minutes, maintained by the API
  remind_at        timestamptz,
  reminded_at      timestamptz,
  created_by       uuid default app.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,
  unique (tenant_id, id),
  check (ends_at >= starts_at),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index events_range on events (tenant_id, starts_at);
create index events_related on events (tenant_id, related_object, related_id);
create index events_reminders on events (remind_at) where reminded_at is null and status = 'scheduled';
alter table tasks add column reminded_at timestamptz;
create index tasks_reminders on tasks (remind_at) where reminded_at is null and status in ('open', 'in_progress');

create table notifications (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id     uuid not null,
  kind        text not null,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index notifications_user on notifications (tenant_id, user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Forecasting: quotas per rep per month + manual forecast category on deals
-- ---------------------------------------------------------------------------------------------
create table quotas (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id       uuid not null,
  period_start  date not null check (extract(day from period_start) = 1),
  amount        numeric(18, 2) not null check (amount >= 0),
  primary key (tenant_id, user_id, period_start),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
-- null = derived from stage probability (closed / commit / best case / pipeline)
alter table deals add column forecast_category text check (forecast_category in ('pipeline', 'best_case', 'commit', 'omitted'));

-- ---------------------------------------------------------------------------------------------
-- Reports + dashboards
-- ---------------------------------------------------------------------------------------------
create table reports (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  description  text,
  object_key   text not null,
  -- {type, columns, filters, groupBy, groupBy2, dateBucket, measure:{agg, field}, chart, sort, limit}
  definition   jsonb not null,
  folder       text,
  is_shared    boolean not null default false,
  owner_id     uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

create table dashboards (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  description  text,
  -- [{"reportId": "...", "size": "s" | "m" | "l", "title": "..."}]
  widgets      jsonb not null default '[]'::jsonb,
  is_shared    boolean not null default false,
  owner_id     uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

-- ---------------------------------------------------------------------------------------------
-- RLS, grants, triggers
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['products', 'price_books', 'price_book_entries', 'quotes', 'quote_lines', 'tenant_counters',
                           'email_templates', 'events', 'notifications', 'quotas', 'reports', 'dashboards'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger products_touch        before update on products        for each row execute function app.touch_row();
create trigger quotes_touch          before update on quotes          for each row execute function app.touch_row();
create trigger price_books_touch     before update on price_books     for each row execute function app.touch_row();
create trigger email_templates_touch before update on email_templates for each row execute function app.touch_row();
create trigger events_touch          before update on events          for each row execute function app.touch_row();
create trigger reports_touch         before update on reports         for each row execute function app.touch_row();
create trigger dashboards_touch      before update on dashboards      for each row execute function app.touch_row();

create trigger products_rindex after insert or update or delete on products for each row execute function app.sync_record_index('product');
create trigger quotes_rindex   after insert or update or delete on quotes   for each row execute function app.sync_record_index('quote');

create trigger products_audit        after insert or update or delete on products        for each row execute function app.audit_row_change('product');
create trigger quotes_audit          after insert or update or delete on quotes          for each row execute function app.audit_row_change('quote');
create trigger price_books_audit     after insert or update or delete on price_books     for each row execute function app.audit_row_change('price_book');
create trigger email_templates_audit after insert or update or delete on email_templates for each row execute function app.audit_row_change('email_template');
create trigger events_audit          after insert or update or delete on events          for each row execute function app.audit_row_change('event');

-- reindex knows the new physical tables
create or replace function app.reindex_custom_field(p_object_key text, p_field_key text) returns integer
language plpgsql as $$
declare
  ftype text;
  n integer := 0;
  tbl text;
begin
  select app.field_value_type(field_type, options) into ftype from custom_fields
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and key = p_field_key and is_indexed;

  delete from record_index
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and field_key = p_field_key;

  if ftype is null or ftype = 'multipicklist' then
    return 0;
  end if;

  tbl := case p_object_key when 'lead' then 'leads' when 'contact' then 'contacts'
                           when 'account' then 'accounts' when 'deal' then 'deals'
                           when 'product' then 'products' when 'quote' then 'quotes' else 'records' end;

  execute format($q$
    insert into record_index (tenant_id, object_key, field_key, record_id, v_text, v_num, v_date, v_bool)
    select r.tenant_id, $1, $2, r.id,
           case when $3 in ('text','textarea','email','phone','url','picklist','lookup','user') then left(lower(r.custom ->> $2), 256) end,
           case when $3 in ('number','currency','percent') then app.try_numeric(r.custom ->> $2) end,
           case when $3 in ('date','datetime') then app.try_timestamptz(r.custom ->> $2) end,
           case when $3 = 'boolean' then app.try_boolean(r.custom ->> $2) end
      from %I r
     where r.tenant_id = app.current_tenant_id()
       and r.custom ? $2 and jsonb_typeof(r.custom -> $2) <> 'null'
       %s
  $q$, tbl, case when tbl = 'records' then 'and r.object_key = $1' else '' end)
  using p_object_key, p_field_key, ftype;

  get diagnostics n = row_count;
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Defaults for every workspace: product + quote objects, a standard price book, starter templates
-- ---------------------------------------------------------------------------------------------
create or replace function app.seed_sales_defaults(p_tenant uuid) returns void
language plpgsql as $$
begin
  if app.current_tenant_id() is distinct from p_tenant then
    raise exception 'tenant context mismatch';
  end if;
  insert into custom_objects (tenant_id, key, label, plural_label, icon, is_standard) values
    (p_tenant, 'product', 'Product', 'Products', 'package', true),
    (p_tenant, 'quote',   'Quote',   'Quotes',   'file-text', true)
  on conflict (tenant_id, key) do nothing;
  insert into price_books (tenant_id, name, description, is_default) values
    (p_tenant, 'Standard', 'Default prices', true)
  on conflict (tenant_id, name) do nothing;
  if exists (select 1 from email_templates where tenant_id = p_tenant) then
    return;
  end if;
  insert into email_templates (tenant_id, name, object_key, category, subject, body, owner_id) values
    (p_tenant, 'First touch', 'lead', 'Prospecting', 'Quick question, {{first_name}}',
     E'Hi {{first_name}},\n\nThanks for your interest in {{company}}''s requirements. Could we set up a 15-minute call this week to understand what you need?\n\nBest regards,\n{{me.full_name}}', null),
    (p_tenant, 'Meeting follow-up', null, 'Follow-up', 'Great speaking with you',
     E'Hi {{first_name}},\n\nThank you for your time today. As discussed, I''ll share the next steps shortly.\n\nRegards,\n{{me.full_name}}', null),
    (p_tenant, 'Quote sent', 'quote', 'Quotes', 'Quotation {{quote_number}} — {{name}}',
     E'Hello,\n\nPlease find our quotation {{quote_number}} for {{name}}. Total: {{grand_total}}. It is valid until {{valid_until}}.\n\nView and accept it online: {{quote_link}}\n\nRegards,\n{{me.full_name}}', null);
end
$$;

create or replace function app.seed_tenant_defaults(p_tenant uuid) returns void
language plpgsql as $$
declare
  lead_pipe uuid;
  deal_pipe uuid;
begin
  if app.current_tenant_id() is distinct from p_tenant then
    raise exception 'tenant context mismatch';
  end if;

  insert into custom_objects (tenant_id, key, label, plural_label, icon, is_standard) values
    (p_tenant, 'lead',    'Lead',    'Leads',    'user-plus', true),
    (p_tenant, 'contact', 'Contact', 'Contacts', 'user',      true),
    (p_tenant, 'account', 'Account', 'Accounts', 'building',  true),
    (p_tenant, 'deal',    'Deal',    'Deals',    'handshake', true)
  on conflict (tenant_id, key) do nothing;

  insert into roles (tenant_id, key, name, description, is_system, permissions) values
    (p_tenant, 'admin', 'Administrator', 'Full access including setup', true,
      '{"objects":{"*":{"read":"all","create":true,"update":"all","delete":"all"}},"admin":["*"]}'),
    (p_tenant, 'sales_manager', 'Sales Manager', 'All records, team management, no system setup', true,
      '{"objects":{"*":{"read":"all","create":true,"update":"all","delete":"team"}},"admin":["audit","workflows","reports"]}'),
    (p_tenant, 'sales_rep', 'Sales Representative', 'Own leads and deals; read shared accounts and contacts', true,
      '{"objects":{"*":{"read":"all","create":true,"update":"own","delete":"none"},"lead":{"read":"own","create":true,"update":"own","delete":"none"},"deal":{"read":"own","create":true,"update":"own","delete":"none"},"quote":{"read":"own","create":true,"update":"own","delete":"none"},"product":{"read":"all","create":false,"update":"none","delete":"none"}}}'),
    (p_tenant, 'read_only', 'Read Only', 'View everything, change nothing', true,
      '{"objects":{"*":{"read":"all","create":false,"update":"none","delete":"none"}}}')
  on conflict (tenant_id, key) do nothing;

  if not exists (select 1 from pipelines where tenant_id = p_tenant and object_key = 'lead') then
    insert into pipelines (tenant_id, object_key, name, is_default) values (p_tenant, 'lead', 'Lead Qualification', true)
      returning id into lead_pipe;
    insert into pipeline_stages (tenant_id, pipeline_id, key, label, position, probability, category, color) values
      (p_tenant, lead_pipe, 'new',         'New',         1,  10, 'open', '#94a3b8'),
      (p_tenant, lead_pipe, 'contacted',   'Contacted',   2,  25, 'open', '#35a9f4'),
      (p_tenant, lead_pipe, 'qualified',   'Qualified',   3,  60, 'open', '#06a6c7'),
      (p_tenant, lead_pipe, 'converted',   'Converted',   4, 100, 'won',  '#059669'),
      (p_tenant, lead_pipe, 'unqualified', 'Unqualified', 5,   0, 'lost', '#dc2626');
  end if;

  if not exists (select 1 from pipelines where tenant_id = p_tenant and object_key = 'deal') then
    insert into pipelines (tenant_id, object_key, name, is_default) values (p_tenant, 'deal', 'Sales Pipeline', true)
      returning id into deal_pipe;
    insert into pipeline_stages (tenant_id, pipeline_id, key, label, position, probability, category, color) values
      (p_tenant, deal_pipe, 'prospecting',   'Prospecting',   1,  10, 'open', '#94a3b8'),
      (p_tenant, deal_pipe, 'qualification', 'Qualification', 2,  25, 'open', '#35a9f4'),
      (p_tenant, deal_pipe, 'proposal',      'Proposal',      3,  50, 'open', '#0f8dde'),
      (p_tenant, deal_pipe, 'negotiation',   'Negotiation',   4,  75, 'open', '#075492'),
      (p_tenant, deal_pipe, 'closed_won',    'Closed Won',    5, 100, 'won',  '#059669'),
      (p_tenant, deal_pipe, 'closed_lost',   'Closed Lost',   6,   0, 'lost', '#dc2626');
  end if;

  perform app.seed_sales_defaults(p_tenant);
end
$$;

-- existing workspaces get the new objects too (tenants is not FORCE-RLS for the owner role)
do $$
declare t uuid;
begin
  for t in select id from tenants loop
    perform set_config('app.tenant_id', t::text, true);
    perform app.seed_sales_defaults(t);
    -- sales reps may read products and work on their own quotes in existing workspaces too
    update roles set permissions = jsonb_set(jsonb_set(permissions, '{objects,quote}', '{"read":"own","create":true,"update":"own","delete":"none"}'::jsonb, true),
                                              '{objects,product}', '{"read":"all","create":false,"update":"none","delete":"none"}'::jsonb, true)
     where tenant_id = t and key = 'sales_rep' and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? 'quote');
  end loop;
  perform set_config('app.tenant_id', '', true);
end
$$;
