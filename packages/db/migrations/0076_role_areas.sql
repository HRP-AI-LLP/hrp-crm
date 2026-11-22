-- Work areas per role (permissions.apps): a role only reaches the parts of the product it is given.
-- Built-in roles get their areas; project managers no longer read every record; a "Project team
-- member" role works only on the projects the person is added to. Roles made by hand keep every
-- area until an administrator narrows them.
create or replace function app.role_areas(p_key text) returns jsonb
language sql immutable as $$
  select case p_key
    when 'admin' then '["*"]'
    when 'read_only' then '["*"]'
    when 'sales_manager' then '["crm","sales","marketing","inbox","calls","service","operations","insights","knowledge"]'
    when 'sales_rep' then '["crm","sales","inbox","calls","insights","knowledge"]'
    when 'project_manager' then '["projects","it","calls","insights","knowledge"]'
    when 'project_member' then '["projects","calls","knowledge"]'
    when 'inventory_manager' then '["operations","sales","knowledge"]'
    when 'operations' then '["operations","sales","knowledge"]'
    when 'technician' then '["operations","service","knowledge"]'
    when 'service_agent' then '["service","inbox","crm","knowledge"]'
    when 'accounts' then '["billing","books","gst","intake","sales","crm","insights","knowledge"]'
    when 'accountant' then '["billing","books","gst","intake","insights","knowledge"]'
    when 'chartered_accountant' then '["books","gst","billing"]'
    when 'production_manager' then '["manufacturing","operations","knowledge"]'
    when 'shop_floor' then '["manufacturing"]'
    else '["*"]'
  end::jsonb
$$;

do $$
declare t uuid;
begin
  for t in select id from tenants loop
    perform set_config('app.tenant_id', t::text, true);
    update roles set permissions = permissions || jsonb_build_object('apps', app.role_areas(key))
     where tenant_id = t and not (permissions ? 'apps') and (is_system or key = 'admin');
    -- roles made by hand: every area, as before (narrow them in Settings → Roles)
    update roles set permissions = permissions || '{"apps":["*"]}'::jsonb where tenant_id = t and not (permissions ? 'apps');
    -- project managers: their own projects (and the ones they are on), not every record
    update roles set permissions = jsonb_set(permissions, '{objects,*}', '{"read":"none","create":false,"update":"none","delete":"none"}'::jsonb, true)
     where tenant_id = t and key = 'project_manager' and is_system;
    -- the team-member role, where projects are switched on
    if exists (select 1 from roles where tenant_id = t and key = 'project_manager') then
      insert into roles (tenant_id, key, name, description, is_system, permissions) values
        (t, 'project_member', 'Project team member', 'Works only on the projects they are added to: their tasks and work items, time, calls and documents. No CRM, sales, billing or books.', true,
         '{"objects":{"*":{"read":"none","create":false,"update":"none","delete":"none"},"expense":{"read":"own","create":true,"update":"own","delete":"own"}},"apps":["projects","calls","knowledge"]}')
      on conflict (tenant_id, key) do nothing;
    end if;
  end loop;
end
$$;

-- new workspaces: the built-in roles get their areas when they are created
create or replace function app.roles_with_areas() returns trigger
language plpgsql as $$
begin
  if not (new.permissions ? 'apps') then
    new.permissions := new.permissions || jsonb_build_object('apps', app.role_areas(new.key));
  end if;
  return new;
end
$$;
drop trigger if exists roles_with_areas on roles;
create trigger roles_with_areas before insert on roles for each row execute function app.roles_with_areas();
