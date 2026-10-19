-- HRP Synapse · 0024 reporting: scheduled email digests and dashboard share links
--
-- report_schedules   Business health, a dashboard or a report emailed daily / weekly / monthly.
--                    Each recipient gets the numbers they are allowed to see (it runs as them).
-- dashboards         gain an expiring read-only share link (runs as the person who shared it).

create table report_schedules (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  kind          text not null check (kind in ('health', 'dashboard', 'report')),
  target_id     uuid,
  frequency     text not null check (frequency in ('daily', 'weekly', 'monthly')),
  send_hour     integer not null default 8 check (send_hour between 0 and 23),
  weekday       integer check (weekday between 1 and 7),
  monthday      integer check (monthday between 1 and 28),
  recipients    uuid[] not null default '{}',
  is_enabled    boolean not null default true,
  next_run_at   timestamptz not null,
  last_sent_at  timestamptz,
  last_error    text check (length(last_error) <= 500),
  owner_id      uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind = 'health' or target_id is not null),
  check (cardinality(recipients) between 1 and 50),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete cascade
);
create index report_schedules_due on report_schedules (next_run_at) where is_enabled;

alter table dashboards
  add column share_token      text unique,
  add column share_expires_at timestamptz,
  add column shared_by        uuid,
  add foreign key (tenant_id, shared_by) references users (tenant_id, id) on delete set null (shared_by);

alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request', 'dashboard'));

create or replace function app.sync_dashboard_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from public_routes where kind = 'dashboard' and target_id = coalesce(new.id, old.id);
  if tg_op <> 'DELETE' and new.share_token is not null then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (new.share_token, new.tenant_id, 'dashboard', new.id);
  end if;
  return null;
end
$$;
create trigger dashboards_share_route after insert or delete or update of share_token on dashboards for each row execute function app.sync_dashboard_route();

alter table report_schedules enable row level security;
alter table report_schedules force row level security;
create policy tenant_isolation on report_schedules as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on report_schedules to synapse_app;
create trigger report_schedules_touch before update on report_schedules for each row execute function app.touch_row();
create trigger report_schedules_audit after insert or delete or update of recipients, kind, target_id, is_enabled on report_schedules for each row execute function app.audit_row_change('report_schedule');
