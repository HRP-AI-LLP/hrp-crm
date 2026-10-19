-- HRP Synapse · 0025 Tally sync
--
-- A small connector on the accountant's PC talks to Tally Prime / ERP 9 (its XML server on
-- localhost:9000) and to Synapse. Synapse hands it customer ledgers and vouchers that are new or
-- changed; the connector reports back what Tally accepted, and sends receipts entered in Tally.
--
-- tally_sync   one row per record pushed to Tally, with a content hash: a changed record (an
--              updated customer address) is pushed again; a cancelled invoice is flagged.

alter table integrations drop constraint integrations_provider_check;
alter table integrations add constraint integrations_provider_check check (provider in ('google', 'microsoft', 'razorpay', 'exotel', 'meta_leads', 'google_leads', 'tally'));

create table tally_sync (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  kind          text not null check (kind in ('ledger', 'stock_item', 'sales', 'credit_note', 'receipt')),
  record_id     uuid not null,
  name          text check (length(name) <= 300),
  status        text not null default 'pending' check (status in ('pending', 'sent', 'synced', 'failed', 'needs_attention')),
  hash          text,
  error         text check (length(error) <= 1000),
  attempts      integer not null default 0,
  sent_at       timestamptz,
  synced_at     timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, kind, record_id)
);
create index tally_sync_status on tally_sync (tenant_id, status);

alter table tally_sync enable row level security;
alter table tally_sync force row level security;
create policy tenant_isolation on tally_sync as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on tally_sync to synapse_app;
create trigger tally_sync_touch before update on tally_sync for each row execute function app.touch_row();
