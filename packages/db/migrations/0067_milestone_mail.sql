-- A milestone keeps the whole approval mail thread: every message saved as an .eml file and an email
-- activity on the project, and every attachment saved as a file.
create table milestone_attachments (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  milestone_id  uuid not null,
  file_id       uuid,
  activity_id   uuid,
  kind          text not null check (kind in ('email', 'attachment')),
  message_id    text check (length(message_id) <= 500),     -- the mail's Message-ID: one copy per milestone
  thread_key    text check (length(thread_key) <= 300),
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete cascade
);
create index milestone_attachments_ms on milestone_attachments (tenant_id, milestone_id, created_at);
create unique index milestone_attachments_mail on milestone_attachments (tenant_id, milestone_id, message_id) where kind = 'email' and message_id is not null;

alter table milestone_attachments enable row level security;
alter table milestone_attachments force row level security;
create policy tenant_isolation on milestone_attachments as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on milestone_attachments to synapse_app;
