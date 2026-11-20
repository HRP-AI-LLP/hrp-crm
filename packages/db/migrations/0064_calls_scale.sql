-- Round 24 (part 2): long recordings, speakers, emailed invites, learned call filing, and indexes
-- for projects with tens of thousands of work items.

-- parts of a long recording cut in the browser, each transcribed with its time offset
create table call_transcript_parts (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  event_id    uuid not null,
  file_id     uuid not null,
  idx         int not null check (idx >= 0 and idx < 500),
  total       int not null check (total > 0 and total <= 500),
  segments    jsonb not null default '[]',
  engine      text check (engine in ('nova-3', 'whisper')),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, file_id, idx)
);

-- the same meeting from the calendar and from an emailed .ics
alter table events add column ical_uid text check (length(ical_uid) <= 300);
create index events_ical_uid on events (tenant_id, ical_uid, starts_at) where ical_uid is not null;

-- what people taught Synapse when they moved a call to a project: a recurring title, the
-- outside people and their company's email domain
create table call_filing_hints (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id     uuid not null,
  kind        text not null check (kind in ('title', 'email', 'domain')),
  value       text not null check (length(value) <= 300),
  project_id  uuid not null,
  hits        int not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id, kind, value, project_id)
);
create index call_filing_hints_lookup on call_filing_hints (tenant_id, user_id, kind, value);

do $$
declare t text;
begin
  foreach t in array array['call_transcript_parts', 'call_filing_hints'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

-- projects with tens of thousands of work items
create index if not exists project_tasks_state on project_tasks (tenant_id, project_id, status, completed_at);
create index if not exists project_tasks_changed on project_tasks (tenant_id, project_id, updated_at desc);
create index if not exists project_task_history_project on project_task_history (tenant_id, project_id, at desc);
create index if not exists time_entries_task on time_entries (tenant_id, task_id) where task_id is not null;
create index if not exists pm_code_events_project on pm_code_events (tenant_id, project_id, at desc);
