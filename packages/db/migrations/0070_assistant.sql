-- The workspace assistant: a chat per person that reads anything they can read through the API
-- and proposes changes (records, tasks, sprints, milestones, invoices…) that run only when they
-- approve them, as them.
create table assistant_threads (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id     uuid not null,
  title       text not null default 'New chat' check (length(title) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index assistant_threads_user on assistant_threads (tenant_id, user_id, updated_at desc);

create table assistant_messages (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  thread_id   uuid not null,
  role        text not null check (role in ('user', 'assistant', 'tool')),
  content     text not null check (length(content) <= 40000),
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, thread_id) references assistant_threads (tenant_id, id) on delete cascade
);
create index assistant_messages_thread on assistant_messages (tenant_id, thread_id, created_at);

create table assistant_actions (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  thread_id   uuid not null,
  message_id  uuid not null,
  user_id     uuid not null,
  method      text not null check (method in ('POST', 'PUT', 'PATCH', 'DELETE')),
  path        text not null check (length(path) <= 1000),
  body        jsonb,
  summary     text not null check (length(summary) <= 500),
  status      text not null default 'proposed' check (status in ('proposed', 'running', 'done', 'failed', 'rejected')),
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, thread_id) references assistant_threads (tenant_id, id) on delete cascade,
  foreign key (tenant_id, message_id) references assistant_messages (tenant_id, id) on delete cascade
);
create index assistant_actions_message on assistant_actions (tenant_id, message_id);

do $$
declare t text;
begin
  foreach t in array array['assistant_threads', 'assistant_messages', 'assistant_actions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
