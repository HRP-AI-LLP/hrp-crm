-- HRP AI, the coding agent, as an assignee: every workspace has it (it cannot sign in, has no seat and
-- gets no mail). Work assigned to it goes to the coding agent's queue (Claude Code / Codex through MCP).
alter table users add column is_agent boolean not null default false;
create unique index users_one_agent on users (tenant_id) where is_agent;
do $$
declare t uuid;
begin
  for t in select id from tenants loop
    perform set_config('app.tenant_id', t::text, true);
    insert into users (tenant_id, email, full_name, status, is_agent) values (t, 'hrp-ai@agent.sanchalanos.invalid', 'HRP AI', 'profile', true)
      on conflict do nothing;
  end loop;
end
$$;
-- new workspaces: with their owner (app.create_tenant has set the tenant by then)
create function app.add_agent_user() returns trigger language plpgsql as $$
begin
  insert into users (tenant_id, email, full_name, status, is_agent) values (new.tenant_id, 'hrp-ai@agent.sanchalanos.invalid', 'HRP AI', 'profile', true)
    on conflict do nothing;
  return null;
end
$$;
create trigger users_owner_agent after insert on users for each row when (new.is_owner) execute function app.add_agent_user();

alter table coding_agent_jobs drop constraint coding_agent_jobs_reason_check;
alter table coding_agent_jobs add constraint coding_agent_jobs_reason_check check (reason in ('created', 'updated', 'requested', 'changes_requested', 'assigned'));

-- who new work items go to when nobody is chosen: 'agent' (HRP AI), 'none', or a person's id
alter table projects add column default_assignee text not null default 'agent'
  check (default_assignee in ('agent', 'none') or default_assignee ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- suggestions from chats carry everything a work item needs
alter table project_chat_proposals
  add column severity       text check (severity in ('minor', 'major', 'critical', 'blocker')),
  add column story_points   numeric(6, 1) check (story_points >= 0),
  add column estimate_hours numeric(8, 2) check (estimate_hours >= 0),
  add column epic_ref       text check (length(epic_ref) <= 300),
  add column release_ref    text check (length(release_ref) <= 120);

-- assigned to HRP AI → queued for the coding agent (the project's agent is switched on if it was not)
create or replace function app.queue_agent_job() returns trigger language plpgsql as $$
declare
  s coding_agent_settings%rowtype;
  why text;
  to_agent boolean;
begin
  if new.status in ('done', 'cancelled') or coalesce(current_setting('app.agent', true), '') = '1' then
    return null;
  end if;
  to_agent := exists (select 1 from users u where u.tenant_id = new.tenant_id and u.is_agent and u.id = any (new.assignees))
              and (tg_op = 'INSERT' or not exists (select 1 from users u where u.tenant_id = new.tenant_id and u.is_agent and u.id = any (old.assignees)));
  if to_agent and new.work_type <> 'epic' then
    insert into coding_agent_settings (tenant_id, project_id, enabled) values (new.tenant_id, new.project_id, true)
      on conflict (tenant_id, project_id) do update set enabled = true;
    insert into coding_agent_jobs (tenant_id, project_id, task_id, reason)
    values (new.tenant_id, new.project_id, new.id, 'assigned')
    on conflict (tenant_id, task_id) where status not in ('released', 'failed', 'cancelled')
    do update set revision = coding_agent_jobs.revision + 1, reason = excluded.reason, updated_at = now();
    return null;
  end if;
  select * into s from coding_agent_settings where tenant_id = new.tenant_id and project_id = new.project_id and enabled;
  if not found or not (new.work_type = any (s.work_types)) then
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

-- how the coding agent takes work: one item at a time (review each before the next), or everything
-- queued at once and one review round for the lot
alter table coding_agent_settings
  add column work_mode  text not null default 'one' check (work_mode in ('one', 'batch')),
  add column batch_size integer not null default 20 check (batch_size between 1 and 50);
