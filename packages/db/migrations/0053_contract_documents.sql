-- Contracts the business already has (NDA, MSA, SoW, AMC, agreements…): uploaded, read, and kept with
-- what was read off them; an NDA or MSA carries no billing; a SoW can sit under its MSA.
alter table service_contracts drop constraint if exists service_contracts_kind_check;
alter table service_contracts add constraint service_contracts_kind_check
  check (kind in ('retainer', 'amc', 'time_materials', 'fixed_bid', 'support', 'enterprise_licence', 'nda', 'msa', 'other'));
alter table service_contracts drop constraint if exists service_contracts_billing_frequency_check;
alter table service_contracts add constraint service_contracts_billing_frequency_check
  check (billing_frequency in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'milestone', 'one_time', 'none'));

alter table service_contracts
  add column doc_type           text check (doc_type in ('nda', 'msa', 'sow', 'agreement', 'amendment', 'purchase_order', 'other')),
  add column parent_id          uuid,
  add column currency           char(3) not null default 'INR',
  add column signed_on          date,
  add column client_ref         text check (length(client_ref) <= 120),
  add column governing_law      text check (length(governing_law) <= 200),
  add column payment_terms_days integer check (payment_terms_days between 0 and 365),
  add column notice_days        integer check (notice_days between 0 and 730),
  add column source             text not null default 'created' check (source in ('created', 'uploaded')),
  add column summary            text check (length(summary) <= 4000),
  add column extracted          jsonb not null default '{}'::jsonb,
  add foreign key (tenant_id, parent_id) references service_contracts (tenant_id, id) on delete set null (parent_id);
