-- HRP Synapse · 0007 Row Level Security + grants
--
-- Tenant data tables: ENABLE + FORCE RLS, so even the table owner is filtered.
-- Platform registry tables (tenants, tenant_domains): ENABLE (app role is filtered) but not FORCE,
-- so the SECURITY DEFINER functions in 0008 (owned by the owner role) can resolve hostnames and
-- create tenants. Those functions expose only narrow, audited operations.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'users', 'roles', 'user_roles', 'sessions',
    'custom_objects', 'custom_fields', 'pipelines', 'pipeline_stages', 'tenant_modules', 'forms',
    'accounts', 'contacts', 'leads', 'deals', 'records', 'record_index', 'tasks', 'activities',
    'workflows', 'workflow_runs', 'channel_accounts', 'messages', 'webhook_subscriptions',
    'kb_documents', 'kb_chunks', 'ai_usage', 'audit_logs'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    -- (select ...) makes the planner evaluate the context once per statement (InitPlan)
    execute format($p$
      create policy tenant_isolation on %I
        as permissive for all to public
        using (tenant_id = (select app.current_tenant_id()))
        with check (tenant_id = (select app.current_tenant_id()))
    $p$, t);
  end loop;
end
$$;

alter table tenants enable row level security;
drop policy if exists tenant_self on tenants;
create policy tenant_self on tenants for all to public
  using (id = (select app.current_tenant_id()))
  with check (id = (select app.current_tenant_id()));

alter table tenant_domains enable row level security;
drop policy if exists tenant_isolation on tenant_domains;
create policy tenant_isolation on tenant_domains for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

-- ---------------------------------------------------------------------------------------------
-- Grants for the runtime role (least privilege)
-- ---------------------------------------------------------------------------------------------
revoke all on schema public from public;
grant usage on schema public to synapse_app;
grant usage on schema app to synapse_app;
revoke all on schema ops from public;

grant select, insert, update, delete on all tables in schema public to synapse_app;

-- tenants: read own row and update settings/name only; creation goes through app.create_tenant()
revoke insert, delete on tenants from synapse_app;
revoke update on tenants from synapse_app;
grant update (name, settings) on tenants to synapse_app;

-- audit trail is append-only for the app
revoke update, delete, truncate on audit_logs from synapse_app;
-- the custom-field index is maintained only by triggers running as the writing role; the app
-- never needs to modify it directly, but triggers execute with the caller's privileges, so DML
-- stays granted and RLS keeps it tenant scoped.

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to synapse_app;
