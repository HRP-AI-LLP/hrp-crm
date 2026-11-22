-- The working calendar and automatic timesheets: hours per day, working days, public and company
-- holidays, per-person exceptions; time entries filled from task assignments and resource
-- allocations on working days that have no time yet.

create table work_calendar (
  tenant_id      uuid primary key default app.current_tenant_id() references tenants (id) on delete cascade,
  hours_per_day  numeric(4, 2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  work_days      smallint[] not null default '{1,2,3,4,5}' check (work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),   -- ISO weekdays, 1 = Monday
  auto_fill      boolean not null default false,
  auto_from      date,                                   -- the first day filled automatically
  use_tasks      boolean not null default true,          -- open tasks the person is assigned to
  use_allocations boolean not null default true,         -- resource allocations (person → project, hours a week)
  updated_by     uuid default app.current_user_id(),
  updated_at     timestamptz not null default now()
);

create table holidays (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  day         date not null,
  name        text not null check (length(name) between 1 and 120),
  kind        text not null default 'public' check (kind in ('public', 'company', 'optional')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, day, name)
);
create index holidays_day on holidays (tenant_id, day);

-- part-time people, other weekly offs, or no automatic entries for someone
create table user_work_settings (
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id        uuid not null,
  hours_per_day  numeric(4, 2) check (hours_per_day > 0 and hours_per_day <= 24),
  work_days      smallint[] check (work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  auto_fill      boolean,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

alter table time_entries add column auto boolean not null default false;
create index time_entries_user_day on time_entries (tenant_id, user_id, work_date);

do $$
declare t text;
begin
  foreach t in array array['work_calendar', 'holidays', 'user_work_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
