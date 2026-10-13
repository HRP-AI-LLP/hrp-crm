-- HRP Synapse · 0008 platform functions (SECURITY DEFINER, narrow surface) and metadata versioning

-- Hostname → tenant. Called by the edge gateway before any tenant context exists.
create or replace function app.resolve_tenant_by_host(p_host text)
returns table (tenant_id uuid, slug text, name text, status text, meta_version integer)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select t.id, t.slug, t.name, t.status, t.meta_version
    from tenant_domains d
    join tenants t on t.id = d.tenant_id
   where d.hostname = lower(p_host)
     and d.status = 'active'
$$;

-- Slug → tenant. Used for {slug}.{base-domain} and for the X-Tenant header in non-prod.
create or replace function app.resolve_tenant_by_slug(p_slug text)
returns table (tenant_id uuid, slug text, name text, status text, meta_version integer)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select t.id, t.slug, t.name, t.status, t.meta_version
    from tenants t
   where t.slug = lower(p_slug)
$$;

-- Public entry points (web-to-lead forms, inbound channel webhooks) are addressed by random keys.
-- Their key → tenant mapping lives in a small registry table (RLS enabled, not forced) maintained
-- by triggers, so lookups never need to bypass RLS on the forced tenant tables.
create table public_routes (
  route_key  text primary key,
  tenant_id  uuid not null references tenants (id) on delete cascade,
  kind       text not null check (kind in ('form', 'channel')),
  target_id  uuid not null,
  unique (kind, target_id)
);
alter table public_routes enable row level security;
create policy tenant_isolation on public_routes for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select on public_routes to synapse_app;

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
    else case when r ->> 'status' = 'active' then r ->> 'inbound_key' end
  end;
  delete from public_routes where kind = k and target_id = new.id;
  if route is not null then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (route, new.tenant_id, k, new.id);
  end if;
  return new;
end
$$;

create trigger forms_public_route after insert or update or delete on forms
  for each row execute function app.sync_public_route('form');
create trigger channel_accounts_public_route after insert or update or delete on channel_accounts
  for each row execute function app.sync_public_route('channel');

create or replace function app.resolve_public_route(p_kind text, p_key text)
returns table (tenant_id uuid, target_id uuid, tenant_status text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select pr.tenant_id, pr.target_id, t.status
    from public_routes pr join tenants t on t.id = pr.tenant_id
   where pr.kind = p_kind and pr.route_key = p_key
$$;

-- ---------------------------------------------------------------------------------------------
-- Metadata version bump → invalidates edge caches keyed by (tenant, meta_version)
-- ---------------------------------------------------------------------------------------------
create or replace function app.bump_meta_version() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update tenants set meta_version = meta_version + 1 where id = app.current_tenant_id();
  return null;
end
$$;

create trigger custom_objects_meta  after insert or update or delete on custom_objects  for each statement execute function app.bump_meta_version();
create trigger custom_fields_meta   after insert or update or delete on custom_fields   for each statement execute function app.bump_meta_version();
create trigger pipelines_meta       after insert or update or delete on pipelines       for each statement execute function app.bump_meta_version();
create trigger pipeline_stages_meta after insert or update or delete on pipeline_stages for each statement execute function app.bump_meta_version();
create trigger roles_meta           after insert or update or delete on roles           for each statement execute function app.bump_meta_version();
create trigger user_roles_meta      after insert or update or delete on user_roles      for each statement execute function app.bump_meta_version();
create trigger tenant_modules_meta  after insert or update or delete on tenant_modules  for each statement execute function app.bump_meta_version();
create trigger forms_meta           after insert or update or delete on forms           for each statement execute function app.bump_meta_version();

-- Rebuild the EAV index for one field (after toggling is_indexed). Runs in the caller's tenant.
create or replace function app.reindex_custom_field(p_object_key text, p_field_key text)
returns integer
language plpgsql as $$
declare
  ftype text;
  n integer := 0;
  tbl text;
begin
  select field_type into ftype from custom_fields
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and key = p_field_key and is_indexed;

  delete from record_index
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and field_key = p_field_key;

  if ftype is null or ftype = 'multipicklist' then
    return 0;
  end if;

  tbl := case p_object_key when 'lead' then 'leads' when 'contact' then 'contacts'
                           when 'account' then 'accounts' when 'deal' then 'deals' else 'records' end;

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
-- Tenant defaults: standard objects, system roles, default pipelines
-- Must run with app.tenant_id already set to p_tenant.
-- ---------------------------------------------------------------------------------------------
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
      (p_tenant, lead_pipe, 'new',         'New',         1,  10, 'open', '#64748b'),
      (p_tenant, lead_pipe, 'contacted',   'Contacted',   2,  25, 'open', '#0ea5e9'),
      (p_tenant, lead_pipe, 'qualified',   'Qualified',   3,  60, 'open', '#8b5cf6'),
      (p_tenant, lead_pipe, 'converted',   'Converted',   4, 100, 'won',  '#16a34a'),
      (p_tenant, lead_pipe, 'unqualified', 'Unqualified', 5,   0, 'lost', '#dc2626');
  end if;

  if not exists (select 1 from pipelines where tenant_id = p_tenant and object_key = 'deal') then
    insert into pipelines (tenant_id, object_key, name, is_default) values (p_tenant, 'deal', 'Sales Pipeline', true)
      returning id into deal_pipe;
    insert into pipeline_stages (tenant_id, pipeline_id, key, label, position, probability, category, color) values
      (p_tenant, deal_pipe, 'prospecting',   'Prospecting',   1,  10, 'open', '#64748b'),
      (p_tenant, deal_pipe, 'qualification', 'Qualification', 2,  25, 'open', '#0ea5e9'),
      (p_tenant, deal_pipe, 'proposal',      'Proposal',      3,  50, 'open', '#8b5cf6'),
      (p_tenant, deal_pipe, 'negotiation',   'Negotiation',   4,  75, 'open', '#f59e0b'),
      (p_tenant, deal_pipe, 'closed_won',    'Closed Won',    5, 100, 'won',  '#16a34a'),
      (p_tenant, deal_pipe, 'closed_lost',   'Closed Lost',   6,   0, 'lost', '#dc2626');
  end if;
end
$$;

-- Self-service / platform tenant provisioning. The only path that can insert into `tenants`.
create or replace function app.create_tenant(
  p_slug           text,
  p_name           text,
  p_base_domain    text,
  p_owner_email    text,
  p_owner_name     text,
  p_password_hash  text
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  prev  text := current_setting('app.tenant_id', true);
  tid   uuid;
  uid   uuid;
begin
  insert into tenants (slug, name) values (lower(p_slug), p_name) returning id into tid;

  perform set_config('app.tenant_id', tid::text, true);

  if coalesce(p_base_domain, '') <> '' then
    insert into tenant_domains (hostname, tenant_id, kind)
    values (lower(p_slug) || '.' || lower(p_base_domain), tid, 'subdomain');
  end if;

  perform app.seed_tenant_defaults(tid);

  insert into users (tenant_id, email, full_name, password_hash, is_owner, status)
  values (tid, lower(p_owner_email), p_owner_name, p_password_hash, true, 'active')
  returning id into uid;

  insert into user_roles (tenant_id, user_id, role_id)
  select tid, uid, r.id from roles r where r.tenant_id = tid and r.key = 'admin';

  insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, changes)
  values (tid, uid, 'tenant_created', 'tenant', tid, jsonb_build_object('slug', lower(p_slug), 'name', p_name));

  perform set_config('app.tenant_id', coalesce(prev, ''), true);
  return tid;
end
$$;

-- Custom domain registration (status pending until Cloudflare for SaaS validates it)
create or replace function app.add_custom_domain(p_hostname text, p_cf_id text, p_verification jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_tenant_id() is null then
    raise exception 'tenant context required';
  end if;
  insert into tenant_domains (hostname, tenant_id, kind, status, cf_custom_hostname_id, verification)
  values (lower(p_hostname), app.current_tenant_id(), 'custom', 'pending', p_cf_id, p_verification);
end
$$;

create or replace function app.set_domain_status(p_hostname text, p_status text, p_verification jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update tenant_domains
     set status = p_status, verification = coalesce(p_verification, verification)
   where hostname = lower(p_hostname) and tenant_id = app.current_tenant_id();
end
$$;

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to synapse_app;
