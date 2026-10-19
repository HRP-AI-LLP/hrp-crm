-- HRP Synapse · 0023 business health: KPI targets
--
-- kpi_targets   the number each KPI should reach (or stay under), per workspace. Industry
--               solutions seed sensible starting targets; admins change them in Business health.

create table kpi_targets (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  kpi         text not null check (kpi ~ '^[a-z][a-z0-9_]{1,60}$'),
  target      numeric(18, 4) not null,
  updated_by  uuid default app.current_user_id(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, kpi)
);

alter table kpi_targets enable row level security;
alter table kpi_targets force row level security;
create policy tenant_isolation on kpi_targets as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on kpi_targets to synapse_app;
create trigger kpi_targets_touch before update on kpi_targets for each row execute function app.touch_row();

-- KPI queries: first touch on a lead, quotes per deal, deliveries by date
create index if not exists activities_first_touch on activities (tenant_id, related_object, related_id, occurred_at) where direction = 'out';
create index if not exists quotes_deal_created on quotes (tenant_id, deal_id, created_at) where deleted_at is null;
