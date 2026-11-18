-- Payment reminders to customers: each stage of an invoice (before due, on due, n days late) is sent once.
create table invoice_reminders (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  invoice_id  uuid not null,
  stage       text not null check (length(stage) <= 20),
  sent_to     text not null check (length(sent_to) <= 300),
  sent_at     timestamptz not null default now(),
  sent_by     uuid,
  unique (tenant_id, id),
  unique (tenant_id, invoice_id, stage),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete cascade
);
create index invoice_reminders_invoice on invoice_reminders (tenant_id, invoice_id);

do $$
begin
  alter table invoice_reminders enable row level security;
  alter table invoice_reminders force row level security;
  create policy tenant_isolation on invoice_reminders as permissive for all to public
    using (tenant_id = (select app.current_tenant_id()))
    with check (tenant_id = (select app.current_tenant_id()));
  grant select, insert, update, delete on invoice_reminders to synapse_app;
end
$$;

-- GeM bids that match the keywords the business watches for
alter table gem_bids add column matched_keywords text[];

-- a monthly (or weekly) email of the books: profit and loss, cash, receivables and payables
alter table report_schedules drop constraint report_schedules_kind_check;
alter table report_schedules add constraint report_schedules_kind_check check (kind in ('health', 'dashboard', 'report', 'books'));
alter table report_schedules drop constraint report_schedules_check;
alter table report_schedules add constraint report_schedules_check check (kind in ('health', 'books') or target_id is not null);
