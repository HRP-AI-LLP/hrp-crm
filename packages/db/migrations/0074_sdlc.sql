-- AI across the software lifecycle: a goal ("build fleet tracking for our clients") is planned into
-- steps, each done by a specialist agent (business analyst, architect, UX, QA, DevOps, writer,
-- project manager, developer); people review what matters; the results are documents and diagrams
-- (Mermaid + draw.io), backlog items, test cases and code by the coding agent.
create table sdlc_runs (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid,
  title       text not null check (length(title) between 1 and 200),
  goal        text not null check (length(goal) between 1 and 20000),
  template    text not null default 'ai' check (length(template) <= 40),
  review_mode text not null default 'key' check (review_mode in ('each', 'key', 'none')),
  status      text not null default 'planning' check (status in ('planning', 'awaiting_plan', 'running', 'awaiting_review', 'done', 'failed', 'cancelled')),
  error       text check (length(error) <= 4000),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index sdlc_runs_list on sdlc_runs (tenant_id, project_id, created_at desc);

create table sdlc_steps (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id       uuid not null,
  position     integer not null,
  agent        text not null check (length(agent) <= 40),
  kind         text not null check (kind in ('document', 'diagram', 'backlog', 'test_cases', 'code')),
  title        text not null check (length(title) between 1 and 200),
  doc_type     text check (length(doc_type) <= 40),
  diagram_type text check (length(diagram_type) <= 40),
  instructions text check (length(instructions) <= 8000),
  needs_review boolean not null default true,
  status       text not null default 'pending' check (status in ('pending', 'running', 'awaiting_review', 'approved', 'skipped', 'failed')),
  attempts     integer not null default 0,
  feedback     text check (length(feedback) <= 8000),        -- the reviewer's "change this", fed to the next attempt
  output       jsonb not null default '{}',                  -- backlog / test cases proposed, what was created
  error        text check (length(error) <= 4000),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, run_id, position) deferrable initially deferred,
  foreign key (tenant_id, run_id) references sdlc_runs (tenant_id, id) on delete cascade
);

-- documents and diagrams: from a run's step, or made on their own (the diagram studio)
create table sdlc_artifacts (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id   uuid,
  run_id       uuid,
  step_id      uuid,
  kind         text not null check (kind in ('document', 'diagram')),
  subtype      text not null check (length(subtype) <= 40),   -- doc type (brd, hld, …) or diagram type (er, sequence, …)
  title        text not null check (length(title) between 1 and 200),
  body         text check (length(body) <= 400000),           -- markdown (documents) / mermaid (diagrams)
  spec         jsonb,                                         -- the diagram's spec
  drawio       text check (length(drawio) <= 2000000),
  version      integer not null default 1,
  status       text not null default 'draft' check (status in ('draft', 'approved')),
  created_by   uuid default app.current_user_id(),
  updated_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, run_id) references sdlc_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, step_id) references sdlc_steps (tenant_id, id) on delete set null (step_id)
);
create index sdlc_artifacts_list on sdlc_artifacts (tenant_id, project_id, updated_at desc);
create index sdlc_artifacts_run on sdlc_artifacts (tenant_id, run_id);

create table sdlc_artifact_versions (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  artifact_id uuid not null,
  version     integer not null,
  title       text not null,
  body        text,
  spec        jsonb,
  drawio      text,
  note        text check (length(note) <= 500),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, artifact_id, version),
  foreign key (tenant_id, artifact_id) references sdlc_artifacts (tenant_id, id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['sdlc_runs', 'sdlc_steps', 'sdlc_artifacts', 'sdlc_artifact_versions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
