-- HRP Synapse · 0026 developer platform: webhook delivery log, per-key rate limits
--
-- webhook_deliveries   every attempt to deliver an event: status, time taken, error, and the
--                      payload so a failed delivery can be sent again. Kept 30 days.

create table webhook_deliveries (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  subscription_id  uuid not null,
  event            text not null check (length(event) <= 120),
  payload          jsonb not null,
  status_code      integer,
  ok               boolean not null default false,
  duration_ms      integer,
  error            text check (length(error) <= 500),
  attempt          integer not null default 1,
  redelivery_of    uuid,
  created_at       timestamptz not null default now()
);
create index webhook_deliveries_sub on webhook_deliveries (tenant_id, subscription_id, created_at desc);
create index webhook_deliveries_age on webhook_deliveries (created_at);

alter table webhook_subscriptions
  add column name              text check (length(name) <= 120),
  add column created_by        uuid default app.current_user_id(),
  add column last_delivery_at  timestamptz,
  add column last_status       integer;
alter table webhook_subscriptions add constraint webhook_subscriptions_tenant_id_id_key unique (tenant_id, id);
alter table webhook_deliveries add foreign key (tenant_id, subscription_id) references webhook_subscriptions (tenant_id, id) on delete cascade;

alter table api_keys add column rate_limit_per_min integer not null default 600 check (rate_limit_per_min between 10 and 6000);

alter table webhook_deliveries enable row level security;
alter table webhook_deliveries force row level security;
create policy tenant_isolation on webhook_deliveries as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on webhook_deliveries to synapse_app;
