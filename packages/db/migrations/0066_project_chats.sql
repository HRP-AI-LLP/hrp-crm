-- WhatsApp chats on projects: a customer's one-to-one chat, a project group (WhatsApp Groups API) or
-- an exported chat, linked to a project; the AI reads what is new and proposes (or creates) bugs,
-- requirements, stories, tasks, change requests, calls and follow-ups.

-- groups made through the WhatsApp Groups API on a Cloud API number
create table wa_groups (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel_account_id  uuid not null,
  group_id            text check (length(group_id) between 3 and 120),   -- known once WhatsApp confirms the group
  request_id          text check (length(request_id) <= 120),           -- the create request, until then
  subject             text check (length(subject) <= 200),
  description         text check (length(description) <= 2048),
  invite_link         text check (length(invite_link) <= 300),
  created_by          uuid default app.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_account_id) references channel_accounts (tenant_id, id) on delete cascade
);
create unique index wa_groups_group on wa_groups (tenant_id, channel_account_id, group_id) where group_id is not null;
create index wa_groups_request on wa_groups (tenant_id, request_id) where request_id is not null;

create table project_chats (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id        uuid not null,
  kind              text not null check (kind in ('contact', 'group', 'import')),
  conversation_id   uuid,                       -- the inbox thread (a person, or 'group:<id>' for a group)
  wa_group_id       uuid,
  title             text not null check (length(title) between 1 and 200),
  mode              text not null default 'suggest' check (mode in ('suggest', 'auto', 'off')),
  pending_since     timestamptz,                -- new messages not read by the AI yet
  last_message_at   timestamptz,
  analysed_until    timestamptz,                -- messages up to here have been read
  last_analysed_at  timestamptz,
  last_error        text check (length(last_error) <= 500),
  created_by        uuid default app.current_user_id(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, wa_group_id) references wa_groups (tenant_id, id) on delete cascade
);
create unique index project_chats_conversation on project_chats (tenant_id, project_id, conversation_id) where conversation_id is not null;
create index project_chats_by_conversation on project_chats (tenant_id, conversation_id) where conversation_id is not null;
create index project_chats_pending on project_chats (tenant_id, pending_since) where pending_since is not null;

create table project_chat_messages (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  chat_id       uuid not null,
  at            timestamptz not null,
  sender        text not null check (length(sender) between 1 and 200),
  sender_addr   text check (length(sender_addr) <= 120),
  side          text not null default 'unknown' check (side in ('team', 'client', 'unknown')),
  body          text not null check (length(body) <= 8000),
  media         jsonb,
  source        text not null check (source in ('live', 'import')),
  external_id   text check (length(external_id) <= 200),
  message_id    uuid,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, chat_id) references project_chats (tenant_id, id) on delete cascade
);
create unique index project_chat_messages_ext on project_chat_messages (tenant_id, chat_id, external_id) where external_id is not null;
create index project_chat_messages_at on project_chat_messages (tenant_id, chat_id, at);

create table project_chat_proposals (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id      uuid not null,
  chat_id         uuid not null,
  kind            text not null check (kind in ('bug', 'requirement', 'story', 'task', 'change_request', 'call', 'question', 'follow_up')),
  title           text not null check (length(title) between 1 and 300),
  detail          text check (length(detail) <= 4000),
  priority        text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  due             date,
  starts_at       timestamptz,
  requested_by    text check (length(requested_by) <= 200),
  quote           text check (length(quote) <= 1200),
  message_at      timestamptz,
  confidence      numeric(3, 2) not null default 0.5 check (confidence between 0 and 1),
  ai              boolean not null default true,
  status          text not null default 'proposed' check (status in ('proposed', 'created', 'dismissed')),
  created_object  text check (created_object in ('task', 'change_request', 'call', 'action_item')),
  created_id      uuid,
  created_key     text check (length(created_key) <= 60),
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, chat_id) references project_chats (tenant_id, id) on delete cascade
);
create index project_chat_proposals_list on project_chat_proposals (tenant_id, project_id, status, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['wa_groups', 'project_chats', 'project_chat_messages', 'project_chat_proposals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
