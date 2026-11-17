-- 0035: GSTR-2B lines matched to bills by hand. A supplier's document number often differs from what
-- was typed on the bill (prefixes, years, zeros); once someone links the two, every later fetch or
-- re-match of that month keeps the link instead of reporting the document as "not in your books".

create table gstr2b_links (
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  supplier_gstin  text not null check (supplier_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  doc_key         text not null check (length(doc_key) between 1 and 60),
  bill_id         uuid not null,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  primary key (tenant_id, supplier_gstin, doc_key),
  unique (tenant_id, bill_id)
);

alter table gstr2b_links enable row level security;
alter table gstr2b_links force row level security;
create policy tenant_isolation on gstr2b_links as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on gstr2b_links to synapse_app;
