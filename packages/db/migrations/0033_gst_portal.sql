-- 0033: GST portal through a GST Suvidha Provider (WhiteBooks)
--
--  * gst_connections: one per GSTIN — the GST portal username, the e-invoice and e-way bill API
--    users, and the portal session (OTP-based, refreshed before its 6 hours run out). Passwords and
--    session tokens are encrypted with DATA_ENCRYPTION_KEY (tenant id bound); never returned.
--  * gst_filings: one return per GSTIN, form and period — what was prepared, saved, its reference
--    id, the summary, and the ARN once filed
--  * gst_events: append-only log of every call made for a filing or connection
--  * gst_portal_cache: last fetched ledgers, return status, notices and challans (for the dashboard)
--  * invoices: e-way bill number and validity, the IRN's signed QR code, and IRN cancellation

create table gst_connections (
  id                    uuid primary key default app.uuidv7(),
  tenant_id             uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  gstin                 text not null check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  legal_name            text check (length(legal_name) <= 200),
  gst_username          text check (length(gst_username) <= 60),
  signatory_pan         text check (signatory_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),   -- authorised signatory, for EVC
  filing_frequency      text not null default 'monthly' check (filing_frequency in ('monthly', 'quarterly')),
  einv_username         text check (length(einv_username) <= 60),
  ewb_username          text check (length(ewb_username) <= 60),
  secret_ciphertext     text,                -- {"einvPassword","ewbPassword"}
  session_ciphertext    text,                -- {"txn"} and/or {"einvToken"}
  status                text not null default 'disconnected' check (status in ('disconnected', 'otp_sent', 'active', 'expired')),
  otp_sent_at           timestamptz,
  session_started_at    timestamptz,
  session_expires_at    timestamptz,
  einv_token_expires_at timestamptz,
  ewb_ready             boolean not null default false,
  last_error            text check (length(last_error) <= 1000),
  created_by            uuid default app.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,
  unique (tenant_id, gstin),
  unique (tenant_id, id)
);

create table gst_filings (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  connection_id   uuid not null,
  return_type     text not null check (return_type in ('GSTR1', 'GSTR1A', 'GSTR3B', 'GSTR7', 'GSTR2X', 'ITC04', 'GSTR9', 'GSTR9C', 'GSTR4', 'GSTR5', 'GSTR6', 'GSTR8', 'CMP08', 'ITC03')),
  period          text not null check (period ~ '^(0[1-9]|1[0-2])[0-9]{4}$'),   -- MMYYYY as the portal uses
  status          text not null default 'prepared' check (status in ('prepared', 'saving', 'saved', 'error', 'submitted', 'offset', 'filed')),
  payload         jsonb,                    -- what was (or will be) saved to the portal
  payload_source  text check (payload_source in ('synapse', 'upload', 'portal')),
  ref_id          text check (length(ref_id) <= 100),
  portal_status   text check (length(portal_status) <= 40),
  error_report    jsonb,
  summary         jsonb,                    -- the portal's return summary (what gets filed)
  arn             text check (length(arn) <= 40),
  filed_at        timestamptz,
  filed_by        uuid,
  filing_mode     text check (filing_mode in ('evc', 'dsc')),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  unique (tenant_id, connection_id, return_type, period),
  unique (tenant_id, id),
  foreign key (tenant_id, connection_id) references gst_connections (tenant_id, id) on delete cascade
);

create table gst_events (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  connection_id  uuid,
  filing_id      uuid,
  invoice_id     uuid,
  action         text not null check (length(action) <= 60),
  ok             boolean not null,
  message        text check (length(message) <= 2000),
  created_by     uuid default app.current_user_id(),
  created_at     timestamptz not null default now()
);
create index gst_events_connection on gst_events (tenant_id, connection_id, created_at desc);
create index gst_events_filing on gst_events (tenant_id, filing_id, created_at) where filing_id is not null;
create index gst_events_invoice on gst_events (tenant_id, invoice_id, created_at) where invoice_id is not null;

create table gst_portal_cache (
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  connection_id  uuid not null,
  kind           text not null check (length(kind) <= 40),
  key            text not null default '' check (length(key) <= 60),
  data           jsonb not null,
  fetched_at     timestamptz not null default now(),
  primary key (tenant_id, connection_id, kind, key),
  foreign key (tenant_id, connection_id) references gst_connections (tenant_id, id) on delete cascade
);

-- ------------------------------------------------------------------------------- invoices
alter table invoices
  add column irn_qr           text check (length(irn_qr) <= 4000),
  add column irn_cancelled_at timestamptz,
  add column ewb_no           text check (length(ewb_no) <= 20),
  add column ewb_date         timestamptz,
  add column ewb_valid_until  timestamptz,
  add column ewb_cancelled_at timestamptz;

-- the issued-invoice guard also lets the IRN's QR code, its cancellation and the e-way bill be recorded
create or replace function app.guard_issued_invoice() returns trigger
language plpgsql as $$
declare
  free text[] := array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                       'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at', 'project_id',
                       'irn_qr', 'irn_cancelled_at', 'ewb_no', 'ewb_date', 'ewb_valid_until', 'ewb_cancelled_at'];
begin
  if old.status <> 'draft' and old.invoice_number is not null then
    if (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
      raise exception 'issued invoice % cannot be changed', old.invoice_number using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

-- ------------------------------------------------------------------------------- RLS, grants, triggers
do $$
declare t text;
begin
  foreach t in array array['gst_connections', 'gst_filings', 'gst_events', 'gst_portal_cache'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
  end loop;
end $$;
grant select, insert, update, delete on gst_connections to synapse_app;
grant select, insert, update on gst_filings to synapse_app;
grant select, insert on gst_events to synapse_app;          -- the log is append-only
grant select, insert, update, delete on gst_portal_cache to synapse_app;

create trigger gst_connections_touch before update on gst_connections for each row execute function app.touch_row();
create trigger gst_filings_touch before update on gst_filings for each row execute function app.touch_row();
