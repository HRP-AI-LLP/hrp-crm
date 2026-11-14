-- HRP Synapse · 0031 Manufacturing: discrete, make-to-order, process / batch, job work and MRP
--
-- products gain           make / buy, preferred vendor, lead time, safety stock, batch tracking, shelf life
-- work_centers            machines / lines / teams with capacity and an hourly cost (labour + overhead)
-- boms / bom_lines / bom_operations   multi-level bills of materials with routing, scrap %, by-products
-- work_orders             production orders (record): plan → release → issue → operations → produce → close
-- work_order_materials    what the order needs and what was issued / returned
-- work_order_operations   the routing on this order: planned and actual minutes, operator, status
-- production_logs         every issue, return, operation, output, by-product and scrap (with its value)
-- stock_lots / lot_links  batches with mfg and expiry dates; which lots went into which lot (traceability)
-- quality_checks          incoming, in-process and final inspections with parameters
-- job_works / job_work_lines / job_work_logs   job work (subcontracting) under GST challans, ITC-04
-- mrp_runs / mrp_lines    material requirements planning: shortages and buy / make suggestions

alter table products
  add column make_or_buy         text not null default 'buy' check (make_or_buy in ('buy', 'make', 'both')),
  add column preferred_vendor_id uuid,
  add column lead_time_days      integer check (lead_time_days between 0 and 365),
  add column safety_stock        numeric(14, 3) check (safety_stock >= 0),
  add column min_order_qty       numeric(14, 3) check (min_order_qty >= 0),
  add column batch_tracked       boolean not null default false,
  add column shelf_life_days     integer check (shelf_life_days between 1 and 36500),
  add constraint products_preferred_vendor foreign key (tenant_id, preferred_vendor_id) references vendors (tenant_id, id) on delete set null (preferred_vendor_id);

create table work_centers (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  code            text not null check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name            text not null check (length(name) between 1 and 120),
  hours_per_day   numeric(5, 2) not null default 8 check (hours_per_day between 0 and 24),
  days_per_week   integer not null default 6 check (days_per_week between 1 and 7),
  parallel_units  integer not null default 1 check (parallel_units between 1 and 1000),
  cost_per_hour   numeric(18, 2) not null default 0 check (cost_per_hour >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table boms (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id      uuid not null,
  name            text not null check (length(name) between 1 and 150),
  revision        integer not null default 1,
  kind            text not null default 'manufacture' check (kind in ('manufacture', 'process', 'kit')),
  quantity        numeric(14, 3) not null default 1 check (quantity > 0),
  yield_pct       numeric(5, 2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),
  status          text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  is_default      boolean not null default false,
  requires_qc     boolean not null default false,
  notes           text check (length(notes) <= 5000),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, product_id, revision),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);
create unique index boms_default on boms (tenant_id, product_id) where is_default and status = 'active';

create table bom_operations (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bom_id          uuid not null,
  seq             integer not null check (seq between 1 and 9999),
  name            text not null check (length(name) between 1 and 120),
  work_center_id  uuid,
  setup_minutes   numeric(10, 2) not null default 0 check (setup_minutes >= 0),
  run_minutes     numeric(10, 3) not null default 0 check (run_minutes >= 0),
  subcontract     boolean not null default false,
  instructions    text check (length(instructions) <= 5000),
  unique (tenant_id, id),
  unique (tenant_id, bom_id, seq),
  foreign key (tenant_id, bom_id) references boms (tenant_id, id) on delete cascade,
  foreign key (tenant_id, work_center_id) references work_centers (tenant_id, id) on delete restrict
);

create table bom_lines (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  bom_id          uuid not null,
  line_kind       text not null default 'component' check (line_kind in ('component', 'byproduct')),
  product_id      uuid not null,
  quantity        numeric(14, 4) not null check (quantity > 0),
  scrap_pct       numeric(5, 2) not null default 0 check (scrap_pct >= 0 and scrap_pct < 100),
  -- by-products take this share of the order's cost
  cost_share_pct  numeric(5, 2) not null default 0 check (cost_share_pct >= 0 and cost_share_pct < 100),
  operation_seq   integer,
  position        integer not null default 0,
  unique (tenant_id, id),
  foreign key (tenant_id, bom_id) references boms (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict
);
create index bom_lines_bom on bom_lines (tenant_id, bom_id, position);
create index bom_lines_product on bom_lines (tenant_id, product_id);

create table work_orders (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name            text not null,
  wo_number       text,
  status          text not null default 'draft' check (status in ('draft', 'released', 'in_progress', 'completed', 'closed', 'cancelled')),
  product_id      uuid,
  bom_id          uuid,
  quantity        numeric(14, 3) not null default 1 check (quantity > 0),
  produced_qty    numeric(14, 3) not null default 0 check (produced_qty >= 0),
  scrapped_qty    numeric(14, 3) not null default 0 check (scrapped_qty >= 0),
  warehouse_id    uuid,
  planned_start   date,
  planned_end     date,
  actual_start    timestamptz,
  actual_end      timestamptz,
  sales_order_id  uuid,
  project_id      uuid,
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  lot_number      text check (length(lot_number) <= 60),
  material_cost   numeric(18, 2) not null default 0,
  operation_cost  numeric(18, 2) not null default 0,
  relieved_cost   numeric(18, 2) not null default 0,
  variance        numeric(18, 2) not null default 0,
  notes           text,
  owner_id        uuid,
  custom          jsonb not null default '{}'::jsonb,
  created_by      uuid default app.current_user_id(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  merged_into     uuid,
  version         integer not null default 1,
  unique (tenant_id, id),
  check (planned_end is null or planned_start is null or planned_end >= planned_start),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict,
  foreign key (tenant_id, bom_id) references boms (tenant_id, id) on delete restrict,
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete restrict,
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete set null (project_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create index work_orders_status on work_orders (tenant_id, status) where deleted_at is null;
create index work_orders_product on work_orders (tenant_id, product_id) where deleted_at is null;

create table work_order_materials (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  work_order_id   uuid not null,
  product_id      uuid not null,
  required_qty    numeric(14, 3) not null check (required_qty >= 0),
  issued_qty      numeric(14, 3) not null default 0,
  issued_value    numeric(18, 2) not null default 0,
  operation_seq   integer,
  position        integer not null default 0,
  unique (tenant_id, id),
  unique (tenant_id, work_order_id, product_id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict
);

create table work_order_operations (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  work_order_id   uuid not null,
  seq             integer not null,
  name            text not null,
  work_center_id  uuid,
  planned_minutes numeric(12, 2) not null default 0,
  actual_minutes  numeric(12, 2) not null default 0 check (actual_minutes >= 0),
  cost_per_hour   numeric(18, 2) not null default 0,
  absorbed_cost   numeric(18, 2) not null default 0,
  qty_done        numeric(14, 3) not null default 0,
  status          text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'subcontracted')),
  operator_id     uuid,
  started_at      timestamptz,
  completed_at    timestamptz,
  subcontract     boolean not null default false,
  unique (tenant_id, id),
  unique (tenant_id, work_order_id, seq),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, work_center_id) references work_centers (tenant_id, id) on delete set null (work_center_id),
  foreign key (tenant_id, operator_id) references users (tenant_id, id) on delete set null (operator_id)
);

create table stock_lots (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id      uuid not null,
  warehouse_id    uuid not null,
  lot_number      text not null check (length(lot_number) between 1 and 60),
  mfg_date        date,
  expiry_date     date,
  on_hand         numeric(14, 3) not null default 0 check (on_hand >= 0),
  status          text not null default 'available' check (status in ('available', 'quarantine', 'rejected')),
  source          text check (source in ('production', 'receipt', 'job_work', 'opening', 'adjustment')),
  source_id       uuid,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, product_id, warehouse_id, lot_number),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete cascade
);
create index stock_lots_fefo on stock_lots (tenant_id, product_id, warehouse_id, expiry_date nulls last) where on_hand > 0;

create table production_logs (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  work_order_id   uuid not null,
  kind            text not null check (kind in ('issue', 'return', 'operation', 'produce', 'byproduct', 'scrap', 'close')),
  product_id      uuid,
  quantity        numeric(14, 3) not null default 0,
  value           numeric(18, 2) not null default 0,
  lot_id          uuid,
  operation_id    uuid,
  minutes         numeric(12, 2),
  note            text check (length(note) <= 500),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id),
  foreign key (tenant_id, lot_id) references stock_lots (tenant_id, id) on delete set null (lot_id)
);
create index production_logs_wo on production_logs (tenant_id, work_order_id, created_at);

-- genealogy: which consumed lots went into which produced lot
create table lot_links (
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  parent_lot_id   uuid not null,
  child_lot_id    uuid not null,
  work_order_id   uuid,
  quantity        numeric(14, 3) not null default 0,
  primary key (tenant_id, parent_lot_id, child_lot_id),
  foreign key (tenant_id, parent_lot_id) references stock_lots (tenant_id, id) on delete cascade,
  foreign key (tenant_id, child_lot_id) references stock_lots (tenant_id, id) on delete cascade
);
create index lot_links_child on lot_links (tenant_id, child_lot_id);

create table quality_checks (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  qc_number       integer not null,
  stage           text not null check (stage in ('incoming', 'in_process', 'final')),
  product_id      uuid not null,
  work_order_id   uuid,
  purchase_order_id uuid,
  lot_id          uuid,
  qty_inspected   numeric(14, 3) not null check (qty_inspected > 0),
  qty_rejected    numeric(14, 3) not null default 0 check (qty_rejected >= 0),
  result          text not null check (result in ('pass', 'fail', 'hold')),
  parameters      jsonb not null default '[]'::jsonb check (jsonb_typeof(parameters) = 'array' and jsonb_array_length(parameters) <= 50),
  notes           text check (length(notes) <= 2000),
  inspector_id    uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, qc_number),
  check (qty_rejected <= qty_inspected),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id) on delete set null (purchase_order_id),
  foreign key (tenant_id, lot_id) references stock_lots (tenant_id, id) on delete set null (lot_id)
);
create index quality_checks_wo on quality_checks (tenant_id, work_order_id);

-- job work: goods sent to a job worker under a delivery challan (GST rule 45 / 55), processed goods received back
create table job_works (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name            text not null,
  jw_number       text,
  challan_number  text,
  status          text not null default 'draft' check (status in ('draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
  vendor_id       uuid,
  work_order_id   uuid,
  operation_seq   integer,
  warehouse_id    uuid,
  process         text check (length(process) <= 300),
  output_product_id uuid,
  output_qty      numeric(14, 3) check (output_qty > 0),
  received_qty    numeric(14, 3) not null default 0,
  rate            numeric(18, 2) not null default 0 check (rate >= 0),
  sent_date       date,
  expected_date   date,
  material_value  numeric(18, 2) not null default 0,
  vehicle_number  text check (length(vehicle_number) <= 20),
  notes           text,
  owner_id        uuid,
  custom          jsonb not null default '{}'::jsonb,
  created_by      uuid default app.current_user_id(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  merged_into     uuid,
  version         integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id) on delete restrict,
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete set null (work_order_id),
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete restrict,
  foreign key (tenant_id, output_product_id) references products (tenant_id, id) on delete restrict,
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index job_works_challan on job_works (tenant_id, challan_number) where challan_number is not null;

create table job_work_lines (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  job_work_id     uuid not null,
  product_id      uuid not null,
  quantity        numeric(14, 3) not null check (quantity > 0),
  sent_qty        numeric(14, 3) not null default 0,
  returned_qty    numeric(14, 3) not null default 0,
  consumed_qty    numeric(14, 3) not null default 0,
  unit_cost       numeric(18, 4) not null default 0,
  position        integer not null default 0,
  unique (tenant_id, id),
  unique (tenant_id, job_work_id, product_id),
  foreign key (tenant_id, job_work_id) references job_works (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict
);

create table job_work_logs (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  job_work_id     uuid not null,
  kind            text not null check (kind in ('send', 'receive', 'return', 'close')),
  log_date        date not null default current_date,
  output_qty      numeric(14, 3) not null default 0,
  value           numeric(18, 2) not null default 0,
  details         jsonb not null default '[]'::jsonb,
  challan_ref     text check (length(challan_ref) <= 60),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, job_work_id) references job_works (tenant_id, id) on delete cascade
);

create table mrp_runs (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  horizon_days    integer not null check (horizon_days between 1 and 365),
  include_reorder boolean not null default true,
  lines           integer not null default 0,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id)
);

create table mrp_lines (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  run_id          uuid not null,
  product_id      uuid not null,
  level           integer not null default 0,
  gross_req       numeric(14, 3) not null default 0,
  on_hand         numeric(14, 3) not null default 0,
  on_order        numeric(14, 3) not null default 0,
  safety_stock    numeric(14, 3) not null default 0,
  net_req         numeric(14, 3) not null default 0,
  suggested_qty   numeric(14, 3) not null default 0,
  action          text not null check (action in ('buy', 'make', 'none')),
  need_by         date,
  order_by        date,
  vendor_id       uuid,
  bom_id          uuid,
  sources         jsonb not null default '[]'::jsonb,
  status          text not null default 'open' check (status in ('open', 'done', 'ignored')),
  ref_object      text,
  ref_id          uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, run_id) references mrp_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);
create index mrp_lines_run on mrp_lines (tenant_id, run_id, level);

-- ------------------------------------------------------------------------------------- RLS, grants, triggers
do $$
declare t text;
begin
  foreach t in array array['work_centers', 'boms', 'bom_operations', 'bom_lines', 'work_orders', 'work_order_materials', 'work_order_operations', 'stock_lots',
                           'production_logs', 'lot_links', 'quality_checks', 'job_works', 'job_work_lines', 'job_work_logs', 'mrp_runs', 'mrp_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
-- production history is append-only for the application
revoke update, delete on production_logs, job_work_logs from synapse_app;

create trigger boms_touch        before update on boms        for each row execute function app.touch_row();
create trigger work_orders_touch before update on work_orders for each row execute function app.touch_row();
create trigger job_works_touch   before update on job_works   for each row execute function app.touch_row();
create trigger work_orders_rindex after insert or update or delete on work_orders for each row execute function app.sync_record_index('work_order');
create trigger job_works_rindex   after insert or update or delete on job_works   for each row execute function app.sync_record_index('job_work');
create trigger work_orders_audit after insert or update or delete on work_orders for each row execute function app.audit_row_change('work_order');
create trigger job_works_audit   after insert or update or delete on job_works   for each row execute function app.audit_row_change('job_work');
create trigger boms_audit        after insert or update or delete on boms        for each row execute function app.audit_row_change('bom');
create trigger quality_audit     after insert or update or delete on quality_checks for each row execute function app.audit_row_change('quality_check');
