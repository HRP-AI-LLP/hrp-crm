-- Code policy per project: each project is linked to its GitHub / Azure Repos repositories, and
-- every commit and pull request must name a work item (FLEET-12) or a change request (FLEET-CR-3).
-- Per repository: off, warn (record), enforce (the CI check and the commit hook fail), or
-- auto_create (Synapse creates the right item from the commit message and links it).
-- The CI check (GitHub Actions / Azure Pipelines) and git hooks call /api/public/dev/check with the
-- repository's token: its public part routes to the workspace, its secret part is kept hashed.

alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request', 'dashboard', 'portal', 'roadmap', 'dealer', 'kb', 'repo'));

create table project_repos (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id      uuid not null,
  provider        text not null check (provider in ('github', 'azure_repos')),
  repo            text not null check (repo ~ '^[a-z0-9._-]+(/[a-z0-9._ -]+){1,2}$' and length(repo) <= 200),   -- owner/name, or project/repo on Azure
  default_branch  text not null default 'main' check (length(default_branch) between 1 and 200),
  policy          text not null default 'enforce' check (policy in ('off', 'warn', 'enforce', 'auto_create')),
  auto_sprint     boolean not null default true,   -- auto-created items join the active sprint
  public_token    text not null default encode(gen_random_bytes(16), 'hex'),
  secret_hash     text not null,
  last_check_at   timestamptz,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, repo),
  unique (public_token),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index project_repos_project on project_repos (tenant_id, project_id);
create trigger project_repos_route after insert or update of public_token or delete on project_repos for each row execute function app.sync_token_route('repo');

-- every commit / pull request seen, and what it was linked to
create table pm_code_events (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  repo_id         uuid not null,
  project_id      uuid not null,
  kind            text not null check (kind in ('commit', 'pr')),
  external_id     text not null check (length(external_id) <= 300),
  title           text check (length(title) <= 300),
  author          text check (length(author) <= 200),
  author_email    text check (length(author_email) <= 320),
  url             text check (length(url) <= 1000),
  branch          text check (length(branch) <= 200),
  status          text not null check (status in ('pending', 'linked', 'created', 'missing', 'skipped')),
  item_ids        uuid[] not null default '{}',
  cr_ids          uuid[] not null default '{}',
  created_item_id uuid,
  created_cr_id   uuid,
  source          text not null default 'webhook' check (source in ('webhook', 'check')),
  at              timestamptz not null default now(),
  unique (tenant_id, repo_id, external_id),
  foreign key (tenant_id, repo_id) references project_repos (tenant_id, id) on delete cascade
);
create index pm_code_events_missing on pm_code_events (tenant_id, project_id, at desc) where status = 'missing';

-- code links can point at a change request as well as a work item
alter table project_task_links alter column task_id drop not null;
alter table project_task_links
  add column change_request_id uuid,
  add foreign key (tenant_id, change_request_id) references change_requests (tenant_id, id) on delete cascade,
  add constraint project_task_links_target check (task_id is not null or change_request_id is not null);
create unique index project_task_links_cr_external on project_task_links (tenant_id, change_request_id, external_id) where external_id is not null and change_request_id is not null;

do $$
declare t text;
begin
  foreach t in array array['project_repos', 'pm_code_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
