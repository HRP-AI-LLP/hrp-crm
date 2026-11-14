-- HRP Synapse · 0028 revenue intelligence: a context layer and task agents on top of the CRM
--
-- competitors         who you lose to and how you win (battlecards); deal_competitors tags deals
-- agent_settings      per-workspace switches for each agent (on/off, auto-run, daily budget, thresholds)
-- agent_runs          every agent run with its output and the CRM records it cites
-- action_items        follow-ups from meetings, calls, agents and insights (AI-made ones are flagged)
-- agent_suggestions   field changes an agent proposes; a person applies or rejects each one
-- insights            the feed: risks and opportunities found by the hourly sweep, one per subject
-- record_scores       deal risk, account health and fit scores with the factors behind them
-- meeting_notes       notes / transcript of a calendar meeting, with its prep and debrief runs
-- interaction_index   which interactions are in the semantic index (for "Ask Synapse")

create table competitors (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  website       text check (length(website) <= 300),
  aliases       text[] not null default '{}',
  description   text check (length(description) <= 4000),
  strengths     text check (length(strengths) <= 4000),
  weaknesses    text check (length(weaknesses) <= 4000),
  pricing_notes text check (length(pricing_notes) <= 4000),
  how_we_win    text check (length(how_we_win) <= 4000),
  is_active     boolean not null default true,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index competitors_name on competitors (tenant_id, lower(name));

create table deal_competitors (
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  deal_id        uuid not null,
  competitor_id  uuid not null,
  status         text not null default 'active' check (status in ('active', 'beaten', 'lost_to')),
  note           text check (length(note) <= 1000),
  source         text not null default 'manual' check (source in ('manual', 'ai')),
  created_by     uuid default app.current_user_id(),
  created_at     timestamptz not null default now(),
  primary key (tenant_id, deal_id, competitor_id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, competitor_id) references competitors (tenant_id, id) on delete cascade
);

create table agent_settings (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  agent_key     text not null check (agent_key ~ '^[a-z_]{2,40}$'),
  enabled       boolean not null default true,
  auto_run      boolean not null default false,
  daily_budget  integer not null default 25 check (daily_budget between 0 and 1000),
  settings      jsonb not null default '{}'::jsonb,
  updated_by    uuid default app.current_user_id(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, agent_key)
);

create table agent_runs (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  agent_key       text not null,
  trigger         text not null default 'manual' check (trigger in ('manual', 'schedule', 'event')),
  subject_object  text,
  subject_id      uuid,
  status          text not null default 'running' check (status in ('running', 'done', 'failed')),
  output          jsonb not null default '{}'::jsonb,
  -- [{"ref":"F3","object":"deal","id":"…","label":"…","kind":"activity","at":"…"}]
  citations       jsonb not null default '[]'::jsonb,
  ai_used         boolean not null default false,
  model           text,
  error           text check (length(error) <= 1000),
  requested_by    uuid default app.current_user_id(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, requested_by) references users (tenant_id, id) on delete set null (requested_by)
);
create index agent_runs_subject on agent_runs (tenant_id, subject_object, subject_id, started_at desc);
create index agent_runs_agent on agent_runs (tenant_id, agent_key, started_at desc);

create table action_items (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  title           text not null check (length(title) between 1 and 300),
  detail          text check (length(detail) <= 4000),
  status          text not null default 'open' check (status in ('open', 'in_progress', 'done', 'dismissed')),
  priority        text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  due_at          timestamptz,
  owner_id        uuid,
  related_object  text,
  related_id      uuid,
  source          text not null default 'manual' check (source in ('manual', 'agent', 'meeting', 'call', 'insight')),
  run_id          uuid,
  event_id        uuid,
  evidence        jsonb not null default '[]'::jsonb,
  ai_generated    boolean not null default false,
  completed_at    timestamptz,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, id) on delete set null (run_id),
  foreign key (tenant_id, event_id) references events (tenant_id, id) on delete set null (event_id)
);
create index action_items_owner on action_items (tenant_id, owner_id, status, due_at);
create index action_items_related on action_items (tenant_id, related_object, related_id);

create table agent_suggestions (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id          uuid,
  object_key      text not null,
  record_id       uuid not null,
  field_key       text not null check (length(field_key) <= 80),
  current_value   jsonb,
  proposed_value  jsonb,
  reason          text check (length(reason) <= 1000),
  evidence        jsonb not null default '[]'::jsonb,
  status          text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'stale')),
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, decided_by) references users (tenant_id, id) on delete set null (decided_by)
);
create index agent_suggestions_record on agent_suggestions (tenant_id, object_key, record_id) where status = 'pending';

create table insights (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  kind            text not null check (kind ~ '^[a-z_]{2,40}$'),
  severity        text not null default 'info' check (severity in ('info', 'warn', 'risk', 'opportunity')),
  title           text not null check (length(title) between 1 and 300),
  body            text check (length(body) <= 2000),
  related_object  text,
  related_id      uuid,
  owner_id        uuid,
  score           numeric(10, 2),
  evidence        jsonb not null default '{}'::jsonb,
  dedupe_key      text not null check (length(dedupe_key) <= 200),
  status          text not null default 'new' check (status in ('new', 'seen', 'acted', 'dismissed')),
  snooze_until    timestamptz,
  notified_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index insights_owner on insights (tenant_id, owner_id, status, created_at desc);
create index insights_related on insights (tenant_id, related_object, related_id);

create table record_scores (
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key   text not null,
  record_id    uuid not null,
  kind         text not null check (kind in ('deal_risk', 'account_health', 'fit')),
  score        integer not null check (score between 0 and 100),
  band         text not null check (band in ('good', 'watch', 'bad')),
  factors      jsonb not null default '[]'::jsonb,
  computed_at  timestamptz not null default now(),
  primary key (tenant_id, object_key, record_id, kind)
);

create table meeting_notes (
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  event_id           uuid not null,
  notes              text check (length(notes) <= 20000),
  transcript         text check (length(transcript) <= 200000),
  transcript_source  text check (transcript_source in ('typed', 'pasted', 'audio')),
  prep_run_id        uuid,
  debrief_run_id     uuid,
  updated_by         uuid default app.current_user_id(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, event_id),
  foreign key (tenant_id, event_id) references events (tenant_id, id) on delete cascade,
  foreign key (tenant_id, prep_run_id) references agent_runs (tenant_id, id) on delete set null (prep_run_id),
  foreign key (tenant_id, debrief_run_id) references agent_runs (tenant_id, id) on delete set null (debrief_run_id)
);

create table interaction_index (
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  source_kind     text not null check (source_kind in ('activity', 'message', 'meeting')),
  source_id       uuid not null,
  related_object  text,
  related_id      uuid,
  chunks          integer not null default 1,
  indexed_at      timestamptz not null default now(),
  primary key (tenant_id, source_kind, source_id)
);

-- interactions are searched in plain text when the vector index is not available
create index activities_fts on activities using gin (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, '')));

do $$
declare t text;
begin
  foreach t in array array['competitors', 'deal_competitors', 'agent_settings', 'agent_runs', 'action_items', 'agent_suggestions', 'insights', 'record_scores', 'meeting_notes', 'interaction_index'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger competitors_touch   before update on competitors   for each row execute function app.touch_row();
create trigger action_items_touch  before update on action_items  for each row execute function app.touch_row();
create trigger insights_touch      before update on insights      for each row execute function app.touch_row();
create trigger competitors_audit   after insert or update or delete on competitors   for each row execute function app.audit_row_change('competitor');
create trigger agent_settings_audit after insert or update or delete on agent_settings for each row execute function app.audit_row_change('agent_setting');
