-- Registration documents of the organisation (PAN, TAN, GST, incorporation, Udyam, Startup India…) and
-- of its partners and directors (PAN, Aadhaar, DIN…): the number, dates and the uploaded copy.
create table org_documents (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  person_id    uuid, -- null: the organisation's own document
  kind         text not null check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  label        text check (length(label) <= 120),
  number       text check (length(number) <= 80),
  issued_on    date,
  valid_until  date,
  notes        text check (length(notes) <= 500),
  file_id      uuid,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, person_id) references acct_persons (tenant_id, id) on delete cascade,
  foreign key (tenant_id, file_id) references files (tenant_id, id) on delete set null (file_id)
);
create index org_documents_owner on org_documents (tenant_id, person_id, kind);

alter table org_documents enable row level security;
alter table org_documents force row level security;
create policy tenant_isolation on org_documents as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on org_documents to synapse_app;

-- documents of team members too (Admin → Users), not only partners
alter table org_documents add column user_id uuid;
alter table org_documents add constraint org_documents_user foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table org_documents add constraint org_documents_one_owner check (person_id is null or user_id is null);
create index org_documents_user_idx on org_documents (tenant_id, user_id) where user_id is not null;

-- identity and statutory numbers of a person onboarded: a partner / director or a team member.
-- Aadhaar is kept encrypted (shown as its last four digits); PAN of a partner stays on acct_persons.
create table person_identity (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  person_id      uuid,
  user_id        uuid,
  pan            text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  aadhaar_enc    text,
  aadhaar_last4  text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  uan            text check (uan ~ '^[0-9]{12}$'),
  pf_number      text check (length(pf_number) <= 40),
  updated_by     uuid default app.current_user_id(),
  updated_at     timestamptz not null default now(),
  check ((person_id is null) <> (user_id is null)),
  check ((aadhaar_enc is null) = (aadhaar_last4 is null)),
  unique (tenant_id, person_id),
  unique (tenant_id, user_id),
  foreign key (tenant_id, person_id) references acct_persons (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
alter table person_identity enable row level security;
alter table person_identity force row level security;
create policy tenant_isolation on person_identity as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on person_identity to synapse_app;
