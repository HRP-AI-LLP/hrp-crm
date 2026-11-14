-- HRP Synapse · 0030 Projects and timesheets (Zoho Projects class)
--
-- projects               the project record (customer, manager, billing method, budget, dates)
-- project_members        who works on it, with bill and cost rates
-- project_milestones     phases with dates (and an amount for fixed-price billing)
-- project_task_lists     groups of tasks
-- project_tasks          tasks and sub-tasks: assignees, dates, estimates, progress, priority
-- project_task_deps      dependencies (finish-to-start etc. with lag) for the Gantt chart
-- project_issues         issues / bugs / snags with severity and status
-- project_comments       discussion on tasks and issues
-- timesheets             a person's week: draft → submitted → approved / rejected
-- time_entries           hours against a project (and task or issue), billable, rated, invoiced
-- resource_capacity      weekly hours a person is available (utilisation)
-- invoices / invoice_lines / bill_lines / expenses link to a project

create table projects (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name               text not null check (length(name) between 1 and 200),
  project_code       text check (length(project_code) <= 40),
  status             text not null default 'active' check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  account_id         uuid,
  deal_id            uuid,
  sales_order_id     uuid,
  start_date         date,
  end_date           date,
  billing_method     text not null default 'time_project_rate' check (billing_method in ('fixed_price', 'time_project_rate', 'time_staff_rate', 'time_task_rate', 'non_billable')),
  project_rate       numeric(18, 2) check (project_rate >= 0),
  fixed_fee          numeric(18, 2) check (fixed_fee >= 0),
  budget_type        text not null default 'none' check (budget_type in ('none', 'hours', 'cost', 'revenue')),
  budget_hours       numeric(10, 2) check (budget_hours >= 0),
  budget_amount      numeric(18, 2) check (budget_amount >= 0),
  currency           char(3) not null default 'INR',
  description        text check (length(description) <= 10000),
  progress           numeric(5, 2) not null default 0,
  tax_rate           numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  hsn_sac            text not null default '998311',
  owner_id           uuid,
  custom             jsonb not null default '{}'::jsonb,
  created_by         uuid default app.current_user_id(),
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  merged_into        uuid,
  version            integer not null default 1,
  unique (tenant_id, id),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index projects_code on projects (tenant_id, lower(project_code)) where project_code is not null and deleted_at is null;
create index projects_account on projects (tenant_id, account_id) where deleted_at is null;

create table project_members (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  user_id       uuid not null,
  role          text not null default 'member' check (role in ('manager', 'member', 'viewer')),
  bill_rate     numeric(18, 2) check (bill_rate >= 0),
  cost_rate     numeric(18, 2) check (cost_rate >= 0),
  added_at      timestamptz not null default now(),
  primary key (tenant_id, project_id, user_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index project_members_user on project_members (tenant_id, user_id);

create table project_milestones (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  name          text not null check (length(name) between 1 and 200),
  start_date    date,
  due_date      date,
  status        text not null default 'open' check (status in ('open', 'done')),
  amount        numeric(18, 2) check (amount >= 0),
  invoice_id    uuid,
  owner_id      uuid,
  position      integer not null default 0,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index project_milestones_project on project_milestones (tenant_id, project_id, position);

create table project_task_lists (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  milestone_id  uuid,
  name          text not null check (length(name) between 1 and 200),
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete set null (milestone_id)
);

create table project_tasks (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id      uuid not null,
  list_id         uuid,
  milestone_id    uuid,
  parent_id       uuid,
  task_number     integer not null,
  name            text not null check (length(name) between 1 and 300),
  description     text check (length(description) <= 20000),
  status          text not null default 'open' check (status in ('open', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  priority        text not null default 'medium' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  assignees       uuid[] not null default '{}',
  start_date      date,
  due_date        date,
  estimate_hours  numeric(10, 2) check (estimate_hours >= 0),
  progress        integer not null default 0 check (progress between 0 and 100),
  billable        boolean not null default true,
  rate            numeric(18, 2) check (rate >= 0),
  tags            text[] not null default '{}',
  position        integer not null default 0,
  completed_at    timestamptz,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, task_number),
  check (due_date is null or start_date is null or due_date >= start_date),
  check (cardinality(assignees) <= 20 and cardinality(tags) <= 20),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, list_id) references project_task_lists (tenant_id, id) on delete set null (list_id),
  foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete set null (milestone_id),
  foreign key (tenant_id, parent_id) references project_tasks (tenant_id, id) on delete cascade
);
create index project_tasks_project on project_tasks (tenant_id, project_id, list_id, position);
create index project_tasks_assignee on project_tasks using gin (assignees);
create index project_tasks_due on project_tasks (tenant_id, due_date) where status not in ('done', 'cancelled');

create table project_task_deps (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  task_id       uuid not null,
  depends_on_id uuid not null,
  kind          text not null default 'fs' check (kind in ('fs', 'ss', 'ff', 'sf')),
  lag_days      integer not null default 0 check (lag_days between -365 and 365),
  primary key (tenant_id, task_id, depends_on_id),
  check (task_id <> depends_on_id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade,
  foreign key (tenant_id, depends_on_id) references project_tasks (tenant_id, id) on delete cascade
);

create table project_issues (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  issue_number  integer not null,
  title         text not null check (length(title) between 1 and 300),
  description   text check (length(description) <= 20000),
  severity      text not null default 'major' check (severity in ('minor', 'major', 'critical', 'blocker')),
  status        text not null default 'open' check (status in ('open', 'in_progress', 'fixed', 'closed', 'reopened', 'wont_fix')),
  assignee_id   uuid,
  reporter_id   uuid default app.current_user_id(),
  task_id       uuid,
  milestone_id  uuid,
  due_date      date,
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, issue_number),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, assignee_id) references users (tenant_id, id) on delete set null (assignee_id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete set null (task_id),
  foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete set null (milestone_id)
);
create index project_issues_project on project_issues (tenant_id, project_id, status);

create table project_comments (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  task_id       uuid,
  issue_id      uuid,
  user_id       uuid default app.current_user_id(),
  body          text not null check (length(body) between 1 and 10000),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  check ((task_id is null) <> (issue_id is null)),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade,
  foreign key (tenant_id, issue_id) references project_issues (tenant_id, id) on delete cascade
);
create index project_comments_task on project_comments (tenant_id, task_id, created_at);
create index project_comments_issue on project_comments (tenant_id, issue_id, created_at);

create table timesheets (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id       uuid not null,
  week_start    date not null check (extract(isodow from week_start) = 1),
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  submitted_at  timestamptz,
  decided_by    uuid,
  decided_at    timestamptz,
  reject_reason text check (length(reject_reason) <= 1000),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, user_id, week_start),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, decided_by) references users (tenant_id, id) on delete set null (decided_by)
);

create table time_entries (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  task_id       uuid,
  issue_id      uuid,
  user_id       uuid not null default app.current_user_id(),
  work_date     date not null,
  minutes       integer not null check (minutes between 0 and 1440),
  notes         text check (length(notes) <= 2000),
  billable      boolean not null default true,
  bill_rate     numeric(18, 2) not null default 0 check (bill_rate >= 0),
  cost_rate     numeric(18, 2) not null default 0 check (cost_rate >= 0),
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'invoiced')),
  timesheet_id  uuid,
  invoice_id    uuid,
  timer_started_at timestamptz,
  approved_by   uuid,
  approved_at   timestamptz,
  -- who last entered or changed the hours (they may not approve them)
  entered_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete set null (task_id),
  foreign key (tenant_id, issue_id) references project_issues (tenant_id, id) on delete set null (issue_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, timesheet_id) references timesheets (tenant_id, id) on delete set null (timesheet_id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id),
  foreign key (tenant_id, approved_by) references users (tenant_id, id) on delete set null (approved_by)
);
create index time_entries_user on time_entries (tenant_id, user_id, work_date);
create index time_entries_project on time_entries (tenant_id, project_id, work_date);
create index time_entries_unbilled on time_entries (tenant_id, project_id) where status = 'approved' and billable and invoice_id is null;
-- at most one running timer per person
create unique index time_entries_timer on time_entries (tenant_id, user_id) where timer_started_at is not null;

-- approved and invoiced hours are settled: only the workflow may move them on
create or replace function app.guard_time_entry() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('submitted', 'approved', 'invoiced') then
      raise exception 'submitted, approved or invoiced time cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status in ('submitted', 'approved', 'invoiced')
     and (to_jsonb(new) - array['status', 'timesheet_id', 'invoice_id', 'approved_by', 'approved_at', 'updated_at'])
         is distinct from (to_jsonb(old) - array['status', 'timesheet_id', 'invoice_id', 'approved_by', 'approved_at', 'updated_at']) then
    raise exception 'submitted, approved or invoiced time cannot be edited' using errcode = 'check_violation';
  end if;
  -- the workflow only moves forward: invoiced time goes back to approved only when its invoice is cancelled
  if old.status = 'invoiced' and new.status not in ('invoiced', 'approved') or old.status = 'approved' and new.status not in ('approved', 'invoiced') then
    raise exception 'approved or invoiced time cannot go back to draft' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger time_entries_guard before update or delete on time_entries for each row execute function app.guard_time_entry();

create table resource_capacity (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id       uuid not null,
  weekly_hours  numeric(5, 2) not null default 40 check (weekly_hours between 0 and 100),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

-- documents that belong to a project
alter table invoices add column project_id uuid;
alter table invoices add constraint invoices_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id);
alter table invoice_lines add column project_id uuid;
alter table expenses add constraint expenses_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id);
alter table bill_lines add constraint bill_lines_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id);
alter table budgets add constraint budgets_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade;
create index invoices_project on invoices (tenant_id, project_id) where project_id is not null;
create index expenses_project on expenses (tenant_id, project_id) where project_id is not null;

-- the issued-invoice guard lets the project link be set (it is metadata, not tax content)
create or replace function app.guard_issued_invoice() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and old.invoice_number is not null then
    if (to_jsonb(new) - array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                              'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at', 'project_id'])
       is distinct from
       (to_jsonb(old) - array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                              'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at', 'project_id']) then
      raise exception 'issued invoice % cannot be changed', old.invoice_number using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

-- ------------------------------------------------------------------------------------- RLS, grants, triggers
do $$
declare t text;
begin
  foreach t in array array['projects', 'project_members', 'project_milestones', 'project_task_lists', 'project_tasks', 'project_task_deps', 'project_issues',
                           'project_comments', 'timesheets', 'time_entries', 'resource_capacity'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger projects_touch       before update on projects       for each row execute function app.touch_row();
create trigger project_tasks_touch  before update on project_tasks  for each row execute function app.touch_row();
create trigger project_issues_touch before update on project_issues for each row execute function app.touch_row();
create trigger time_entries_touch   before update on time_entries   for each row execute function app.touch_row();
create trigger projects_rindex      after insert or update or delete on projects for each row execute function app.sync_record_index('project');
create trigger projects_audit       after insert or update or delete on projects for each row execute function app.audit_row_change('project');
create trigger time_entries_audit   after insert or update or delete on time_entries for each row execute function app.audit_row_change('time_entry');
create trigger timesheets_audit     after insert or update on timesheets for each row execute function app.audit_row_change('timesheet');
