-- HRP Synapse · 0048 IT company suite on top of Projects
--
-- Agile delivery
--   project_tasks (+)        work type (story, bug, epic…), story points, sprint, release, epic, backlog rank
--   project_sprints          time-boxed sprints: goal, dates, capacity, committed / completed points
--   project_releases         versions with target date, status and release notes
--   project_task_links       pull requests, commits, branches and documents on a task
-- Services and contracts
--   service_contracts        retainers, AMC, time & materials, fixed-bid SOWs, support; hours, SLA, renewals
--   change_requests          scope changes with hours / cost / schedule impact and client approval
--   resource_allocations     who is planned on which project, hours a week, for capacity planning
-- SaaS subscriptions
--   saas_plans               plans: interval, price, seats, usage pricing, trial
--   saas_subscriptions       a customer's subscription: status, period, seats, discount, auto-invoicing
--   saas_sub_addons          add-ons on a subscription
--   saas_usage               metered usage per period
--   saas_events              the subscription's history with MRR before / after (MRR movements, churn)
-- Product management
--   pm_products              products with vision and owner (public roadmap link)
--   pm_items                 roadmap items scored with RICE, by quarter, linked to releases and tasks
--   pm_requests              feature requests from customers, linked to roadmap items (votes)
-- projects.portal_token       a read-only client portal link per project

/* ───────────── agile ───────────── */

create table project_sprints (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id       uuid not null,
  name             text not null check (length(name) between 1 and 120),
  goal             text check (length(goal) <= 2000),
  start_date       date not null,
  end_date         date not null,
  status           text not null default 'planned' check (status in ('planned', 'active', 'closed')),
  capacity_points  numeric(8, 1) check (capacity_points >= 0),
  committed_points numeric(8, 1),
  completed_points numeric(8, 1),
  started_at       timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check (end_date >= start_date),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index project_sprints_project on project_sprints (tenant_id, project_id, status);
-- one running sprint per project
create unique index project_sprints_one_active on project_sprints (tenant_id, project_id) where status = 'active';

create table project_releases (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id   uuid not null,
  name         text not null check (length(name) between 1 and 120),
  version      text check (length(version) <= 40),
  target_date  date,
  status       text not null default 'planned' check (status in ('planned', 'in_progress', 'released', 'cancelled')),
  released_at  date,
  notes        text check (length(notes) <= 50000),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index project_releases_project on project_releases (tenant_id, project_id);

alter table project_tasks
  add column work_type    text not null default 'task' check (work_type in ('task', 'story', 'bug', 'epic', 'spike', 'chore')),
  add column story_points numeric(6, 1) check (story_points >= 0 and story_points <= 1000),
  add column sprint_id    uuid,
  add column release_id   uuid,
  add column epic_id      uuid,
  add column backlog_rank integer not null default 0,
  add foreign key (tenant_id, sprint_id) references project_sprints (tenant_id, id) on delete set null (sprint_id),
  add foreign key (tenant_id, release_id) references project_releases (tenant_id, id) on delete set null (release_id),
  add foreign key (tenant_id, epic_id) references project_tasks (tenant_id, id) on delete set null (epic_id);
create index project_tasks_sprint on project_tasks (tenant_id, sprint_id) where sprint_id is not null;
create index project_tasks_release on project_tasks (tenant_id, release_id) where release_id is not null;

create table project_task_links (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  task_id     uuid not null,
  kind        text not null default 'pr' check (kind in ('pr', 'commit', 'branch', 'doc', 'design', 'other')),
  url         text not null check (url ~ '^https?://' and length(url) <= 1000),
  title       text check (length(title) <= 300),
  status      text check (status in ('open', 'merged', 'closed', 'draft')),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete cascade
);
create index project_task_links_task on project_task_links (tenant_id, task_id);

/* ───────────── services and contracts ───────────── */

create table service_contracts (
  id                    uuid primary key default app.uuidv7(),
  tenant_id             uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  contract_number       text not null,
  name                  text not null check (length(name) between 1 and 200),
  account_id            uuid not null,
  project_id            uuid,
  kind                  text not null check (kind in ('retainer', 'amc', 'time_materials', 'fixed_bid', 'support', 'enterprise_licence')),
  status                text not null default 'draft' check (status in ('draft', 'active', 'expired', 'terminated')),
  start_date            date not null,
  end_date              date,
  value                 numeric(18, 2) not null default 0 check (value >= 0),
  billing_frequency     text not null default 'monthly' check (billing_frequency in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'milestone', 'one_time')),
  period_fee            numeric(18, 2) check (period_fee >= 0),
  hours_per_period      numeric(10, 2) check (hours_per_period >= 0),
  overage_rate          numeric(18, 2) check (overage_rate >= 0),
  sla_response_hours    numeric(8, 2) check (sla_response_hours >= 0),
  sla_resolution_hours  numeric(8, 2) check (sla_resolution_hours >= 0),
  auto_renew            boolean not null default false,
  renewal_notice_days   integer not null default 30 check (renewal_notice_days between 0 and 365),
  next_invoice_date     date,
  tax_rate              numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  hsn_sac               text not null default '998313',
  terms                 text check (length(terms) <= 20000),
  owner_id              uuid default app.current_user_id(),
  terminated_at         date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, contract_number),
  check (end_date is null or end_date >= start_date),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index service_contracts_account on service_contracts (tenant_id, account_id);

create table service_contract_invoices (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  contract_id   uuid not null,
  period_start  date not null,
  period_end    date not null,
  invoice_id    uuid,
  hours_used    numeric(10, 2),
  overage_hours numeric(10, 2),
  created_at    timestamptz not null default now(),
  primary key (tenant_id, contract_id, period_start),
  foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id)
);

create table change_requests (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id     uuid not null,
  cr_number      integer not null,
  title          text not null check (length(title) between 1 and 300),
  description    text check (length(description) <= 20000),
  reason         text check (length(reason) <= 2000),
  requested_by   text check (length(requested_by) <= 200),
  impact_hours   numeric(10, 2) not null default 0 check (impact_hours >= 0),
  impact_amount  numeric(18, 2) not null default 0 check (impact_amount >= 0),
  impact_days    integer not null default 0 check (impact_days between 0 and 3650),
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'implemented')),
  raised_by      uuid default app.current_user_id(),
  decided_by     text check (length(decided_by) <= 200),
  decided_at     timestamptz,
  decision_note  text check (length(decision_note) <= 2000),
  applied        boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, project_id, cr_number),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);

create table resource_allocations (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id         uuid not null,
  project_id      uuid not null,
  start_date      date not null,
  end_date        date not null,
  hours_per_week  numeric(6, 2) not null check (hours_per_week > 0 and hours_per_week <= 80),
  role            text check (length(role) <= 80),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  check (end_date >= start_date),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index resource_allocations_user on resource_allocations (tenant_id, user_id, start_date);

/* ───────────── SaaS subscriptions ───────────── */

create table saas_plans (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name            text not null check (length(name) between 1 and 120),
  code            text check (length(code) <= 40),
  product         text check (length(product) <= 120),
  description     text check (length(description) <= 4000),
  interval        text not null default 'month' check (interval in ('month', 'quarter', 'half_year', 'year')),
  price           numeric(18, 2) not null default 0 check (price >= 0),
  included_seats  integer not null default 1 check (included_seats >= 0),
  seat_price      numeric(18, 2) not null default 0 check (seat_price >= 0),
  usage_unit      text check (length(usage_unit) <= 40),
  included_usage  numeric(18, 2) not null default 0 check (included_usage >= 0),
  usage_price     numeric(18, 4) not null default 0 check (usage_price >= 0),
  trial_days      integer not null default 0 check (trial_days between 0 and 365),
  tax_rate        numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  hsn_sac         text not null default '998315',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id)
);

create table saas_subscriptions (
  id                    uuid primary key default app.uuidv7(),
  tenant_id             uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  sub_number            text not null,
  account_id            uuid not null,
  plan_id               uuid not null,
  status                text not null default 'active' check (status in ('trial', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  start_date            date not null,
  trial_end             date,
  current_period_start  date not null,
  current_period_end    date not null,
  seats                 integer not null default 1 check (seats >= 0 and seats <= 1000000),
  price_override        numeric(18, 2) check (price_override >= 0),
  discount_pct          numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  auto_invoice          boolean not null default true,
  auto_issue            boolean not null default false,
  cancel_at_period_end  boolean not null default false,
  cancelled_at          date,
  cancel_reason         text check (length(cancel_reason) <= 1000),
  mrr                   numeric(18, 2) not null default 0,
  owner_id              uuid default app.current_user_id(),
  notes                 text check (length(notes) <= 4000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, sub_number),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, plan_id) references saas_plans (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index saas_subscriptions_account on saas_subscriptions (tenant_id, account_id);
create index saas_subscriptions_due on saas_subscriptions (tenant_id, current_period_end) where status in ('trial', 'active', 'past_due');

create table saas_sub_addons (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  subscription_id  uuid not null,
  name             text not null check (length(name) between 1 and 120),
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price       numeric(18, 2) not null check (unit_price >= 0),
  unique (tenant_id, id),
  foreign key (tenant_id, subscription_id) references saas_subscriptions (tenant_id, id) on delete cascade
);

create table saas_usage (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  subscription_id  uuid not null,
  usage_date       date not null,
  quantity         numeric(18, 2) not null check (quantity >= 0),
  note             text check (length(note) <= 300),
  invoice_id       uuid,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, subscription_id) references saas_subscriptions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id)
);
create index saas_usage_sub on saas_usage (tenant_id, subscription_id, usage_date);

create table saas_events (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  subscription_id  uuid not null,
  kind             text not null check (kind in ('created', 'trial_started', 'activated', 'renewed', 'upgraded', 'downgraded', 'seats_changed', 'paused', 'resumed', 'cancelled', 'expired', 'invoiced', 'reactivated')),
  event_date       date not null default current_date,
  mrr_before       numeric(18, 2) not null default 0,
  mrr_after        numeric(18, 2) not null default 0,
  note             text check (length(note) <= 1000),
  invoice_id       uuid,
  created_by       uuid default app.current_user_id(),
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, subscription_id) references saas_subscriptions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id)
);
create index saas_events_date on saas_events (tenant_id, event_date);

/* ───────────── product management ───────────── */

create table pm_products (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  key           text check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  description   text check (length(description) <= 4000),
  vision        text check (length(vision) <= 4000),
  owner_id      uuid default app.current_user_id(),
  project_id    uuid,
  public_token  text unique,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id)
);

create table pm_items (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id   uuid not null,
  item_number  integer not null,
  title        text not null check (length(title) between 1 and 300),
  description  text check (length(description) <= 20000),
  kind         text not null default 'feature' check (kind in ('feature', 'improvement', 'bug', 'tech_debt', 'integration')),
  status       text not null default 'idea' check (status in ('idea', 'under_review', 'planned', 'in_progress', 'released', 'declined')),
  quarter      text check (quarter ~ '^\d{4}-Q[1-4]$'),
  reach        integer check (reach >= 0),
  impact       numeric(4, 2) check (impact in (0.25, 0.5, 1, 2, 3)),
  confidence   integer check (confidence between 0 and 100),
  effort       numeric(8, 2) check (effort > 0),
  release_id   uuid,
  task_id      uuid,
  public       boolean not null default true,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, product_id, item_number),
  foreign key (tenant_id, product_id) references pm_products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, release_id) references project_releases (tenant_id, id) on delete set null (release_id),
  foreign key (tenant_id, task_id) references project_tasks (tenant_id, id) on delete set null (task_id)
);

create table pm_requests (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id    uuid not null,
  item_id       uuid,
  account_id    uuid,
  contact_name  text check (length(contact_name) <= 200),
  title         text not null check (length(title) between 1 and 300),
  description   text check (length(description) <= 10000),
  source        text not null default 'sales' check (source in ('sales', 'support', 'email', 'call', 'portal', 'internal')),
  importance    text not null default 'nice_to_have' check (importance in ('nice_to_have', 'important', 'critical')),
  status        text not null default 'new' check (status in ('new', 'linked', 'declined')),
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references pm_products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references pm_items (tenant_id, id) on delete set null (item_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id)
);
create index pm_requests_item on pm_requests (tenant_id, item_id);

/* ───────────── client portal ───────────── */

alter table projects add column portal_token text unique;

do $$
declare t text;
begin
  foreach t in array array['project_sprints', 'project_releases', 'project_task_links', 'service_contracts', 'service_contract_invoices', 'change_requests',
                           'resource_allocations', 'saas_plans', 'saas_subscriptions', 'saas_sub_addons', 'saas_usage', 'saas_events',
                           'pm_products', 'pm_items', 'pm_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

-- the client portal and the public roadmap are reached by their token
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request', 'dashboard', 'portal', 'roadmap'));

create or replace function app.sync_token_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  k   text := tg_argv[0];
  tok text;
begin
  if tg_op = 'DELETE' then
    delete from public_routes where kind = k and target_id = old.id;
    return old;
  end if;
  tok := case k when 'portal' then case when (to_jsonb(new) ->> 'deleted_at') is null then to_jsonb(new) ->> 'portal_token' end else to_jsonb(new) ->> 'public_token' end;
  delete from public_routes where kind = k and target_id = new.id;
  if tok is not null then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (tok, new.tenant_id, k, new.id);
  end if;
  return new;
end
$$;
create trigger projects_portal_route after insert or update of portal_token, deleted_at or delete on projects for each row execute function app.sync_token_route('portal');
create trigger pm_products_roadmap_route after insert or update of public_token or delete on pm_products for each row execute function app.sync_token_route('roadmap');
