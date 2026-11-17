-- 0034: keep everything the paid GST APIs return, so the app reads from its own database and only
-- calls the provider again when someone asks for fresh data (a Refresh button).
--
--  * gst_api_cache: the latest answer per (scope, kind, key) — scope is a GSTIN, kind what was
--    asked (taxpayer, return_track, gstr2b, ledger_balance…), key its parameters
--  * gst_events gains the provider and the answer itself (credentials are never part of it)

create table gst_api_cache (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  scope       text not null check (length(scope) between 1 and 40),
  kind        text not null check (length(kind) between 1 and 40),
  key         text not null default '' check (length(key) <= 120),
  provider    text check (length(provider) <= 40),
  data        jsonb not null,
  fetched_at  timestamptz not null default now(),
  fetched_by  uuid default app.current_user_id(),
  hits        integer not null default 0,
  primary key (tenant_id, scope, kind, key)
);
create index gst_api_cache_recent on gst_api_cache (tenant_id, fetched_at desc);

alter table gst_api_cache enable row level security;
alter table gst_api_cache force row level security;
create policy tenant_isolation on gst_api_cache as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on gst_api_cache to synapse_app;

alter table gst_events
  add column provider text check (length(provider) <= 40),
  add column data jsonb;
