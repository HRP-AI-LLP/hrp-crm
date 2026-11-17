-- 0038: importing documents raised elsewhere (sales invoices from Zoho, Tally, Excel, scans) with
-- approval: every invoice read from a file is staged with what would be created (customer, contact,
-- project, the invoice under its original number, the receipt) and only created when a person
-- approves it, after editing it if needed.
--
--  * invoices.imported   issued elsewhere and already reported there: kept with its own number, never
--                        sent to GSTR-1 or e-invoicing from Synapse
--  * doc_imports         one upload (any number of files)
--  * doc_import_items    one document read from a file, its plan and its fate

alter table invoices add column imported boolean not null default false;
alter table invoices add column import_source text check (length(import_source) <= 200);

create table doc_imports (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  kind         text not null default 'sales_invoice' check (kind in ('sales_invoice')),
  name         text check (length(name) <= 200),
  files        jsonb not null default '[]'::jsonb,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id)
);
create index doc_imports_recent on doc_imports (tenant_id, created_at desc);

create table doc_import_items (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  import_id    uuid not null,
  source_file  text not null check (length(source_file) <= 300),
  pages        text check (length(pages) <= 40),
  engine       text not null check (engine in ('text', 'sheet', 'ai', 'vision')),
  confidence   numeric(4, 3) not null default 0,
  data         jsonb not null,
  plan         jsonb not null default '{}'::jsonb,
  warnings     jsonb not null default '[]'::jsonb,
  raw_text     text check (length(raw_text) <= 60000),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  result       jsonb,
  error        text check (length(error) <= 1000),
  decided_by   uuid,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, import_id) references doc_imports (tenant_id, id) on delete cascade
);
create index doc_import_items_batch on doc_import_items (tenant_id, import_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['doc_imports', 'doc_import_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end $$;
