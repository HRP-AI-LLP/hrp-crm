-- HRP Synapse · 0016 operations apps: sales orders + payment milestones, inventory (categories,
-- variants, warehouses, stock ledger, reservations, reorder alerts), vendors, purchase orders and
-- goods receipts. Each app is switched on per workspace (tenant_modules key 'app.<name>').

-- ---------------------------------------------------------------------------------------------
-- Customer / vendor tax identity on accounts (GST invoices need the buyer's GSTIN and state)
-- ---------------------------------------------------------------------------------------------
alter table accounts
  add column gstin    text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  add column address  text check (length(address) <= 1000),
  add column city     text check (length(city) <= 120),
  add column state    text check (length(state) <= 120),
  add column pincode  text check (length(pincode) <= 12);

-- ---------------------------------------------------------------------------------------------
-- Product catalogue: categories (tree), variants, inventory tracking
-- ---------------------------------------------------------------------------------------------
create table product_categories (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  parent_id   uuid,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references product_categories (tenant_id, id) on delete cascade
);
create unique index product_categories_name on product_categories (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

alter table products
  add column category_id       uuid,
  add column product_type      text not null default 'goods' check (product_type in ('goods', 'service')),
  add column track_inventory   boolean not null default false,
  add column reorder_level     numeric(14, 3) check (reorder_level >= 0),
  add column reorder_qty       numeric(14, 3) check (reorder_qty >= 0),
  add column reorder_alerted_at timestamptz,
  add column variant_of        uuid,
  add column variant_options   text check (length(variant_options) <= 200),
  add column barcode           text check (length(barcode) <= 64),
  add column cost_price        numeric(18, 2) check (cost_price >= 0),
  add column mrp               numeric(18, 2) check (mrp >= 0),
  add foreign key (tenant_id, category_id) references product_categories (tenant_id, id) on delete set null (category_id),
  add foreign key (tenant_id, variant_of) references products (tenant_id, id) on delete set null (variant_of);
create index products_variant_of on products (tenant_id, variant_of) where variant_of is not null;
create index products_category on products (tenant_id, category_id);

create table warehouses (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  code        text not null check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name        text not null check (length(name) between 1 and 120),
  address     text,
  state       text,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
create unique index warehouses_one_default on warehouses (tenant_id) where is_default;

create table stock_levels (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id    uuid not null,
  warehouse_id  uuid not null,
  on_hand       numeric(14, 3) not null default 0,
  reserved      numeric(14, 3) not null default 0 check (reserved >= 0),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, product_id, warehouse_id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete cascade
);
create index stock_levels_wh on stock_levels (tenant_id, warehouse_id);

-- append-only ledger: every change to on_hand / reserved is one row
create table stock_movements (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  product_id      uuid not null,
  warehouse_id    uuid not null,
  movement_type   text not null check (movement_type in ('in', 'out', 'adjust', 'transfer_in', 'transfer_out', 'reserve', 'release')),
  -- signed change of on_hand / reserved
  qty_delta       numeric(14, 3) not null default 0,
  reserved_delta  numeric(14, 3) not null default 0,
  on_hand_after   numeric(14, 3) not null,
  unit_cost       numeric(18, 2),
  reason          text check (length(reason) <= 300),
  ref_object      text,
  ref_id          uuid,
  ref_label       text,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade,
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete cascade
);
create index stock_movements_product on stock_movements (tenant_id, product_id, created_at desc);
create index stock_movements_ref on stock_movements (tenant_id, ref_object, ref_id);

-- ---------------------------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------------------------
create table sales_orders (
  id                      uuid primary key default app.uuidv7(),
  tenant_id               uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                    text not null,
  order_number            text,
  status                  text not null default 'draft' check (status in ('draft', 'confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed', 'completed', 'cancelled')),
  fulfilment_status       text not null default 'unfulfilled' check (fulfilment_status in ('unfulfilled', 'partially_delivered', 'delivered')),
  payment_status          text not null default 'unpaid' check (payment_status in ('unpaid', 'partially_paid', 'paid')),
  approval_status         text not null default 'not_required' check (approval_status in ('not_required', 'required', 'pending', 'approved', 'rejected')),
  account_id              uuid,
  contact_id              uuid,
  deal_id                 uuid,
  quote_id                uuid,
  warehouse_id            uuid,
  order_date              date not null default current_date,
  expected_delivery_date  date,
  currency                char(3) not null default 'INR',
  subtotal                numeric(18, 2) not null default 0,
  discount_total          numeric(18, 2) not null default 0,
  tax_total               numeric(18, 2) not null default 0,
  grand_total             numeric(18, 2) not null default 0,
  amount_paid             numeric(18, 2) not null default 0,
  balance_due             numeric(18, 2) generated always as (grand_total - amount_paid) stored,
  max_discount_pct        numeric(5, 2) not null default 0,
  delivery_required       boolean not null default true,
  installation_required   boolean not null default false,
  bill_to                 jsonb,
  ship_to                 jsonb,
  site_address            text check (length(site_address) <= 1000),
  terms                   text,
  notes                   text,
  confirmed_at            timestamptz,
  cancelled_at            timestamptz,
  cancel_reason           text,
  owner_id                uuid,
  custom                  jsonb not null default '{}'::jsonb,
  created_by              uuid default app.current_user_id(),
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  merged_into             uuid,
  version                 integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, contact_id) references contacts (tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, deal_id) references deals (tenant_id, id) on delete set null (deal_id),
  foreign key (tenant_id, quote_id) references quotes (tenant_id, id) on delete set null (quote_id),
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete set null (warehouse_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index sales_orders_number on sales_orders (tenant_id, order_number) where order_number is not null;
create unique index sales_orders_quote on sales_orders (tenant_id, quote_id) where quote_id is not null and deleted_at is null and status <> 'cancelled';
create index sales_orders_account on sales_orders (tenant_id, account_id) where deleted_at is null;
create index sales_orders_name_trgm on sales_orders using gin (name gin_trgm_ops);

create table sales_order_lines (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  order_id       uuid not null,
  position       integer not null default 0,
  product_id     uuid,
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
  reserved_qty   numeric(14, 3) not null default 0 check (reserved_qty >= 0),
  delivered_qty  numeric(14, 3) not null default 0 check (delivered_qty >= 0),
  invoiced_qty   numeric(14, 3) not null default 0 check (invoiced_qty >= 0),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references sales_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);
create index sales_order_lines_order on sales_order_lines (tenant_id, order_id, position);

-- payment milestones ("50% advance, 40% before dispatch, 10% after installation")
create table order_milestones (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  order_id     uuid not null,
  position     integer not null default 0,
  name         text not null check (length(name) between 1 and 120),
  percent      numeric(5, 2) check (percent > 0 and percent <= 100),
  amount       numeric(18, 2) not null check (amount >= 0),
  trigger      text not null default 'on_date' check (trigger in ('on_confirmation', 'before_dispatch', 'on_delivery', 'on_installation', 'on_date')),
  due_date     date,
  status       text not null default 'pending' check (status in ('pending', 'due', 'paid', 'waived')),
  amount_paid  numeric(18, 2) not null default 0,
  paid_at      timestamptz,
  invoice_id   uuid,
  notes        text,
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references sales_orders (tenant_id, id) on delete cascade
);
create index order_milestones_order on order_milestones (tenant_id, order_id, position);

-- ---------------------------------------------------------------------------------------------
-- Vendors, purchase orders, goods receipts
-- ---------------------------------------------------------------------------------------------
create table vendors (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                text not null,
  vendor_code         text,
  vendor_type         text check (vendor_type in ('manufacturer', 'supplier', 'contractor', 'transporter', 'installer', 'service_provider', 'other')),
  category            text,
  status              text not null default 'active' check (status in ('active', 'on_hold', 'blocked')),
  contact_person      text,
  email               text,
  phone               text,
  gstin               text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan                 text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  address             text,
  city                text,
  state               text,
  payment_terms_days  integer check (payment_terms_days between 0 and 365),
  lead_time_days      integer check (lead_time_days between 0 and 365),
  notes               text,
  owner_id            uuid,
  custom              jsonb not null default '{}'::jsonb,
  created_by          uuid default app.current_user_id(),
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  merged_into         uuid,
  version             integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index vendors_code on vendors (tenant_id, lower(vendor_code)) where vendor_code is not null and deleted_at is null;
create index vendors_name_trgm on vendors using gin (name gin_trgm_ops);

create table purchase_orders (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name             text not null,
  po_number        text,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
  approval_status  text not null default 'not_required' check (approval_status in ('not_required', 'required', 'pending', 'approved', 'rejected')),
  vendor_id        uuid,
  sales_order_id   uuid,
  warehouse_id     uuid,
  order_date       date not null default current_date,
  expected_date    date,
  currency         char(3) not null default 'INR',
  subtotal         numeric(18, 2) not null default 0,
  discount_total   numeric(18, 2) not null default 0,
  tax_total        numeric(18, 2) not null default 0,
  grand_total      numeric(18, 2) not null default 0,
  max_discount_pct numeric(5, 2) not null default 0,
  terms            text,
  notes            text,
  sent_at          timestamptz,
  received_at      timestamptz,
  owner_id         uuid,
  custom           jsonb not null default '{}'::jsonb,
  created_by       uuid default app.current_user_id(),
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  merged_into      uuid,
  version          integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, vendor_id) references vendors (tenant_id, id) on delete set null (vendor_id),
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete set null (warehouse_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index purchase_orders_number on purchase_orders (tenant_id, po_number) where po_number is not null;
create index purchase_orders_vendor on purchase_orders (tenant_id, vendor_id) where deleted_at is null;
create index purchase_orders_name_trgm on purchase_orders using gin (name gin_trgm_ops);

create table purchase_order_lines (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  order_id       uuid not null,
  position       integer not null default 0,
  product_id     uuid,
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
  received_qty   numeric(14, 3) not null default 0 check (received_qty >= 0),
  rejected_qty   numeric(14, 3) not null default 0 check (rejected_qty >= 0),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references purchase_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);
create index purchase_order_lines_order on purchase_order_lines (tenant_id, order_id, position);

create table goods_receipts (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  receipt_number  text not null,
  po_id           uuid not null,
  warehouse_id    uuid not null,
  received_on     date not null default current_date,
  vendor_invoice  text check (length(vendor_invoice) <= 60),
  notes           text,
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, receipt_number),
  foreign key (tenant_id, po_id) references purchase_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id)
);
create index goods_receipts_po on goods_receipts (tenant_id, po_id);

create table goods_receipt_lines (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  receipt_id        uuid not null,
  po_line_id        uuid not null,
  product_id        uuid,
  qty_received      numeric(14, 3) not null check (qty_received >= 0),
  qty_rejected      numeric(14, 3) not null default 0 check (qty_rejected >= 0),
  rejection_reason  text,
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references goods_receipts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, po_line_id) references purchase_order_lines (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id)
);

-- ---------------------------------------------------------------------------------------------
-- RLS, grants, triggers
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['product_categories', 'warehouses', 'stock_levels', 'stock_movements', 'sales_orders', 'sales_order_lines',
                           'order_milestones', 'vendors', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
-- the ledger is append-only for the application
revoke update, delete on stock_movements from synapse_app;

create trigger warehouses_touch      before update on warehouses      for each row execute function app.touch_row();
create trigger sales_orders_touch    before update on sales_orders    for each row execute function app.touch_row();
create trigger vendors_touch         before update on vendors         for each row execute function app.touch_row();
create trigger purchase_orders_touch before update on purchase_orders for each row execute function app.touch_row();

create trigger sales_orders_rindex    after insert or update or delete on sales_orders    for each row execute function app.sync_record_index('sales_order');
create trigger vendors_rindex         after insert or update or delete on vendors         for each row execute function app.sync_record_index('vendor');
create trigger purchase_orders_rindex after insert or update or delete on purchase_orders for each row execute function app.sync_record_index('purchase_order');

create trigger sales_orders_audit       after insert or update or delete on sales_orders       for each row execute function app.audit_row_change('sales_order');
create trigger order_milestones_audit   after insert or update or delete on order_milestones   for each row execute function app.audit_row_change('order_milestone');
create trigger vendors_audit            after insert or update or delete on vendors            for each row execute function app.audit_row_change('vendor');
create trigger purchase_orders_audit    after insert or update or delete on purchase_orders    for each row execute function app.audit_row_change('purchase_order');
create trigger goods_receipts_audit     after insert or update or delete on goods_receipts     for each row execute function app.audit_row_change('goods_receipt');
create trigger warehouses_audit         after insert or update or delete on warehouses         for each row execute function app.audit_row_change('warehouse');
create trigger product_categories_audit after insert or update or delete on product_categories for each row execute function app.audit_row_change('product_category');

-- categories feed the product category picklist (cached metadata)
create trigger product_categories_meta after insert or update or delete on product_categories for each statement execute function app.bump_meta_version();
create trigger warehouses_meta         after insert or update or delete on warehouses         for each statement execute function app.bump_meta_version();
