-- Usage & costs: calls to every outside service, Worker requests and jobs, database queries, AI
-- tokens, stored bytes, per workspace and day (India's day). Written in one upsert per request.
-- The platform's own work (cron, queue jobs without a workspace) uses the all-zero workspace key.
-- Not tenant data: no row-level security; the API shows a workspace its own rows and platform admins all.
create table usage_daily (
  day         date not null,
  tenant_key  uuid not null,
  provider    text not null check (length(provider) <= 100),
  kind        text not null check (length(kind) <= 60),
  calls       bigint not null default 0,
  errors      bigint not null default 0,
  units       numeric(24, 4) not null default 0,
  ms          bigint not null default 0,
  primary key (day, tenant_key, provider, kind)
);
create index usage_daily_tenant on usage_daily (tenant_key, day);

-- the price list the estimates use (set by platform admins; defaults in code)
create table usage_prices (
  id          smallint primary key default 1 check (id = 1),
  data        jsonb not null default '{}',
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

grant select, insert, update, delete on usage_daily, usage_prices to synapse_app;
