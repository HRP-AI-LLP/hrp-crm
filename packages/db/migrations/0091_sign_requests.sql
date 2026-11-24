-- Signature requests: an accountant/CA (or other professional) uploads a document they need digitally
-- signed; an admin signs it with the company DSC and the signed copy comes back for download.
create table if not exists sign_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  professional_id uuid not null references professionals(id) on delete cascade,
  name            text not null check (length(name) between 1 and 200),
  note            text check (length(note) <= 2000),
  source_file_id  uuid not null references files(id),            -- the PDF they uploaded
  signed_file_id  uuid references files(id),                     -- the signed PDF, once done
  certificate_id  uuid references dsc_certificates(id),
  status          text not null default 'pending' check (status in ('pending', 'signed', 'rejected')),
  decision_note   text check (length(decision_note) <= 2000),
  decided_by      uuid references users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists sign_requests_tenant on sign_requests(tenant_id) where status = 'pending';
create index if not exists sign_requests_pro on sign_requests(professional_id);
alter table sign_requests enable row level security;
alter table sign_requests force row level security;
create policy tenant_isolation on sign_requests as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on sign_requests to synapse_app;
