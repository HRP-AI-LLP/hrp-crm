-- HRP Synapse · 0002 platform registry, identity and access

create table tenants (
  id            uuid primary key default app.uuidv7(),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name          text not null check (length(name) between 1 and 120),
  status        text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  plan          text not null default 'free',
  data_region   text not null default 'ap-southeast-1',
  settings      jsonb not null default '{}'::jsonb,
  -- bumped whenever tenant metadata (objects, fields, pipelines, roles) changes; part of edge cache keys
  meta_version  integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table tenant_domains (
  hostname               text primary key check (hostname = lower(hostname) and hostname ~ '^[a-z0-9.-]+$'),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  kind                   text not null check (kind in ('subdomain', 'custom')),
  status                 text not null default 'active' check (status in ('pending', 'active', 'failed')),
  cf_custom_hostname_id  text,
  verification           jsonb,
  created_at             timestamptz not null default now()
);
create index tenant_domains_tenant_idx on tenant_domains (tenant_id);

create table users (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  email          text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name      text not null,
  password_hash  text,
  status         text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  is_owner       boolean not null default false,
  -- ABAC attributes, e.g. {"region":"west","branch":"pune","department":"retail"}
  attributes     jsonb not null default '{}'::jsonb,
  manager_id     uuid,
  last_login_at  timestamptz,
  failed_logins  integer not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, manager_id) references users (tenant_id, id) on delete set null (manager_id)
);
create unique index users_tenant_email_uq on users (tenant_id, lower(email));
create index users_manager_idx on users (tenant_id, manager_id);

create table roles (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text not null,
  description  text,
  is_system    boolean not null default false,
  -- see packages/shared/src/permissions.ts for the schema
  permissions  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table user_roles (
  tenant_id  uuid not null default app.current_tenant_id(),
  user_id    uuid not null,
  role_id    uuid not null,
  primary key (tenant_id, user_id, role_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete cascade
);

-- Refresh-token sessions with rotation + reuse detection (token family)
create table sessions (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id(),
  user_id       uuid not null,
  family_id     uuid not null,
  refresh_hash  text not null unique,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  replaced_by   uuid,
  user_agent    text,
  ip            text,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index sessions_user_idx on sessions (tenant_id, user_id);
create index sessions_family_idx on sessions (tenant_id, family_id);

create trigger tenants_touch before update on tenants for each row execute function app.touch_row();
create trigger users_touch   before update on users   for each row execute function app.touch_row();
create trigger roles_touch   before update on roles   for each row execute function app.touch_row();
