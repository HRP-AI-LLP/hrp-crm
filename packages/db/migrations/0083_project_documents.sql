-- What the client shares to explain the work: BRDs, requirement notes, screenshots of their current
-- system, sample data, formats, contracts, meeting notes… The file is in `files` (object 'project');
-- this is what it is, who shared it, and what the AI read in it.
create table project_documents (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id    uuid not null,
  file_id       uuid not null,
  category      text not null default 'other' check (category in ('brd', 'requirements', 'existing_system', 'design', 'data', 'process', 'technical', 'contract', 'meeting', 'other')),
  title         text not null check (length(title) between 1 and 200),
  notes         text check (length(notes) <= 4000),
  shared_by     text check (length(shared_by) <= 200),
  shared_on     date,
  read_status   text not null default 'pending' check (read_status in ('pending', 'read', 'unreadable', 'failed')),
  read_error    text check (length(read_error) <= 500),
  summary       text check (length(summary) <= 6000),
  text_content  text check (length(text_content) <= 200000),
  auto_category boolean not null default false,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, file_id) references files (tenant_id, id) on delete cascade
);
create index project_documents_list on project_documents (tenant_id, project_id, created_at desc);
alter table project_documents enable row level security;
alter table project_documents force row level security;
create policy tenant_isolation on project_documents as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on project_documents to synapse_app;
