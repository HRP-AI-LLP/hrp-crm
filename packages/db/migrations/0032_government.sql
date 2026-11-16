-- 0032: government and tender contracts (GeM, CPPP, PSU tenders)
--
--  * buyer's order / contract reference (e.g. a GeM contract number) and date on sales orders,
--    invoices and projects, printed on the invoice
--  * milestone acceptance (e.g. GeM CRAC, inspection or completion certificate) on project milestones
--  * receipts with the deductions government buyers make: income-tax TDS (already there), GST TDS
--    under section 51, liquidated damages / penalties and retention money
--  * a register of deposits and guarantees: EMD, performance security (bank guarantee, ePBG, FDR,
--    DD, insurance surety bond), retention money and other security deposits, with expiry dates,
--    release and forfeiture, posted to the books
--  * customers can be marked "government"; deals can come from GeM or a tender

-- ------------------------------------------------------------------------------- references
alter table sales_orders
  add column customer_ref      text check (length(customer_ref) <= 100),
  add column customer_ref_date date;
alter table invoices
  add column customer_ref      text check (length(customer_ref) <= 100),
  add column customer_ref_date date;
alter table projects
  add column customer_ref      text check (length(customer_ref) <= 100),
  add column customer_ref_date date;

-- a bid is a deal: where it came from, the bid number and when it closes
alter table deals
  add column source        text check (length(source) <= 40),
  add column bid_number    text check (length(bid_number) <= 100),
  add column bid_due_date  date;

alter table project_milestones
  add column accepted_on    date,
  add column acceptance_ref text check (length(acceptance_ref) <= 100);

alter table accounts drop constraint if exists accounts_account_type_check;
alter table accounts add constraint accounts_account_type_check
  check (account_type in ('customer', 'prospect', 'architect', 'interior_designer', 'dealer', 'builder', 'partner', 'government', 'other'));

-- ------------------------------------------------------------------------------- receipts
alter table payments
  add column gst_tds_amount   numeric(18, 2) not null default 0 check (gst_tds_amount >= 0),
  add column ld_amount        numeric(18, 2) not null default 0 check (ld_amount >= 0),
  add column retention_amount numeric(18, 2) not null default 0 check (retention_amount >= 0);
-- NOT VALID: checked for new and changed rows without failing the migration on any old row
alter table payments add constraint payments_deductions_within_amount
  check (tds_amount + bank_charges + gst_tds_amount + ld_amount + retention_amount <= amount) not valid;

-- ------------------------------------------------------------------------------- deposits and guarantees
create table security_deposits (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  deposit_number     text,
  kind               text not null check (kind in ('emd', 'performance_security', 'retention', 'security_deposit', 'other')),
  instrument         text not null check (instrument in ('online', 'dd', 'fdr', 'cash', 'bank_guarantee', 'epbg', 'insurance_bond', 'withheld', 'exempt')),
  account_id         uuid not null,
  project_id         uuid,
  sales_order_id     uuid,
  deal_id            uuid,
  payment_id         uuid,                 -- retention withheld from this receipt
  reference          text check (length(reference) <= 100),   -- BG / FDR / DD number, bid number
  issuing_bank       text check (length(issuing_bank) <= 120),
  amount             numeric(18, 2) not null check (amount > 0),
  margin_amount      numeric(18, 2) not null default 0 check (margin_amount >= 0),
  issue_date         date not null default current_date,
  expiry_date        date,
  claim_until        date,
  paid_from          uuid,                 -- bank / cash ledger the money (or BG margin) left from
  released_amount    numeric(18, 2) not null default 0 check (released_amount >= 0),
  forfeited_amount   numeric(18, 2) not null default 0 check (forfeited_amount >= 0),
  status             text not null default 'active' check (status in ('active', 'closed', 'cancelled')),
  expiry_notice      smallint,
  in_ledger          boolean not null default false,   -- placed with a journal (or already in the opening balances)             -- the last reminder sent: 30 or 7 days before expiry
  notes              text check (length(notes) <= 2000),
  created_by         uuid default app.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  check (released_amount + forfeited_amount <= amount),
  check (margin_amount <= amount),
  check (expiry_date is null or expiry_date >= issue_date),
  check (claim_until is null or expiry_date is null or claim_until >= expiry_date),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id),
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id) on delete restrict,
  foreign key (tenant_id, paid_from) references gl_accounts (tenant_id, id) on delete restrict
);
create unique index security_deposits_number on security_deposits (tenant_id, deposit_number) where deposit_number is not null;
create unique index security_deposits_payment on security_deposits (tenant_id, payment_id) where payment_id is not null and status <> 'cancelled';
create index security_deposits_expiry on security_deposits (tenant_id, expiry_date) where status = 'active';
create index security_deposits_account on security_deposits (tenant_id, account_id);

-- every movement of a deposit; each posts its own journal (source "deposit")
create table security_deposit_events (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  deposit_id    uuid not null,
  kind          text not null check (kind in ('place', 'release', 'forfeit', 'extend', 'cancel')),
  event_date    date not null default current_date,
  amount        numeric(18, 2) not null default 0 check (amount >= 0),
  margin        numeric(18, 2) not null default 0 check (margin >= 0),
  bank_account  uuid,
  new_expiry    date,
  note          text check (length(note) <= 500),
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, deposit_id) references security_deposits (tenant_id, id) on delete cascade,
  foreign key (tenant_id, bank_account) references gl_accounts (tenant_id, id) on delete restrict
);
create index security_deposit_events_deposit on security_deposit_events (tenant_id, deposit_id, created_at);

alter table journals drop constraint if exists journals_source_type_check;
alter table journals add constraint journals_source_type_check
  check (source_type in ('manual', 'opening', 'invoice', 'credit_note', 'payment', 'write_off', 'bill', 'vendor_credit', 'vendor_payment', 'expense',
                         'reimbursement', 'transfer', 'bank', 'depreciation', 'asset_disposal', 'inventory', 'work_order', 'job_work', 'timesheet', 'fx', 'deposit'));

do $$
declare t text;
begin
  foreach t in array array['security_deposits', 'security_deposit_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
  end loop;
end $$;
grant select, insert, update on security_deposits to synapse_app;
grant select, insert on security_deposit_events to synapse_app;   -- the movement log is append-only

create trigger security_deposits_touch before update on security_deposits for each row execute function app.touch_row();
create trigger security_deposits_audit after insert or update or delete on security_deposits for each row execute function app.audit_row_change('security_deposit');
