-- Match & reconcile: what people decided about SanchalanOS's matching suggestions (rejected ones stay hidden).
create table reconcile_decisions (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key         text not null check (length(key) <= 300),
  kind        text not null check (length(kind) <= 40),
  status      text not null check (status in ('approved', 'rejected')),
  detail      jsonb,
  decided_by  uuid default app.current_user_id(),
  decided_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);
alter table reconcile_decisions enable row level security;
alter table reconcile_decisions force row level security;
create policy tenant_isolation on reconcile_decisions as permissive for all to public
  using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on reconcile_decisions to synapse_app;
