-- Connection keys set from the app (Settings → Connection keys) instead of the server's .env.
--
-- platform_settings: one value per key for the whole platform (Google / Microsoft / Zoom OAuth apps,
-- the GitHub App, Meta, mail, AI providers, push, GST providers, Cloudflare, Android). Secret values
-- are encrypted with DATA_ENCRYPTION_KEY. Not tenant data, so no row-level security; only platform
-- admins can read or change them through the API.
create table platform_settings (
  key         text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  value_enc   text,
  value_plain text check (length(value_plain) <= 2000),
  is_secret   boolean not null default true,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  check ((value_enc is null) <> (value_plain is null))
);

-- people who manage platform settings (cross-workspace). Empty = the owners of the first workspace.
create table platform_admins (
  tenant_id  uuid not null references tenants (id) on delete cascade,
  user_id    uuid not null,
  added_by   uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

grant select, insert, update, delete on platform_settings, platform_admins to synapse_app;

-- a workspace's own keys where it may bring its own account (GST provider)
create table tenant_keys (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key         text not null check (key ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  value_enc   text,
  value_plain text check (length(value_plain) <= 2000),
  is_secret   boolean not null default true,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, key),
  check ((value_enc is null) <> (value_plain is null))
);
alter table tenant_keys enable row level security;
alter table tenant_keys force row level security;
create policy tenant_isolation on tenant_keys as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on tenant_keys to synapse_app;

-- the platform's own workspace (the first one created): its owners manage platform keys until
-- someone is listed in platform_admins
create or replace function app.first_tenant_id() returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select id from tenants order by created_at, id limit 1
$$;
grant execute on function app.first_tenant_id() to synapse_app;
