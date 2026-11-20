-- Work management, part 3: automation rules, attachments on work items, email alerts for work
-- (instant or daily digest, per person), project templates, and the GitHub App (installations,
-- check runs on commits and pull requests, branches created from work items).

alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request', 'dashboard', 'portal', 'roadmap', 'dealer', 'kb', 'repo', 'github_app'));

/* ───────────── automation rules ───────────── */

create table pm_rules (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id     uuid not null,
  name           text not null check (length(name) between 1 and 120),
  enabled        boolean not null default true,
  trigger        text not null check (trigger in ('created', 'state_changed', 'field_changed', 'commented', 'scheduled')),
  trigger_config jsonb not null default '{}'::jsonb,   -- { types?, toState?, fromState?, toCategory?, field?, to?, hour? }
  condition      text check (length(condition) <= 2000), -- a work query the item must match
  actions        jsonb not null,                        -- [{ type, ... }]
  run_count      integer not null default 0,
  last_run_at    timestamptz,
  last_error     text check (length(last_error) <= 500),
  created_by     uuid default app.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index pm_rules_project on pm_rules (tenant_id, project_id) where enabled;

create table pm_rule_runs (
  id         uuid primary key default app.uuidv7(),
  tenant_id  uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  rule_id    uuid not null,
  task_id    uuid,
  status     text not null check (status in ('done', 'no_match', 'error')),
  detail     text check (length(detail) <= 1000),
  at         timestamptz not null default now(),
  foreign key (tenant_id, rule_id) references pm_rules (tenant_id, id) on delete cascade
);
create index pm_rule_runs_rule on pm_rule_runs (tenant_id, rule_id, at desc);

/* ───────────── email / chat alerts for work ───────────── */

create table pm_notify_prefs (
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id        uuid not null,
  assigned       text not null default 'instant' check (assigned in ('off', 'instant', 'digest')),
  mentioned      text not null default 'instant' check (mentioned in ('off', 'instant', 'digest')),
  watching       text not null default 'digest' check (watching in ('off', 'instant', 'digest')),
  due            text not null default 'digest' check (due in ('off', 'digest')),
  digest_hour    integer not null default 9 check (digest_hour between 0 and 23),   -- local hour, Asia/Kolkata
  last_digest_at timestamptz,
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

create table pm_outbox (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id        uuid,                 -- email to a person
  integration_id uuid,                 -- or a Teams / Slack / Google Chat post
  category       text not null check (category in ('assigned', 'mentioned', 'watching', 'due', 'rule')),
  mode           text not null check (mode in ('instant', 'digest')),
  title          text not null check (length(title) <= 300),
  body           text check (length(body) <= 2000),
  link           text check (length(link) <= 500),
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  check (user_id is not null or integration_id is not null)
);
create index pm_outbox_due on pm_outbox (tenant_id, mode, created_at) where sent_at is null;

/* ───────────── templates ───────────── */

create table pm_templates (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  description text check (length(description) <= 1000),
  config      jsonb not null,
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

/* ───────────── GitHub App ───────────── */

create table github_installations (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  installation_id bigint not null,
  account         text not null check (length(account) <= 200),
  account_type    text check (length(account_type) <= 40),
  public_token    text not null,                 -- routes the app's webhooks to the workspace
  installed_by    uuid default app.current_user_id(),
  suspended_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (installation_id),
  unique (public_token)
);
create trigger github_installations_route after insert or update of public_token or delete on github_installations for each row execute function app.sync_token_route('github_app');

alter table project_repos add column installation_id bigint;

do $$
declare t text;
begin
  foreach t in array array['pm_rules', 'pm_rule_runs', 'pm_notify_prefs', 'pm_outbox', 'pm_templates', 'github_installations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
