-- HRP Synapse · 0011 saved list views, import jobs, merge support, brand stage colours

-- Saved list views: personal (owner_id = me) or shared with the whole workspace.
create table list_views (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  name        text not null check (length(name) between 1 and 80),
  owner_id    uuid,
  is_shared   boolean not null default false,
  -- [{field, op, value}]
  filters     jsonb not null default '[]'::jsonb,
  columns     text[] not null default '{}',
  sort        jsonb,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete cascade
);
create index list_views_lookup on list_views (tenant_id, object_key);

-- CSV import bookkeeping (rows are processed in batches by the API)
create table import_jobs (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key   text not null,
  file_name    text,
  mode         text not null default 'create' check (mode in ('create', 'upsert')),
  match_field  text,
  status       text not null default 'running' check (status in ('running', 'completed', 'failed')),
  total_rows   integer not null default 0,
  created      integer not null default 0,
  updated      integer not null default 0,
  failed       integer not null default 0,
  errors       jsonb not null default '[]'::jsonb,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['list_views', 'import_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger list_views_touch before update on list_views for each row execute function app.touch_row();

-- merged duplicates point at the surviving record (kept for audit and redirects)
alter table leads    add column merged_into uuid;
alter table contacts add column merged_into uuid;
alter table accounts add column merged_into uuid;
alter table deals    add column merged_into uuid;
alter table records  add column merged_into uuid;

-- duplicate lookups
create index contacts_phone_digits on contacts (tenant_id, right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)) where deleted_at is null;
create index leads_phone_digits    on leads    (tenant_id, right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)) where deleted_at is null;
create index accounts_domain_lower on accounts (tenant_id, lower(domain)) where deleted_at is null;

-- New workspaces get pipeline colours from the hrpai.in palette (existing data is untouched)
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
      '{"objects":{"*":{"read":"all","create":true,"update":"all","delete":"team"}},"admin":["audit","workflows"]}'),
    (p_tenant, 'sales_rep', 'Sales Representative', 'Own leads and deals; read shared accounts and contacts', true,
      '{"objects":{"*":{"read":"all","create":true,"update":"own","delete":"none"},"lead":{"read":"own","create":true,"update":"own","delete":"none"},"deal":{"read":"own","create":true,"update":"own","delete":"none"}}}'),
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
end
$$;
