-- Statutory compliance calendar, payroll (PF / ESI / PT / TDS on salary), TDS challans and returns,
-- and the books audit trail extended to document lines and bank lines (Companies (Accounts) Rules:
-- an edit log that cannot be switched off).

-- ───────────── compliance calendar ─────────────
create table compliance_items (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key           text not null check (key ~ '^[a-z0-9_:.-]{2,80}$'),     -- what it is: llp_form11, gstr3b, tds_26q, custom:…
  period        text not null check (length(period) between 1 and 40),  -- 2026-27, 2026-10, 2026-27 Q2 …
  name          text not null check (length(name) between 1 and 200),
  authority     text not null check (authority in ('MCA', 'GST', 'Income tax', 'TDS', 'EPFO', 'ESIC', 'State', 'Other')),
  description   text check (length(description) <= 2000),
  due_date      date not null,
  status        text not null default 'pending' check (status in ('pending', 'in_progress', 'filed', 'not_applicable')),
  filed_on      date,
  reference     text check (length(reference) <= 120),   -- SRN / ARN / acknowledgement number
  amount_paid   numeric(18, 2),                            -- fee, tax or penalty paid with it
  notes         text check (length(notes) <= 4000),
  assignee_id   uuid,
  person_id     uuid,                                      -- for a partner's or director's own filing (DIR-3 KYC)
  source        text not null default 'auto' check (source in ('auto', 'manual')),
  reminded_at   date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key, period),
  foreign key (tenant_id, assignee_id) references users (tenant_id, id) on delete set null (assignee_id)
);
create index compliance_due on compliance_items (tenant_id, due_date) where status in ('pending', 'in_progress');

-- ───────────── payroll ─────────────
create table employees (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  code             text check (length(code) <= 20),
  name             text not null check (length(name) between 1 and 150),
  user_id          uuid,
  email            text check (length(email) <= 200),
  phone            text check (length(phone) <= 25),
  pan              text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  uan              text check (uan is null or uan ~ '^[0-9]{12}$'),
  esic_no          text check (length(esic_no) <= 20),
  designation      text check (length(designation) <= 120),
  department       text check (length(department) <= 120),
  joined_on        date,
  left_on          date,
  state            text check (length(state) <= 60),         -- for professional tax
  tax_regime       text not null default 'new' check (tax_regime in ('new', 'old')),
  bank_name        text check (length(bank_name) <= 120),
  bank_account     text check (length(bank_account) <= 30),
  ifsc             text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  -- monthly salary: basic, hra, special and any other allowance
  basic            numeric(18, 2) not null default 0 check (basic >= 0),
  hra              numeric(18, 2) not null default 0 check (hra >= 0),
  special          numeric(18, 2) not null default 0 check (special >= 0),
  other_allowances jsonb not null default '[]'::jsonb,       -- [{"name": "Conveyance", "amount": 1600}]
  pf_enabled       boolean not null default true,
  pf_on_full_basic boolean not null default false,            -- else PF on basic capped at ₹15,000
  esi_enabled      boolean not null default true,              -- applies only while gross ≤ ₹21,000
  pt_enabled       boolean not null default false,
  annual_deductions numeric(18, 2) not null default 0,         -- old regime: 80C etc. declared
  status           text not null default 'active' check (status in ('active', 'left')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete set null (user_id)
);
create unique index employees_code on employees (tenant_id, lower(code)) where code is not null;

create table payroll_runs (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  period       text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status       text not null default 'draft' check (status in ('draft', 'posted', 'paid')),
  pay_date     date,
  gross        numeric(18, 2) not null default 0,
  net          numeric(18, 2) not null default 0,
  employer_cost numeric(18, 2) not null default 0,
  journal_id   uuid,
  paid_journal_id uuid,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, period)
);

create table payslips (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id        uuid not null,
  employee_id   uuid not null,
  days_in_month integer not null,
  paid_days     numeric(5, 2) not null,
  earnings      jsonb not null,        -- [{"name": "Basic", "amount": 25000}, …]
  gross         numeric(18, 2) not null,
  employee_pf   numeric(18, 2) not null default 0,
  employer_pf   numeric(18, 2) not null default 0,
  employee_esi  numeric(18, 2) not null default 0,
  employer_esi  numeric(18, 2) not null default 0,
  pt            numeric(18, 2) not null default 0,
  tds           numeric(18, 2) not null default 0,
  other_deductions numeric(18, 2) not null default 0,
  net           numeric(18, 2) not null,
  note          text check (length(note) <= 500),
  unique (tenant_id, id),
  unique (tenant_id, run_id, employee_id),
  foreign key (tenant_id, run_id) references payroll_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete restrict
);

-- ───────────── TDS challans (tax deposited) ─────────────
create table tds_challans (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  nature        text not null default 'non_salary' check (nature in ('non_salary', 'salary')),   -- 26Q or 24Q
  section       text check (section ~ '^[0-9A-Z()]{3,12}$'),
  period        text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- the month the tax was deducted
  deposited_on  date not null,
  tax           numeric(18, 2) not null default 0 check (tax >= 0),
  interest      numeric(18, 2) not null default 0 check (interest >= 0),
  late_fee      numeric(18, 2) not null default 0 check (late_fee >= 0),
  bsr_code      text check (bsr_code is null or bsr_code ~ '^[0-9]{7}$'),
  challan_no    text check (challan_no is null or challan_no ~ '^[0-9]{1,5}$'),
  cin           text check (length(cin) <= 40),
  bank_account_id uuid,
  journal_id    uuid,
  notes         text check (length(notes) <= 500),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create index tds_challans_period on tds_challans (tenant_id, period);

do $$
declare t text;
begin
  foreach t in array array['compliance_items', 'employees', 'payroll_runs', 'payslips', 'tds_challans'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

-- ───────────── audit trail: every edit to the books is logged, append-only ─────────────
create trigger invoice_lines_audit     after insert or update or delete on invoice_lines     for each row execute function app.audit_row_change('invoice_line');
create trigger bill_lines_audit        after insert or update or delete on bill_lines        for each row execute function app.audit_row_change('bill_line');
create trigger bank_transactions_audit after insert or update or delete on bank_transactions for each row execute function app.audit_row_change('bank_transaction');
create trigger service_contracts_audit after insert or update or delete on service_contracts for each row execute function app.audit_row_change('service_contract');
create trigger employees_audit         after insert or update or delete on employees         for each row execute function app.audit_row_change('employee');
create trigger payroll_runs_audit      after insert or update or delete on payroll_runs      for each row execute function app.audit_row_change('payroll_run');
create trigger payslips_audit          after insert or update or delete on payslips          for each row execute function app.audit_row_change('payslip');
create trigger tds_challans_audit      after insert or update or delete on tds_challans      for each row execute function app.audit_row_change('tds_challan');
create trigger compliance_items_audit  after insert or update or delete on compliance_items  for each row execute function app.audit_row_change('compliance_item');

-- payroll and TDS deposits post journals of their own
alter table journals drop constraint if exists journals_source_type_check;
alter table journals add constraint journals_source_type_check
  check (source_type in ('manual', 'opening', 'invoice', 'credit_note', 'payment', 'write_off', 'bill', 'vendor_credit', 'vendor_payment', 'expense',
                         'reimbursement', 'transfer', 'bank', 'depreciation', 'asset_disposal', 'inventory', 'work_order', 'job_work', 'timesheet', 'fx', 'deposit',
                         'payroll', 'payroll_payment', 'tds_challan'));
