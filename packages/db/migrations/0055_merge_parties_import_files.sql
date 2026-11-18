-- Merging duplicate customers or vendors re-points their issued invoices, posted bills and ledger
-- lines at the kept record. The guards let that through only while a merge runs (app.merging).

create or replace function app.guard_journal_lines() returns trigger
language plpgsql as $$
declare j record;
begin
  -- merging duplicate parties re-points their documents and ledger lines; nothing else changes
  if tg_op = 'UPDATE' and current_setting('app.merging', true) = 'on' then return new; end if;
  if tg_op = 'DELETE' then
    raise exception 'journal lines cannot be deleted' using errcode = 'check_violation';
  end if;
  select status, entry_date into j from journals where tenant_id = new.tenant_id and id = new.journal_id;
  if tg_op = 'INSERT' then
    -- lines go only into a posted journal and carry its date (the journal's lock-date check covers them)
    if j.status is distinct from 'posted' or new.entry_date is distinct from j.entry_date or not new.posted then
      raise exception 'journal lines must belong to a posted journal and carry its date' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['posted', 'reconciliation_id', 'bank_txn_id']) is distinct from (to_jsonb(old) - array['posted', 'reconciliation_id', 'bank_txn_id']) then
    raise exception 'journal lines cannot be changed' using errcode = 'check_violation';
  end if;
  -- lines leave the balances only when their journal is voided, and never come back
  if new.posted is distinct from old.posted and (new.posted or j.status <> 'void') then
    raise exception 'journal lines are taken out of balances only by voiding the journal' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create or replace function app.guard_issued_invoice() returns trigger
language plpgsql as $$
declare
  free text[] := array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                       'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at', 'project_id',
                       'irn_qr', 'irn_cancelled_at', 'ewb_no', 'ewb_date', 'ewb_valid_until', 'ewb_cancelled_at'];
begin
  -- merging duplicate parties re-points their documents and ledger lines; nothing else changes
  if tg_op = 'UPDATE' and current_setting('app.merging', true) = 'on' then return new; end if;
  if old.status <> 'draft' and old.invoice_number is not null then
    if (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
      raise exception 'issued invoice % cannot be changed', old.invoice_number using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

create or replace function app.guard_posted_bill() returns trigger
language plpgsql as $$
begin
  -- merging duplicate parties re-points their documents and ledger lines; nothing else changes
  if tg_op = 'UPDATE' and current_setting('app.merging', true) = 'on' then return new; end if;
  if old.status <> 'draft' and (to_jsonb(new) - array['status', 'amount_paid', 'amount_credited', 'balance_due', 'approval_status', 'void_reason', 'notes', 'custom', 'owner_id',
                                                     'updated_at', 'updated_by', 'version', 'deleted_at', 'name'])
       is distinct from (to_jsonb(old) - array['status', 'amount_paid', 'amount_credited', 'balance_due', 'approval_status', 'void_reason', 'notes', 'custom', 'owner_id',
                                                     'updated_at', 'updated_by', 'version', 'deleted_at', 'name']) then
    raise exception 'a posted bill cannot be changed; void it or raise a vendor credit' using errcode = 'check_violation';
  end if;
  if new.deleted_at is not null and old.deleted_at is null and old.status not in ('draft', 'void') then
    raise exception 'only draft or void bills can be deleted' using errcode = 'check_violation';
  end if;
  return new;
end
$$;


create or replace function app.guard_vendor_payment() returns trigger
language plpgsql as $$
begin
  -- merging duplicate parties re-points their documents and ledger lines; nothing else changes
  if tg_op = 'UPDATE' and current_setting('app.merging', true) = 'on' then return new; end if;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'a void payment cannot be reinstated' using errcode = 'check_violation';
  end if;
  if (new.amount, new.vendor_id, new.payment_date) is distinct from (old.amount, old.vendor_id, old.payment_date) then
    raise exception 'a vendor payment''s amount, vendor and date cannot change; void it and record a new one' using errcode = 'check_violation';
  end if;
  if new.deleted_at is not null and old.deleted_at is null and old.status <> 'void' then
    raise exception 'only void payments can be deleted' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- the file an imported invoice was read from, kept so it can be attached to the invoice it becomes
alter table doc_import_items add column source_file_id uuid;
