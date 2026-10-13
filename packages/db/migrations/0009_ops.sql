-- HRP Synapse · 0009 operational helpers

-- Tenant ids for scheduled housekeeping (ids only; every follow-up query runs under RLS
-- with that tenant's context set).
create or replace function app.list_active_tenant_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select id from tenants where status = 'active' order by id
$$;

revoke all on function app.list_active_tenant_ids() from public;
grant execute on function app.list_active_tenant_ids() to synapse_app;
