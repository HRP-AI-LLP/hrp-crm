-- A key made for one project's repository: it works only for that project's coding agent (MCP).
alter table api_keys add column project_id uuid;
alter table api_keys add constraint api_keys_project_fk foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade;
create index api_keys_project on api_keys (tenant_id, project_id) where project_id is not null;
