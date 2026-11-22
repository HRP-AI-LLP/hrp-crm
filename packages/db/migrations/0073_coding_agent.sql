-- Coding agents (Claude Code, Codex) connected over MCP: work items of a project are queued for the
-- agent when they are created or their content changes; the agent claims one, implements and tests
-- it locally, asks for review; a person approves; the agent commits, pushes and releases, reporting
-- every step back to the item.
create table coding_agent_settings (
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id      uuid not null,
  enabled         boolean not null default false,
  work_types      text[] not null default '{story,task,bug}',
  on_create       boolean not null default true,
  on_update       boolean not null default true,
  auto_push       boolean not null default false,          -- push without a person's review (off: review always)
  local_folder    text check (length(local_folder) <= 300), -- where the project lives on the developer's machine
  instructions    text check (length(instructions) <= 8000),-- build / test commands, conventions
  release_command text check (length(release_command) <= 500),
  updated_by      uuid default app.current_user_id(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, project_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

create table coding_agent_jobs (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  task_id       uuid not null,
  status        text not null default 'queued' check (status in ('queued', 'claimed', 'working', 'testing', 'awaiting_review', 'approved', 'changes_requested', 'committed', 'pushed', 'released', 'failed', 'cancelled')),
  reason        text not null default 'created' check (reason in ('created', 'updated', 'requested', 'changes_requested')),
  revision      integer not null default 1,
  seen_revision integer not null default 0,
  agent         text check (length(agent) <= 120),
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  branch        text check (length(branch) <= 200),
  commit_sha    text check (length(commit_sha) <= 64),
  pr_url        text check (length(pr_url) <= 500),
  summary       text check (length(summary) <= 20000),
  test_report   text check (length(test_report) <= 40000),
  how_to_verify text check (length(how_to_verify) <= 8000),
  review_note   text check (length(review_note) <= 8000),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  requested_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade
);
-- one open job per item
create unique index coding_agent_jobs_open on coding_agent_jobs (tenant_id, task_id) where status not in ('released', 'failed', 'cancelled');
create index coding_agent_jobs_queue on coding_agent_jobs (tenant_id, status, created_at);

create table coding_agent_events (
  id        uuid primary key default app.uuidv7(),
  tenant_id uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  job_id    uuid not null,
  at        timestamptz not null default now(),
  actor     text not null check (actor in ('agent', 'person', 'system')),
  stage     text not null check (length(stage) <= 40),
  message   text check (length(message) <= 20000),
  data      jsonb not null default '{}',
  foreign key (tenant_id, job_id) references coding_agent_jobs (tenant_id, id) on delete cascade
);
create index coding_agent_events_job on coding_agent_events (tenant_id, job_id, at);

do $$
declare t text;
begin
  foreach t in array array['coding_agent_settings', 'coding_agent_jobs', 'coding_agent_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

-- items created or changed (title, description, type, reopened) go to the agent's queue; the agent's
-- own changes (app.agent = 1) and status moves alone do not
create function app.queue_agent_job() returns trigger language plpgsql as $$
declare
  s coding_agent_settings%rowtype;
  why text;
begin
  select * into s from coding_agent_settings where tenant_id = new.tenant_id and project_id = new.project_id and enabled;
  if not found or not (new.work_type = any (s.work_types)) or new.status in ('done', 'cancelled') then
    return null;
  end if;
  if coalesce(current_setting('app.agent', true), '') = '1' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if not s.on_create then return null; end if;
    why := 'created';
  else
    if not s.on_update then return null; end if;
    if new.name is not distinct from old.name and new.description is not distinct from old.description and new.work_type = old.work_type
       and not (old.status in ('done', 'cancelled') and new.status not in ('done', 'cancelled')) then
      return null;
    end if;
    why := 'updated';
  end if;
  insert into coding_agent_jobs (tenant_id, project_id, task_id, reason)
  values (new.tenant_id, new.project_id, new.id, why)
  on conflict (tenant_id, task_id) where status not in ('released', 'failed', 'cancelled')
  do update set revision = coding_agent_jobs.revision + 1, reason = excluded.reason, updated_at = now();
  return null;
end
$$;

create trigger project_tasks_agent after insert or update on project_tasks for each row execute function app.queue_agent_job();
