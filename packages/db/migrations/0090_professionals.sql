-- Accountants & CAs: outside finance people the business gives scoped access to. Each is a user with
-- a per-person role that the app's permission engine enforces. The authoritative access config lives
-- on the professionals row (access jsonb); the role is derived from it, so the row is the source of
-- truth the UI reads and writes.
create table if not exists professionals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role_id       uuid references roles(id) on delete set null,   -- the per-person access role (derived)
  kind          text not null default 'accountant' check (kind in ('ca', 'accountant', 'auditor', 'bookkeeper', 'tax_consultant')),
  firm          text check (length(firm) <= 160),
  membership_no text check (length(membership_no) <= 60),        -- ICAI membership / firm registration
  phone         text check (length(phone) <= 25),
  engaged_from  date,
  engaged_to    date,
  notes         text check (length(notes) <= 4000),
  -- { "modules": { "billing": "edit", "books": "view", "gst": "download" }, "canFile": true }
  -- per-module level is one of view (read only) | download (read + reports/export) | edit (read + change)
  access        jsonb not null default '{}',
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists professionals_tenant on professionals(tenant_id);
alter table professionals enable row level security;
alter table professionals force row level security;
create policy tenant_isolation on professionals as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on professionals to synapse_app;

-- A professional can ask for more access (modules, level changes, or anything in free text); an admin
-- approves or declines. On approval the requested access is merged into professionals.access and the
-- role is rebuilt.
create table if not exists professional_access_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  professional_id uuid not null references professionals(id) on delete cascade,
  -- { "modules": { "books": "edit" }, "canFile": true }  — the access they are asking to be granted
  requested       jsonb not null default '{}',
  note            text check (length(note) <= 2000),               -- free-text ask / justification
  status          text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decision_note   text check (length(decision_note) <= 2000),
  decided_by      uuid references users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists prof_access_req_tenant on professional_access_requests(tenant_id) where status = 'pending';
create index if not exists prof_access_req_pro on professional_access_requests(professional_id);
alter table professional_access_requests enable row level security;
alter table professional_access_requests force row level security;
create policy tenant_isolation on professional_access_requests as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on professional_access_requests to synapse_app;
