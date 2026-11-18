-- A receipt (or the part of it not applied to invoices) can also be for a service contract (projects and
-- deals already had theirs): an advance for that work, applied to its invoices later.
alter table payments
  add column contract_id uuid,
  add foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete set null (contract_id);
create index payments_contract_idx on payments (tenant_id, contract_id) where contract_id is not null;
