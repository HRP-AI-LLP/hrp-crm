-- A customer's payment received without an invoice yet (an advance) belongs to their project or deal:
-- kept on the payment so the project and the deal show what was received for them.
alter table payments add column deal_id uuid;
alter table payments add column project_id uuid;
alter table payments add constraint payments_deal foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id);
alter table payments add constraint payments_project foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id);
create index payments_deal_idx on payments (tenant_id, deal_id) where deal_id is not null;
create index payments_project_idx on payments (tenant_id, project_id) where project_id is not null;
