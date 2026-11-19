-- Work management in projects, in the manner of Jira and Azure DevOps:
--   work item keys (FLEET-12), a hierarchy (epic → feature → story / bug / task → sub-task),
--   workflows per work item type (states mapped to status categories, transitions with rules),
--   configurable boards (scrum / kanban, columns with WIP limits, swimlanes, quick filters),
--   saved queries in a small query language, dashboards of widgets, components and custom fields,
--   a change history of every work item (powers cumulative flow and cycle time), watchers,
--   relations between items, code links from GitHub / Azure Repos webhooks (branches, commits,
--   pull requests, builds), and test plans with test cases and runs.

/* ───────────── work items ───────────── */

alter table project_tasks drop constraint project_tasks_work_type_check;
alter table project_tasks add constraint project_tasks_work_type_check check (work_type in ('task', 'story', 'bug', 'epic', 'feature', 'spike', 'chore', 'subtask'));
alter table project_tasks
  add column state           text check (length(state) <= 40),         -- workflow state key; null = the first state of the status category
  add column reporter_id     uuid,
  add column component_ids   uuid[] not null default '{}',
  add column custom          jsonb not null default '{}'::jsonb,
  add column severity        text check (severity in ('minor', 'major', 'critical', 'blocker')),
  add column resolution      text check (length(resolution) <= 60),
  add column remaining_hours numeric(10, 2) check (remaining_hours >= 0),
  add column started_at      timestamptz,                               -- first time work started (cycle time)
  add constraint project_tasks_components check (cardinality(component_ids) <= 20);
create index project_tasks_parent on project_tasks (tenant_id, parent_id) where parent_id is not null;
create index project_tasks_epic on project_tasks (tenant_id, epic_id) where epic_id is not null;
update project_tasks set reporter_id = created_by where reporter_id is null;
update project_tasks set started_at = coalesce(completed_at, updated_at) where started_at is null and status in ('in_progress', 'review', 'blocked', 'done');

alter table projects
  add column work_key      text check (work_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  add column work_settings jsonb not null default '{}'::jsonb;       -- { estimation, autoTransitions: { branch, prOpened, prMerged, buildFailed } }
create unique index projects_work_key on projects (tenant_id, work_key) where work_key is not null;

/* ───────────── history and watchers ───────────── */

create table project_task_history (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  task_id     uuid not null,
  actor_id    uuid,
  field       text not null,
  old_value   text,
  new_value   text,
  at          timestamptz not null default now(),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade
);
create index project_task_history_task on project_task_history (tenant_id, task_id, at);
create index project_task_history_flow on project_task_history (tenant_id, project_id, field, at);

create or replace function app.project_task_history() returns trigger language plpgsql as $$
declare
  actor uuid := app.current_user_id();
  f text;
  o text;
  n text;
begin
  if tg_op = 'INSERT' then
    insert into project_task_history (tenant_id, project_id, task_id, actor_id, field, new_value) values (new.tenant_id, new.project_id, new.id, actor, 'created', new.status);
    return null;
  end if;
  foreach f in array array['status', 'state', 'name', 'priority', 'assignees', 'work_type', 'story_points', 'sprint_id', 'release_id', 'epic_id', 'parent_id', 'due_date',
                           'component_ids', 'severity', 'resolution', 'remaining_hours', 'estimate_hours', 'tags', 'description'] loop
    execute format('select ($1).%1$I::text, ($2).%1$I::text', f) into o, n using old, new;
    if o is distinct from n then
      insert into project_task_history (tenant_id, project_id, task_id, actor_id, field, old_value, new_value)
      values (new.tenant_id, new.project_id, new.id, actor, f, case when f = 'description' then left(o, 400) else o end, case when f = 'description' then left(n, 400) else n end);
    end if;
  end loop;
  return null;
end;
$$;
create trigger project_tasks_history after insert or update on project_tasks for each row execute function app.project_task_history();

-- the first move into work stamps started_at; moving back to "open" keeps it (cycle time counts from the first start)
create or replace function app.project_task_started() returns trigger language plpgsql as $$
begin
  if new.status in ('in_progress', 'review', 'blocked', 'done') and new.started_at is null then new.started_at := now(); end if;
  if tg_op = 'INSERT' then return new; end if;
  -- a new status category with the same state means the status was set directly: let the state follow it
  if new.status is distinct from old.status and new.state is not distinct from old.state then new.state := null; end if;
  return new;
end;
$$;
create trigger project_tasks_started before insert or update on project_tasks for each row execute function app.project_task_started();

create table project_task_watchers (
  tenant_id  uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  task_id    uuid not null,
  user_id    uuid not null,
  added_at   timestamptz not null default now(),
  primary key (tenant_id, task_id, user_id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index project_task_watchers_user on project_task_watchers (tenant_id, user_id);

create table project_task_relations (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  task_id     uuid not null,
  other_id    uuid not null,
  kind        text not null check (kind in ('relates', 'blocks', 'duplicates', 'clones', 'causes', 'tests')),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, task_id, other_id, kind),
  check (task_id <> other_id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade,
  foreign key (tenant_id, other_id) references project_tasks (tenant_id, id) on delete cascade
);
create index project_task_relations_other on project_task_relations (tenant_id, other_id);

/* ───────────── configuration ───────────── */

create table pm_workflows (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  name        text not null check (length(name) between 1 and 80),
  work_types  text[] not null default '{}',     -- empty = every type not covered by another workflow
  states      jsonb not null,                   -- [{ key, label, category, color? }]
  transitions jsonb not null default '[]'::jsonb, -- [{ from: key | '*', to: key, name?, roles?: ['manager','member'], require?: [...] }]; none = any move
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index pm_workflows_project on pm_workflows (tenant_id, project_id);

create table project_components (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  name        text not null check (length(name) between 1 and 80),
  description text check (length(description) <= 1000),
  lead_id     uuid,
  assign_lead boolean not null default false,  -- new items in the component go to the lead
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, name),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, lead_id) references users (tenant_id, id) on delete set null (lead_id)
);

create table pm_field_defs (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null check (length(label) between 1 and 80),
  type        text not null check (type in ('text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url')),
  options     text[] not null default '{}',
  work_types  text[] not null default '{}',     -- empty = every type
  required    boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, key),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

create table project_boards (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  name          text not null check (length(name) between 1 and 80),
  kind          text not null default 'kanban' check (kind in ('scrum', 'kanban')),
  columns       jsonb not null,                -- [{ name, states: [key], wip: n | null }]
  swimlane      text not null default 'none' check (swimlane in ('none', 'assignee', 'epic', 'parent', 'priority', 'type')),
  filter        text check (length(filter) <= 2000),
  quick_filters jsonb not null default '[]'::jsonb,  -- [{ name, query }]
  card_fields   text[] not null default '{points,assignee,priority}',
  position      integer not null default 0,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

create table pm_queries (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid,                             -- null = across my projects
  name        text not null check (length(name) between 1 and 120),
  query       text not null check (length(query) <= 4000),
  columns     text[] not null default '{key,type,name,state,assignee,priority,points}',
  shared      boolean not null default false,
  owner_id    uuid not null default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete cascade
);
create index pm_queries_owner on pm_queries (tenant_id, owner_id);

create table pm_dashboards (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  name        text not null check (length(name) between 1 and 120),
  widgets     jsonb not null default '[]'::jsonb,   -- [{ id, type, title, query?, groupBy?, days?, size }]
  shared      boolean not null default true,
  owner_id    uuid not null default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

/* ───────────── code links ───────────── */

alter table project_task_links drop constraint project_task_links_kind_check;
alter table project_task_links add constraint project_task_links_kind_check check (kind in ('pr', 'commit', 'branch', 'build', 'doc', 'design', 'other'));
alter table project_task_links drop constraint project_task_links_status_check;
alter table project_task_links add constraint project_task_links_status_check check (status in ('open', 'merged', 'closed', 'draft', 'running', 'succeeded', 'failed'));
alter table project_task_links
  add column source      text not null default 'manual' check (source in ('manual', 'github', 'azure')),
  add column external_id text check (length(external_id) <= 300),
  add column author      text check (length(author) <= 200),
  add column repo        text check (length(repo) <= 200),
  add column occurred_at timestamptz;
create unique index project_task_links_external on project_task_links (tenant_id, task_id, external_id) where external_id is not null;

alter table integrations drop constraint integrations_provider_check;
alter table integrations add constraint integrations_provider_check
  check (provider in ('google', 'microsoft', 'razorpay', 'exotel', 'meta_leads', 'google_leads', 'tally', 'teams', 'slack', 'gchat', 'jira', 'azure_devops', 'asana', 'dynamics_bc', 'sap_b1', 'netsuite',
                      'zoom_meet', 'google_meet', 'ms_teams_meet', 'github', 'azure_repos'));

/* ───────────── tests ───────────── */

create table pm_test_cases (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  case_number   integer not null,
  title         text not null check (length(title) between 1 and 300),
  suite         text check (length(suite) <= 120),
  preconditions text check (length(preconditions) <= 4000),
  steps         jsonb not null default '[]'::jsonb,   -- [{ action, expected }]
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status        text not null default 'ready' check (status in ('draft', 'ready', 'obsolete')),
  item_ids      uuid[] not null default '{}',         -- work items (requirements) this case covers
  automated     boolean not null default false,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, case_number),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

create table pm_test_plans (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  name        text not null check (length(name) between 1 and 120),
  sprint_id   uuid,
  release_id  uuid,
  status      text not null default 'active' check (status in ('planned', 'active', 'done')),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sprint_id) references project_sprints (tenant_id, id) on delete set null (sprint_id),
  foreign key (tenant_id, release_id) references project_releases (tenant_id, id) on delete set null (release_id)
);

create table pm_test_runs (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  plan_id      uuid not null,
  case_id      uuid not null,
  result       text not null default 'untested' check (result in ('untested', 'passed', 'failed', 'blocked', 'skipped')),
  tester_id    uuid,
  notes        text check (length(notes) <= 4000),
  step_results jsonb not null default '[]'::jsonb,   -- ['passed' | 'failed' | null per step]
  bug_id       uuid,
  history      jsonb not null default '[]'::jsonb,   -- earlier results [{ result, by, at }]
  run_at       timestamptz,
  unique (tenant_id, plan_id, case_id),
  foreign key (tenant_id, plan_id) references pm_test_plans (tenant_id, id) on delete cascade,
  foreign key (tenant_id, case_id) references pm_test_cases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bug_id) references project_tasks (tenant_id, id) on delete set null (bug_id)
);

do $$
declare t text;
begin
  foreach t in array array['project_task_history', 'project_task_watchers', 'project_task_relations', 'pm_workflows', 'project_components', 'pm_field_defs', 'project_boards',
                           'pm_queries', 'pm_dashboards', 'pm_test_cases', 'pm_test_plans', 'pm_test_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
