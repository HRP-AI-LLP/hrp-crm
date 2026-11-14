-- HRP Synapse · 0029 Books: double-entry accounting (Zoho Books class)
--
-- books_config        per workspace: on/off, books of record (synapse | tally), start date, lock date
-- gl_accounts         chart of accounts (types, sub-types, system keys for auto-posting)
-- journals / journal_lines   the ledger: balanced, immutable once posted, period lock enforced
-- bills / bill_lines  vendor bills and vendor credits (doc_type), GST input, reverse charge, TDS
-- vendor_payments / vendor_payment_allocations / vendor_credit_applications
-- expenses            expenses and employee claims (submit → approve → reimburse)
-- bank_accounts / bank_transactions / bank_rules / bank_reconciliations
-- recurring_profiles  recurring invoices, bills, expenses and journals
-- budgets             monthly budgets per account and financial year
-- fixed_assets        asset register with SLM / WDV depreciation runs
-- exchange_rates      multi-currency rates (base currency INR)
-- gstr2b_imports / gstr2b_lines   GSTR-2B reconciliation against bills
-- invoices / payments / products gain the columns the ledger needs

-- ------------------------------------------------------------------------------------- config
create table books_config (
  tenant_id          uuid primary key default app.current_tenant_id() references tenants (id) on delete cascade,
  enabled            boolean not null default false,
  books_of_record    text not null default 'synapse' check (books_of_record in ('synapse', 'tally')),
  start_date         date not null default make_date(extract(year from current_date)::int - (case when extract(month from current_date) < 4 then 1 else 0 end), 4, 1),
  lock_date          date,
  base_currency      char(3) not null default 'INR',
  tds_enabled        boolean not null default true,
  tan                text check (tan is null or tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  pan                text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  inventory_on       text not null default 'bill' check (inventory_on in ('bill', 'none')),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------------------------------- chart of accounts
create table gl_accounts (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  code          text check (code ~ '^[A-Za-z0-9.\-]{1,20}$'),
  name          text not null check (length(name) between 1 and 150),
  type          text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype       text not null check (subtype in (
                  'cash', 'bank', 'credit_card', 'accounts_receivable', 'inventory', 'current_asset', 'fixed_asset', 'accumulated_depreciation', 'other_asset', 'tax_receivable',
                  'accounts_payable', 'current_liability', 'long_term_liability', 'tax_payable', 'other_liability',
                  'equity', 'retained_earnings',
                  'income', 'other_income',
                  'cost_of_goods_sold', 'expense', 'other_expense')),
  system_key    text check (system_key ~ '^[a-z_]{2,40}$'),
  parent_id     uuid,
  description   text check (length(description) <= 500),
  is_active     boolean not null default true,
  currency      char(3),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references gl_accounts (tenant_id, id) on delete restrict
);
create unique index gl_accounts_code on gl_accounts (tenant_id, code) where code is not null;
create unique index gl_accounts_name on gl_accounts (tenant_id, lower(name));
create unique index gl_accounts_system on gl_accounts (tenant_id, system_key) where system_key is not null;

-- ------------------------------------------------------------------------------------- ledger
create table journals (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  number         text,
  entry_date     date not null,
  source_type    text not null check (source_type in ('manual', 'opening', 'invoice', 'credit_note', 'payment', 'write_off', 'bill', 'vendor_credit', 'vendor_payment', 'expense',
                                                     'reimbursement', 'transfer', 'bank', 'depreciation', 'asset_disposal', 'inventory', 'work_order', 'job_work', 'timesheet', 'fx')),
  source_id      uuid,
  reference      text check (length(reference) <= 120),
  narration      text check (length(narration) <= 2000),
  status         text not null default 'posted' check (status in ('posted', 'void')),
  currency       char(3) not null default 'INR',
  exchange_rate  numeric(18, 6) not null default 1 check (exchange_rate > 0),
  total          numeric(18, 2) not null default 0,
  void_reason    text,
  voided_at      timestamptz,
  created_by     uuid default app.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (tenant_id, id)
);
create index journals_date on journals (tenant_id, entry_date) where status = 'posted';
create unique index journals_source on journals (tenant_id, source_type, source_id) where status = 'posted' and source_id is not null and source_type <> 'manual';

create table journal_lines (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  journal_id      uuid not null,
  account_id      uuid not null,
  debit           numeric(18, 2) not null default 0 check (debit >= 0),
  credit          numeric(18, 2) not null default 0 check (credit >= 0),
  fc_amount       numeric(18, 2),
  party_type      text check (party_type in ('customer', 'vendor', 'employee')),
  party_id        uuid,
  project_id      uuid,
  description     text check (length(description) <= 500),
  tax_kind        text check (tax_kind in ('cgst', 'sgst', 'igst', 'cess', 'tds')),
  entry_date      date not null,
  posted          boolean not null default true,
  reconciliation_id uuid,
  bank_txn_id     uuid,
  unique (tenant_id, id),
  check ((debit = 0) <> (credit = 0)),
  foreign key (tenant_id, journal_id) references journals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, account_id) references gl_accounts (tenant_id, id) on delete restrict
);
create index journal_lines_account on journal_lines (tenant_id, account_id, entry_date) where posted;
create index journal_lines_party on journal_lines (tenant_id, party_type, party_id, entry_date) where posted;
create index journal_lines_journal on journal_lines (tenant_id, journal_id);

-- every posted journal balances (checked at commit, so lines can be added one by one)
create or replace function app.check_journal_balance() returns trigger
language plpgsql as $$
declare j uuid := coalesce(new.journal_id, old.journal_id); t uuid := coalesce(new.tenant_id, old.tenant_id); d numeric; c numeric; n int;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into d, c, n from journal_lines where tenant_id = t and journal_id = j;
  if exists (select 1 from journals where tenant_id = t and id = j) and (d <> c or n < 2) then
    raise exception 'journal % does not balance (debits %, credits %)', j, d, c using errcode = 'check_violation';
  end if;
  return null;
end
$$;
create constraint trigger journal_lines_balance after insert or update or delete on journal_lines deferrable initially deferred for each row execute function app.check_journal_balance();

-- posted entries are immutable (only voiding); nothing may be posted on or before the lock date
create or replace function app.guard_journal() returns trigger
language plpgsql as $$
declare lock date;
begin
  select lock_date into lock from books_config where tenant_id = coalesce(new.tenant_id, old.tenant_id);
  if tg_op = 'INSERT' then
    if lock is not null and new.entry_date <= lock then
      raise exception 'the books are locked up to %', lock using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'journals cannot be deleted; void them instead' using errcode = 'check_violation';
  end if;
  if old.status = 'void' then
    raise exception 'a void journal cannot change' using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - array['status', 'void_reason', 'voided_at']) is distinct from (to_jsonb(old) - array['status', 'void_reason', 'voided_at']) then
    raise exception 'posted journals cannot be edited; void and re-post' using errcode = 'check_violation';
  end if;
  if lock is not null and old.entry_date <= lock then
    raise exception 'the books are locked up to %', lock using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger journals_guard before insert or update or delete on journals for each row execute function app.guard_journal();

create or replace function app.guard_journal_lines() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['posted', 'reconciliation_id', 'bank_txn_id']) = (to_jsonb(old) - array['posted', 'reconciliation_id', 'bank_txn_id']) then
    return new;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'journal lines cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger journal_lines_guard before update or delete on journal_lines for each row execute function app.guard_journal_lines();

-- voiding a journal takes its lines out of balances
create or replace function app.void_journal_lines() returns trigger
language plpgsql as $$
begin
  if new.status = 'void' and old.status = 'posted' then
    update journal_lines set posted = false where tenant_id = new.tenant_id and journal_id = new.id;
  end if;
  return null;
end
$$;
create trigger journals_void after update on journals for each row execute function app.void_journal_lines();

-- ------------------------------------------------------------------------------------- items and documents
alter table products
  add column purchase_price      numeric(18, 2) check (purchase_price >= 0),
  add column avg_cost            numeric(18, 4) check (avg_cost >= 0),
  add column sales_account_id    uuid,
  add column purchase_account_id uuid,
  add constraint products_sales_account foreign key (tenant_id, sales_account_id) references gl_accounts (tenant_id, id) on delete set null (sales_account_id),
  add constraint products_purchase_account foreign key (tenant_id, purchase_account_id) references gl_accounts (tenant_id, id) on delete set null (purchase_account_id);

alter table invoices add column exchange_rate numeric(18, 6) not null default 1 check (exchange_rate > 0);
alter table invoices add column amount_written_off numeric(18, 2) not null default 0 check (amount_written_off >= 0);
alter table invoices add column written_off_on date;
alter table invoices drop column balance_due;
alter table invoices add column balance_due numeric(18, 2) generated always as (grand_total - amount_paid - amount_credited - amount_written_off) stored;
create index invoices_balance on invoices (tenant_id, account_id) where balance_due > 0 and deleted_at is null;

create or replace function app.guard_issued_invoice() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and old.invoice_number is not null then
    if (to_jsonb(new) - array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                              'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'amount_paid', 'amount_credited', 'amount_written_off', 'written_off_on', 'balance_due', 'irn', 'ack_no', 'ack_date', 'cancelled_at', 'cancel_reason',
                              'overdue_notified_at', 'updated_at', 'updated_by', 'version', 'custom', 'owner_id', 'notes', 'approval_status', 'deleted_at']) then
      raise exception 'issued invoice % cannot be changed', old.invoice_number using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

alter table payments
  add column deposit_account_id uuid,
  add column tds_amount        numeric(18, 2) not null default 0 check (tds_amount >= 0),
  add column bank_charges      numeric(18, 2) not null default 0 check (bank_charges >= 0),
  add column currency          char(3) not null default 'INR',
  add column exchange_rate     numeric(18, 6) not null default 1 check (exchange_rate > 0),
  add constraint payments_deposit_account foreign key (tenant_id, deposit_account_id) references gl_accounts (tenant_id, id) on delete restrict;

create table bills (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name               text not null,
  doc_type           text not null default 'bill' check (doc_type in ('bill', 'vendor_credit')),
  bill_number        text,
  vendor_ref         text check (length(vendor_ref) <= 60),
  status             text not null default 'draft' check (status in ('draft', 'open', 'partially_paid', 'paid', 'void')),
  approval_status    text not null default 'not_required' check (approval_status in ('not_required', 'required', 'pending', 'approved', 'rejected')),
  vendor_id          uuid,
  purchase_order_id  uuid,
  original_bill_id   uuid,
  bill_date          date not null default current_date,
  due_date           date,
  financial_year     text,
  vendor_gstin       text check (vendor_gstin is null or vendor_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  place_of_supply    text,
  pos_code           text check (pos_code is null or pos_code ~ '^[0-9]{2}$'),
  supply_type        text check (supply_type in ('intra', 'inter', 'import')),
  reverse_charge     boolean not null default false,
  itc_eligible       boolean not null default true,
  currency           char(3) not null default 'INR',
  exchange_rate      numeric(18, 6) not null default 1 check (exchange_rate > 0),
  subtotal           numeric(18, 2) not null default 0,
  discount_total     numeric(18, 2) not null default 0,
  taxable_total      numeric(18, 2) not null default 0,
  cgst_total         numeric(18, 2) not null default 0,
  sgst_total         numeric(18, 2) not null default 0,
  igst_total         numeric(18, 2) not null default 0,
  tax_total          numeric(18, 2) not null default 0,
  tds_section        text check (tds_section ~ '^[0-9A-Z()]{3,12}$'),
  tds_rate           numeric(5, 2) not null default 0 check (tds_rate between 0 and 40),
  tds_amount         numeric(18, 2) not null default 0 check (tds_amount >= 0),
  round_off          numeric(8, 2) not null default 0,
  grand_total        numeric(18, 2) not null default 0,
  max_discount_pct   numeric(5, 2) not null default 0,
  amount_paid        numeric(18, 2) not null default 0,
  amount_credited    numeric(18, 2) not null default 0,
  balance_due        numeric(18, 2) generated always as (grand_total - tds_amount - amount_paid - amount_credited) stored,
  project_id         uuid,
  notes              text,
  posted_at          timestamptz,
  void_reason        text,
  owner_id           uuid,
  custom             jsonb not null default '{}'::jsonb,
  created_by         uuid default app.current_user_id(),
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  merged_into        uuid,
  version            integer not null default 1,
  unique (tenant_id, id),
  check (doc_type <> 'vendor_credit' or tds_amount = 0),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id) on delete restrict,
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id) on delete set null (purchase_order_id),
  foreign key (tenant_id, original_bill_id) references bills (tenant_id, id) on delete restrict,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index bills_number on bills (tenant_id, doc_type, bill_number) where bill_number is not null;
create unique index bills_vendor_ref on bills (tenant_id, vendor_id, doc_type, lower(vendor_ref)) where vendor_ref is not null and status <> 'void' and deleted_at is null;
create index bills_vendor on bills (tenant_id, vendor_id, bill_date) where deleted_at is null;
create index bills_due on bills (tenant_id, due_date) where status in ('open', 'partially_paid') and deleted_at is null;

create table bill_lines (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  order_id       uuid not null,  -- the bill (line tables share the column name)
  position       integer not null default 0,
  product_id     uuid,
  po_line_id     uuid,
  account_id     uuid,
  name           text not null,
  description    text,
  hsn_sac        text,
  unit           text,
  quantity       numeric(14, 3) not null default 1 check (quantity > 0),
  unit_price     numeric(18, 2) not null default 0 check (unit_price >= 0),
  discount_pct   numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  tax_rate       numeric(5, 2) not null default 0 check (tax_rate between 0 and 100),
  line_subtotal  numeric(18, 2) not null default 0,
  line_tax       numeric(18, 2) not null default 0,
  line_total     numeric(18, 2) not null default 0,
  line_cgst      numeric(18, 2) not null default 0,
  line_sgst      numeric(18, 2) not null default 0,
  line_igst      numeric(18, 2) not null default 0,
  billable_account_id uuid,
  project_id     uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references bills (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id),
  foreign key (tenant_id, po_line_id) references purchase_order_lines (tenant_id, id) on delete set null (po_line_id),
  foreign key (tenant_id, account_id) references gl_accounts (tenant_id, id) on delete restrict
);
create index bill_lines_bill on bill_lines (tenant_id, order_id, position);

create or replace function app.guard_posted_bill_lines() returns trigger
language plpgsql as $$
declare b uuid := coalesce(new.order_id, old.order_id); t uuid := coalesce(new.tenant_id, old.tenant_id);
begin
  if exists (select 1 from bills where tenant_id = t and id = b and status <> 'draft') then
    raise exception 'lines of a posted bill cannot be changed' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end
$$;
create trigger bill_lines_guard before insert or update or delete on bill_lines for each row execute function app.guard_posted_bill_lines();

create table vendor_payments (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name               text not null,
  payment_number     text,
  status             text not null default 'paid' check (status in ('paid', 'void')),
  vendor_id          uuid,
  payment_date       date not null default current_date,
  amount             numeric(18, 2) not null check (amount > 0),
  amount_allocated   numeric(18, 2) not null default 0,
  unallocated        numeric(18, 2) generated always as (amount - amount_allocated) stored,
  mode               text not null default 'bank_transfer' check (mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  paid_through_id    uuid,
  reference          text check (length(reference) <= 120),
  currency           char(3) not null default 'INR',
  exchange_rate      numeric(18, 6) not null default 1 check (exchange_rate > 0),
  financial_year     text,
  notes              text,
  void_reason        text,
  owner_id           uuid,
  custom             jsonb not null default '{}'::jsonb,
  created_by         uuid default app.current_user_id(),
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  merged_into        uuid,
  version            integer not null default 1,
  unique (tenant_id, id),
  check (amount_allocated >= 0 and amount_allocated <= amount),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id) on delete restrict,
  foreign key (tenant_id, paid_through_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index vendor_payments_number on vendor_payments (tenant_id, payment_number) where payment_number is not null;

create table vendor_payment_allocations (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  payment_id  uuid not null,
  bill_id     uuid not null,
  amount      numeric(18, 2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, payment_id, bill_id),
  foreign key (tenant_id, payment_id) references vendor_payments (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bill_id) references bills (tenant_id, id) on delete cascade
);

create table vendor_credit_applications (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  credit_id   uuid not null,
  bill_id     uuid not null,
  amount      numeric(18, 2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, credit_id, bill_id),
  foreign key (tenant_id, credit_id) references bills (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bill_id) references bills (tenant_id, id) on delete cascade
);

create table expenses (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name               text not null,
  expense_number     text,
  status             text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'recorded', 'reimbursed', 'void')),
  is_claim           boolean not null default false,
  expense_date       date not null default current_date,
  account_id         uuid,
  paid_through_id    uuid,
  vendor_id          uuid,
  vendor_name        text check (length(vendor_name) <= 200),
  vendor_gstin       text check (vendor_gstin is null or vendor_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  hsn_sac            text,
  amount             numeric(18, 2) not null check (amount > 0),
  amount_is_inclusive boolean not null default true,
  tax_rate           numeric(5, 2) not null default 0 check (tax_rate between 0 and 100),
  supply_type        text not null default 'intra' check (supply_type in ('intra', 'inter')),
  itc_eligible       boolean not null default true,
  taxable_amount     numeric(18, 2) not null default 0,
  tax_amount         numeric(18, 2) not null default 0,
  total              numeric(18, 2) not null default 0,
  mileage_km         numeric(10, 2) check (mileage_km >= 0),
  billable           boolean not null default false,
  customer_id        uuid,
  project_id         uuid,
  invoice_id         uuid,
  currency           char(3) not null default 'INR',
  exchange_rate      numeric(18, 6) not null default 1 check (exchange_rate > 0),
  reference          text check (length(reference) <= 120),
  notes              text,
  approved_by        uuid,
  approved_at        timestamptz,
  reimbursed_at      timestamptz,
  reimbursed_through_id uuid,
  reject_reason      text,
  owner_id           uuid,
  custom             jsonb not null default '{}'::jsonb,
  created_by         uuid default app.current_user_id(),
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  merged_into        uuid,
  version            integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, paid_through_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, reimbursed_through_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id) on delete set null (vendor_id),
  foreign key (tenant_id, customer_id) references accounts (tenant_id, id) on delete set null (customer_id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete set null (invoice_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id),
  foreign key (tenant_id, approved_by) references users (tenant_id, id) on delete set null (approved_by)
);
create index expenses_owner on expenses (tenant_id, owner_id, expense_date) where deleted_at is null;

-- an expense's tax and total follow its amount; once approved or recorded only its status moves
create or replace function app.expense_totals() returns trigger
language plpgsql as $$
declare base numeric; tax numeric;
begin
  if tg_op = 'UPDATE' and old.status in ('approved', 'recorded', 'reimbursed', 'void')
     and (to_jsonb(new) - array['status', 'reimbursed_at', 'reimbursed_through_id', 'invoice_id', 'updated_at', 'updated_by', 'version', 'notes', 'custom', 'deleted_at', 'expense_number'])
         is distinct from (to_jsonb(old) - array['status', 'reimbursed_at', 'reimbursed_through_id', 'invoice_id', 'updated_at', 'updated_by', 'version', 'notes', 'custom', 'deleted_at', 'expense_number']) then
    raise exception 'an approved or recorded expense cannot be edited; void it and record a new one' using errcode = 'check_violation';
  end if;
  if new.amount_is_inclusive then
    base := round(new.amount * 100 / (100 + new.tax_rate), 2);
    tax := new.amount - base;
  else
    base := new.amount;
    tax := round(new.amount * new.tax_rate / 100, 2);
  end if;
  new.taxable_amount := base;
  new.tax_amount := tax;
  new.total := base + tax;
  return new;
end
$$;
create trigger expenses_totals before insert or update on expenses for each row execute function app.expense_totals();

-- ------------------------------------------------------------------------------------- banking
create table bank_accounts (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  gl_account_id    uuid not null,
  bank_name        text check (length(bank_name) <= 120),
  account_last4    text check (account_last4 ~ '^[0-9]{4}$'),
  ifsc             text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  kind             text not null default 'bank' check (kind in ('bank', 'cash', 'credit_card', 'wallet')),
  is_active        boolean not null default true,
  last_statement_date date,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, gl_account_id),
  foreign key (tenant_id, gl_account_id) references gl_accounts (tenant_id, id) on delete restrict
);

create table bank_reconciliations (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bank_account_id   uuid not null,
  statement_date    date not null,
  closing_balance   numeric(18, 2) not null,
  cleared_balance   numeric(18, 2) not null,
  status            text not null default 'completed' check (status in ('completed', 'undone')),
  created_by        uuid default app.current_user_id(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id) on delete cascade
);

create table bank_transactions (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bank_account_id  uuid not null,
  txn_date         date not null,
  description      text not null check (length(description) <= 500),
  reference        text check (length(reference) <= 120),
  amount           numeric(18, 2) not null check (amount <> 0),
  balance          numeric(18, 2),
  status           text not null default 'unmatched' check (status in ('unmatched', 'matched', 'categorized', 'excluded')),
  journal_id       uuid,
  import_batch     text,
  dedupe_hash      text not null,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, bank_account_id, dedupe_hash),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, journal_id) references journals (tenant_id, id) on delete set null (journal_id)
);
create index bank_transactions_open on bank_transactions (tenant_id, bank_account_id, txn_date) where status = 'unmatched';
create index bank_transactions_journal on bank_transactions (tenant_id, journal_id) where journal_id is not null;
create index journal_lines_bank_txn on journal_lines (tenant_id, bank_txn_id) where bank_txn_id is not null;

create table bank_rules (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name             text not null check (length(name) between 1 and 120),
  bank_account_id  uuid,
  direction        text not null default 'any' check (direction in ('in', 'out', 'any')),
  contains         text not null check (length(contains) between 2 and 120),
  account_id       uuid not null,
  party_type       text check (party_type in ('customer', 'vendor')),
  party_id         uuid,
  priority         integer not null default 100,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references gl_accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id) on delete cascade
);

alter table journal_lines add constraint journal_lines_reconciliation foreign key (tenant_id, reconciliation_id) references bank_reconciliations (tenant_id, id) on delete set null (reconciliation_id);

-- ------------------------------------------------------------------------------------- automation and planning
create table recurring_profiles (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name           text not null check (length(name) between 1 and 150),
  kind           text not null check (kind in ('invoice', 'bill', 'expense', 'journal')),
  template       jsonb not null,
  frequency      text not null check (frequency in ('weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly')),
  every          integer not null default 1 check (every between 1 and 12),
  start_date     date not null,
  end_date       date,
  next_date      date not null,
  last_run_at    timestamptz,
  last_doc_id    uuid,
  runs           integer not null default 0,
  auto_issue     boolean not null default false,
  status         text not null default 'active' check (status in ('active', 'paused', 'ended')),
  last_error     text,
  created_by     uuid default app.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id)
);
create index recurring_due on recurring_profiles (tenant_id, next_date) where status = 'active';

create table budgets (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name           text not null check (length(name) between 1 and 120),
  financial_year text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  project_id     uuid,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id)
);
create table budget_lines (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  budget_id   uuid not null,
  account_id  uuid not null,
  -- 12 amounts, April → March
  months      numeric(18, 2)[] not null check (array_length(months, 1) = 12),
  primary key (tenant_id, budget_id, account_id),
  foreign key (tenant_id, budget_id) references budgets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, account_id) references gl_accounts (tenant_id, id) on delete cascade
);

create table fixed_assets (
  id                   uuid primary key default app.uuidv7(),
  tenant_id            uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                 text not null check (length(name) between 1 and 150),
  asset_number         text,
  asset_account_id     uuid not null,
  depreciation_account_id uuid not null,
  accumulated_account_id  uuid not null,
  purchase_date        date not null,
  in_service_date      date not null,
  cost                 numeric(18, 2) not null check (cost > 0),
  salvage_value        numeric(18, 2) not null default 0 check (salvage_value >= 0),
  method               text not null default 'slm' check (method in ('slm', 'wdv')),
  rate_pct             numeric(6, 2) check (rate_pct > 0 and rate_pct <= 100),
  life_months          integer check (life_months > 0),
  accumulated          numeric(18, 2) not null default 0,
  depreciated_to       date,
  status               text not null default 'active' check (status in ('active', 'disposed', 'fully_depreciated')),
  disposed_on          date,
  disposal_amount      numeric(18, 2),
  bill_id              uuid,
  location             text check (length(location) <= 200),
  serial_no            text check (length(serial_no) <= 120),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  check (method = 'wdv' and rate_pct is not null or method = 'slm' and (life_months is not null or rate_pct is not null)),
  foreign key (tenant_id, asset_account_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, depreciation_account_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, accumulated_account_id) references gl_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, bill_id) references bills (tenant_id, id) on delete set null (bill_id)
);

-- one row per asset per depreciation run, so a run can be undone exactly
create table asset_depreciation (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  asset_id     uuid not null,
  journal_id   uuid,
  from_date    date not null,
  to_date      date not null,
  amount       numeric(18, 2) not null check (amount >= 0),
  voided       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, asset_id) references fixed_assets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, journal_id) references journals (tenant_id, id) on delete set null (journal_id)
);
create index asset_depreciation_asset on asset_depreciation (tenant_id, asset_id, to_date desc) where not voided;
create index asset_depreciation_journal on asset_depreciation (tenant_id, journal_id);

create table exchange_rates (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  rate_date   date not null,
  rate        numeric(18, 6) not null check (rate > 0),
  primary key (tenant_id, currency, rate_date)
);

create table gstr2b_imports (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  period        text not null check (period ~ '^[0-9]{6}$'),
  gstin         text,
  lines         integer not null default 0,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, period)
);
create table gstr2b_lines (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  import_id     uuid not null,
  supplier_gstin text not null,
  supplier_name text,
  doc_number    text not null,
  doc_date      date,
  doc_type      text,
  taxable       numeric(18, 2) not null default 0,
  igst          numeric(18, 2) not null default 0,
  cgst          numeric(18, 2) not null default 0,
  sgst          numeric(18, 2) not null default 0,
  itc_available boolean not null default true,
  match_status  text not null default 'unmatched' check (match_status in ('matched', 'mismatch', 'unmatched')),
  bill_id       uuid,
  note          text,
  unique (tenant_id, id),
  foreign key (tenant_id, import_id) references gstr2b_imports (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bill_id) references bills (tenant_id, id) on delete set null (bill_id)
);

-- ------------------------------------------------------------------------------------- RLS, grants, triggers
do $$
declare t text;
begin
  foreach t in array array['books_config', 'gl_accounts', 'journals', 'journal_lines', 'bills', 'bill_lines', 'vendor_payments', 'vendor_payment_allocations',
                           'vendor_credit_applications', 'expenses', 'bank_accounts', 'bank_reconciliations', 'bank_transactions', 'bank_rules',
                           'recurring_profiles', 'budgets', 'budget_lines', 'fixed_assets', 'asset_depreciation', 'exchange_rates', 'gstr2b_imports', 'gstr2b_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
-- the ledger is append-only for the application (void, never delete)
revoke delete on journals, journal_lines from synapse_app;

create trigger books_config_touch     before update on books_config     for each row execute function app.touch_row();
create trigger gl_accounts_touch      before update on gl_accounts      for each row execute function app.touch_row();
create trigger bills_touch            before update on bills            for each row execute function app.touch_row();
create trigger vendor_payments_touch  before update on vendor_payments  for each row execute function app.touch_row();
create trigger expenses_touch         before update on expenses         for each row execute function app.touch_row();
create trigger recurring_touch        before update on recurring_profiles for each row execute function app.touch_row();
create trigger fixed_assets_touch     before update on fixed_assets     for each row execute function app.touch_row();
create trigger bills_rindex           after insert or update or delete on bills           for each row execute function app.sync_record_index('bill');
create trigger vendor_payments_rindex after insert or update or delete on vendor_payments for each row execute function app.sync_record_index('vendor_payment');
create trigger expenses_rindex        after insert or update or delete on expenses        for each row execute function app.sync_record_index('expense');
create trigger gl_accounts_audit      after insert or update or delete on gl_accounts      for each row execute function app.audit_row_change('gl_account');
create trigger journals_audit         after insert or update on journals                   for each row execute function app.audit_row_change('journal');
create trigger bills_audit            after insert or update or delete on bills            for each row execute function app.audit_row_change('bill');
create trigger vendor_payments_audit  after insert or update or delete on vendor_payments  for each row execute function app.audit_row_change('vendor_payment');
create trigger expenses_audit         after insert or update or delete on expenses         for each row execute function app.audit_row_change('expense');
create trigger books_config_audit     after insert or update on books_config               for each row execute function app.audit_row_change('books_config');
create trigger fixed_assets_audit     after insert or update or delete on fixed_assets     for each row execute function app.audit_row_change('fixed_asset');
create trigger bank_rules_audit       after insert or update or delete on bank_rules       for each row execute function app.audit_row_change('bank_rule');
