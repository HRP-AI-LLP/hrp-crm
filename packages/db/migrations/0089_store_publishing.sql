-- App-store publishing: connect a Google Play (service account) or App Store Connect (API key)
-- account, link an in-house mobile project to its store app, and track each release's store status.
create table if not exists store_connections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('google_play', 'app_store')),
  label       text not null check (length(label) between 1 and 120),
  secret_enc  text not null,                 -- the service-account JSON / App Store Connect key, encrypted
  meta        jsonb not null default '{}',   -- non-secret bits: client_email, key_id, issuer_id
  status      text not null default 'active' check (status in ('active', 'error')),
  created_by  uuid references users(id),
  created_at  timestamptz not null default now()
);
create index if not exists store_connections_tenant on store_connections(tenant_id) where status = 'active';
alter table store_connections enable row level security;
alter table store_connections force row level security;
create policy tenant_isolation on store_connections as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on store_connections to synapse_app;

-- which store app a project ships as
alter table projects
  add column if not exists store_connection_id uuid references store_connections(id) on delete set null,
  add column if not exists store_app_id text,          -- Android package name / iOS bundle id, e.g. in.hrpai.ludoverse
  add column if not exists store_default_track text;    -- internal | closed | open | production (Play); testflight | appstore (iOS)

-- a release channel's store submission, tracked from the store API
alter table project_release_channels
  add column if not exists store_track text,
  add column if not exists store_version text,          -- versionName shown in the store
  add column if not exists store_version_code text,      -- Android versionCode / iOS build number
  add column if not exists store_status text,            -- draft | uploaded | in_review | approved | rejected | live | halted
  add column if not exists store_checked_at timestamptz;
