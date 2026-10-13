-- HRP Synapse · 0017 delivery & installation tracking, service tickets with SLA policies.

-- order lines: shipped (left the warehouse) is tracked apart from delivered (customer has it)
alter table sales_order_lines add column shipped_qty numeric(14, 3) not null default 0 check (shipped_qty >= 0);
update sales_order_lines set shipped_qty = delivered_qty where delivered_qty > 0;

-- ---------------------------------------------------------------------------------------------
-- Shipments (dispatch → delivery, proof, customer confirmation)
-- ---------------------------------------------------------------------------------------------
create table shipments (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                text not null,
  shipment_number     text,
  status              text not null default 'planned' check (status in ('planned', 'packed', 'dispatched', 'delivered', 'failed', 'cancelled')),
  sales_order_id      uuid,
  account_id          uuid,
  warehouse_id        uuid,
  planned_date        date,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  carrier             text check (length(carrier) <= 120),
  vehicle_no          text check (length(vehicle_no) <= 30),
  driver_name         text check (length(driver_name) <= 120),
  driver_phone        text check (length(driver_phone) <= 30),
  tracking_ref        text check (length(tracking_ref) <= 120),
  delivery_address    text check (length(delivery_address) <= 1000),
  contact_phone       text check (length(contact_phone) <= 30),
  notes               text,
  exception_reason    text,
  received_by         text check (length(received_by) <= 120),
  share_token         text unique,
  confirmed_at        timestamptz,
  confirmed_by        text,
  customer_rating     integer check (customer_rating between 1 and 5),
  customer_feedback   text check (length(customer_feedback) <= 2000),
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
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, warehouse_id) references warehouses (tenant_id, id) on delete set null (warehouse_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index shipments_number on shipments (tenant_id, shipment_number) where shipment_number is not null;
create index shipments_order on shipments (tenant_id, sales_order_id) where deleted_at is null;
create index shipments_planned on shipments (tenant_id, planned_date) where deleted_at is null;
create index shipments_name_trgm on shipments using gin (name gin_trgm_ops);

create table shipment_lines (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  shipment_id     uuid not null,
  order_line_id   uuid not null,
  quantity        numeric(14, 3) not null check (quantity > 0),
  unique (tenant_id, id),
  unique (tenant_id, shipment_id, order_line_id),
  foreign key (tenant_id, shipment_id) references shipments (tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_line_id) references sales_order_lines (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Installations (technician jobs with checklist, exceptions and customer sign-off)
-- ---------------------------------------------------------------------------------------------
create table installations (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                text not null,
  job_number          text,
  status              text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  sales_order_id      uuid,
  shipment_id         uuid,
  account_id          uuid,
  technician_id       uuid,
  crew_ids            uuid[] not null default '{}',
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  site_address        text check (length(site_address) <= 1000),
  contact_phone       text check (length(contact_phone) <= 30),
  -- [{"label": "Level and anchor units", "done": false}]
  checklist           jsonb not null default '[]'::jsonb,
  started_at          timestamptz,
  completed_at        timestamptz,
  completion_notes    text,
  issue_type          text check (issue_type in ('site_not_ready', 'customer_unavailable', 'missing_parts', 'damaged_item', 'measurement_mismatch', 'other')),
  issue_notes         text,
  share_token         text unique,
  confirmed_at        timestamptz,
  confirmed_by        text,
  customer_rating     integer check (customer_rating between 1 and 5),
  customer_feedback   text check (length(customer_feedback) <= 2000),
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
  check (scheduled_end is null or scheduled_start is null or scheduled_end >= scheduled_start),
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, shipment_id) references shipments (tenant_id, id) on delete set null (shipment_id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, technician_id) references users (tenant_id, id) on delete set null (technician_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index installations_number on installations (tenant_id, job_number) where job_number is not null;
create index installations_tech on installations (tenant_id, technician_id, scheduled_start) where deleted_at is null;
create index installations_order on installations (tenant_id, sales_order_id) where deleted_at is null;
create index installations_name_trgm on installations using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- Service: SLA policies + tickets
-- ---------------------------------------------------------------------------------------------
create table sla_policies (
  id                      uuid primary key default app.uuidv7(),
  tenant_id               uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                    text not null check (length(name) between 1 and 120),
  priority                text check (priority in ('low', 'normal', 'high', 'urgent')),
  category                text,
  first_response_minutes  integer not null check (first_response_minutes between 5 and 525600),
  resolution_minutes      integer not null check (resolution_minutes between 15 and 525600),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, id)
);

create table tickets (
  id                    uuid primary key default app.uuidv7(),
  tenant_id             uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                  text not null,
  ticket_number         text,
  status                text not null default 'new' check (status in ('new', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
  priority              text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category              text check (category in ('damage', 'defect', 'installation', 'delivery', 'warranty', 'billing', 'feedback', 'other')),
  channel               text check (channel in ('phone', 'email', 'whatsapp', 'instagram', 'web', 'walk_in', 'internal')),
  description           text check (length(description) <= 10000),
  resolution            text check (length(resolution) <= 10000),
  account_id            uuid,
  contact_id            uuid,
  sales_order_id        uuid,
  product_id            uuid,
  customer_name         text check (length(customer_name) <= 120),
  customer_phone        text check (length(customer_phone) <= 30),
  customer_email        text check (length(customer_email) <= 200),
  sla_policy_id         uuid,
  first_response_due    timestamptz,
  resolution_due        timestamptz,
  first_responded_at    timestamptz,
  resolved_at           timestamptz,
  closed_at             timestamptz,
  sla_breached          boolean not null default false,
  breach_notified_at    timestamptz,
  satisfaction          integer check (satisfaction between 1 and 5),
  satisfaction_comment  text check (length(satisfaction_comment) <= 2000),
  share_token           text unique,
  owner_id              uuid,
  custom                jsonb not null default '{}'::jsonb,
  created_by            uuid default app.current_user_id(),
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  merged_into           uuid,
  version               integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, contact_id) references contacts (tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, sales_order_id) references sales_orders (tenant_id, id) on delete set null (sales_order_id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete set null (product_id),
  foreign key (tenant_id, sla_policy_id) references sla_policies (tenant_id, id) on delete set null (sla_policy_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);
create unique index tickets_number on tickets (tenant_id, ticket_number) where ticket_number is not null;
create index tickets_open on tickets (tenant_id, status, priority) where deleted_at is null;
create index tickets_account on tickets (tenant_id, account_id) where deleted_at is null;
create index tickets_order on tickets (tenant_id, sales_order_id) where deleted_at is null;
create index tickets_sla on tickets (resolution_due) where resolved_at is null and breach_notified_at is null and deleted_at is null;
create index tickets_name_trgm on tickets using gin (name gin_trgm_ops);

-- a human touch on a ticket counts as the first response (SLA)
create or replace function app.touch_last_activity() returns trigger
language plpgsql as $$
begin
  if new.kind in ('stage_change', 'system', 'ai', 'webhook') then
    return new;
  end if;
  if new.related_object = 'lead' then
    update leads set last_activity_at = greatest(coalesce(last_activity_at, new.occurred_at), new.occurred_at)
     where tenant_id = new.tenant_id and id = new.related_id;
  elsif new.related_object = 'deal' then
    update deals set last_activity_at = greatest(coalesce(last_activity_at, new.occurred_at), new.occurred_at)
     where tenant_id = new.tenant_id and id = new.related_id;
  elsif new.related_object = 'ticket' and new.actor_id is not null and coalesce(new.direction, 'out') = 'out' then
    update tickets set first_responded_at = coalesce(first_responded_at, new.occurred_at),
                       status = case when status = 'new' then 'open' else status end
     where tenant_id = new.tenant_id and id = new.related_id;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Customer links (delivery confirmation, installation sign-off, ticket status)
-- ---------------------------------------------------------------------------------------------
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket'));

create or replace function app.sync_public_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  k     text := tg_argv[0];
  r     jsonb;
  route text;
begin
  if tg_op = 'DELETE' then
    delete from public_routes where kind = k and target_id = old.id;
    return old;
  end if;
  r := to_jsonb(new);
  route := case k
    when 'form' then case when r ->> 'kind' = 'public' and (r ->> 'is_active')::boolean then r ->> 'public_key' end
    when 'quote' then case when r ->> 'deleted_at' is null and r ->> 'status' in ('sent', 'accepted', 'rejected') then r ->> 'share_token' end
    when 'shipment' then case when r ->> 'deleted_at' is null and r ->> 'status' in ('dispatched', 'delivered') then r ->> 'share_token' end
    when 'installation' then case when r ->> 'deleted_at' is null and r ->> 'status' in ('scheduled', 'in_progress', 'on_hold', 'completed') then r ->> 'share_token' end
    when 'ticket' then case when r ->> 'deleted_at' is null then r ->> 'share_token' end
    else case when r ->> 'status' = 'active' then r ->> 'inbound_key' end
  end;
  delete from public_routes where kind = k and target_id = new.id;
  if route is not null then
    insert into public_routes (route_key, tenant_id, kind, target_id) values (route, new.tenant_id, k, new.id);
  end if;
  return new;
end
$$;
create trigger shipments_public_route     after insert or update or delete on shipments     for each row execute function app.sync_public_route('shipment');
create trigger installations_public_route after insert or update or delete on installations for each row execute function app.sync_public_route('installation');
create trigger tickets_public_route       after insert or update or delete on tickets       for each row execute function app.sync_public_route('ticket');

-- ---------------------------------------------------------------------------------------------
-- RLS, grants, triggers
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['shipments', 'shipment_lines', 'installations', 'sla_policies', 'tickets'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger shipments_touch     before update on shipments     for each row execute function app.touch_row();
create trigger installations_touch before update on installations for each row execute function app.touch_row();
create trigger sla_policies_touch  before update on sla_policies  for each row execute function app.touch_row();
create trigger tickets_touch       before update on tickets       for each row execute function app.touch_row();

create trigger shipments_rindex     after insert or update or delete on shipments     for each row execute function app.sync_record_index('shipment');
create trigger installations_rindex after insert or update or delete on installations for each row execute function app.sync_record_index('installation');
create trigger tickets_rindex       after insert or update or delete on tickets       for each row execute function app.sync_record_index('ticket');

create trigger shipments_audit     after insert or update or delete on shipments     for each row execute function app.audit_row_change('shipment');
create trigger installations_audit after insert or update or delete on installations for each row execute function app.audit_row_change('installation');
create trigger sla_policies_audit  after insert or update or delete on sla_policies  for each row execute function app.audit_row_change('sla_policy');
create trigger tickets_audit       after insert or update or delete on tickets       for each row execute function app.audit_row_change('ticket');
