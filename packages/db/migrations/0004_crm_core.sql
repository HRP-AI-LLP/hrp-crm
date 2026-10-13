-- HRP Synapse · 0004 CRM core: accounts, contacts, leads, deals, custom-object records,
-- custom-field index, tasks and the activity timeline.
--
-- Every cross-record reference is a composite FK (tenant_id, x_id) so the database itself
-- rejects a reference to another tenant's row, independent of RLS.

create table accounts (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name            text not null,
  domain          text,
  industry        text,
  phone           text,
  website         text,
  annual_revenue  numeric(18, 2),
  employees       integer,
  billing_address jsonb,
  owner_id        uuid,
  custom          jsonb not null default '{}'::jsonb,
  created_by      uuid default app.current_user_id(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  version         integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

create table contacts (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  account_id  uuid,
  first_name  text,
  last_name   text not null,
  full_name   text generated always as (btrim(coalesce(first_name, '') || ' ' || last_name)) stored,
  email       text,
  phone       text,
  title       text,
  -- consent ledger for DPDP/GDPR: {"email":{"granted":true,"at":"...","source":"web_form"}}
  consent     jsonb not null default '{}'::jsonb,
  owner_id    uuid,
  custom      jsonb not null default '{}'::jsonb,
  created_by  uuid default app.current_user_id(),
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  version     integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

create table deals (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null,
  account_id   uuid,
  contact_id   uuid,
  pipeline_id  uuid not null,
  stage_id     uuid not null,
  amount       numeric(18, 2),
  currency     char(3) not null default 'INR',
  close_date   date,
  probability  integer check (probability between 0 and 100),
  closed_at    timestamptz,
  owner_id     uuid,
  custom       jsonb not null default '{}'::jsonb,
  ai_insights  jsonb,
  created_by   uuid default app.current_user_id(),
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  version      integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id) on delete set null (account_id),
  foreign key (tenant_id, contact_id) references contacts (tenant_id, id) on delete set null (contact_id),
  -- the stage must belong to the deal's pipeline *and* tenant
  foreign key (tenant_id, pipeline_id, stage_id) references pipeline_stages (tenant_id, pipeline_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

create table leads (
  id                    uuid primary key default app.uuidv7(),
  tenant_id             uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  first_name            text,
  last_name             text not null,
  full_name             text generated always as (btrim(coalesce(first_name, '') || ' ' || last_name)) stored,
  company               text,
  email                 text,
  phone                 text,
  source                text,
  pipeline_id           uuid,
  stage_id              uuid,
  ai_score              integer check (ai_score between 0 and 100),
  ai_score_reasons      jsonb,
  ai_scored_at          timestamptz,
  sentiment             text check (sentiment in ('positive', 'neutral', 'negative', 'mixed')),
  consent               jsonb not null default '{}'::jsonb,
  converted_at          timestamptz,
  converted_contact_id  uuid,
  converted_account_id  uuid,
  converted_deal_id     uuid,
  owner_id              uuid,
  custom                jsonb not null default '{}'::jsonb,
  created_by            uuid default app.current_user_id(),
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  version               integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, pipeline_id, stage_id) references pipeline_stages (tenant_id, pipeline_id, id),
  foreign key (tenant_id, converted_contact_id) references contacts (tenant_id, id) on delete set null (converted_contact_id),
  foreign key (tenant_id, converted_account_id) references accounts (tenant_id, id) on delete set null (converted_account_id),
  foreign key (tenant_id, converted_deal_id) references deals (tenant_id, id) on delete set null (converted_deal_id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

-- Instances of tenant-defined custom objects (property, patient, policy, ...)
create table records (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id(),
  object_key  text not null,
  name        text not null,
  pipeline_id uuid,
  stage_id    uuid,
  owner_id    uuid,
  custom      jsonb not null default '{}'::jsonb,
  created_by  uuid default app.current_user_id(),
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  version     integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, pipeline_id, stage_id) references pipeline_stages (tenant_id, pipeline_id, id),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete set null (owner_id)
);

-- Typed EAV mirror of indexed custom fields (maintained by trigger, never written by the API)
create table record_index (
  tenant_id   uuid not null,
  object_key  text not null,
  field_key   text not null,
  record_id   uuid not null,
  v_text      text,
  v_num       numeric,
  v_date      timestamptz,
  v_bool      boolean,
  primary key (tenant_id, object_key, field_key, record_id)
);
create index record_index_text on record_index (tenant_id, object_key, field_key, v_text) where v_text is not null;
create index record_index_num  on record_index (tenant_id, object_key, field_key, v_num)  where v_num is not null;
create index record_index_date on record_index (tenant_id, object_key, field_key, v_date) where v_date is not null;
create index record_index_rec  on record_index (tenant_id, record_id);

create table tasks (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  title           text not null,
  description     text,
  status          text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at          timestamptz,
  remind_at       timestamptz,
  completed_at    timestamptz,
  assignee_id     uuid,
  related_object  text,
  related_id      uuid,
  source          text not null default 'manual',
  created_by      uuid default app.current_user_id(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, assignee_id) references users (tenant_id, id) on delete set null (assignee_id)
);

create table activities (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  kind            text not null check (kind in ('note', 'call', 'email', 'meeting', 'whatsapp', 'sms',
                                                'stage_change', 'system', 'ai', 'webhook')),
  subject         text,
  body            text,
  direction       text check (direction in ('in', 'out')),
  related_object  text not null,
  related_id      uuid not null,
  actor_id        uuid default app.current_user_id(),
  sentiment       text,
  metadata        jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Indexes (every index leads with tenant_id: pooled tables are always filtered by tenant first)
create index accounts_list  on accounts (tenant_id, updated_at desc) where deleted_at is null;
create index accounts_owner on accounts (tenant_id, owner_id) where deleted_at is null;
create index accounts_name_trgm on accounts using gin (name gin_trgm_ops);
create index contacts_list  on contacts (tenant_id, updated_at desc) where deleted_at is null;
create index contacts_owner on contacts (tenant_id, owner_id) where deleted_at is null;
create index contacts_account on contacts (tenant_id, account_id);
create index contacts_email on contacts (tenant_id, lower(email));
create index contacts_name_trgm on contacts using gin (full_name gin_trgm_ops);
create index leads_list     on leads (tenant_id, updated_at desc) where deleted_at is null;
create index leads_owner    on leads (tenant_id, owner_id) where deleted_at is null;
create index leads_stage    on leads (tenant_id, stage_id) where deleted_at is null;
create index leads_email    on leads (tenant_id, lower(email));
create index leads_name_trgm on leads using gin (full_name gin_trgm_ops);
create index deals_list     on deals (tenant_id, updated_at desc) where deleted_at is null;
create index deals_owner    on deals (tenant_id, owner_id) where deleted_at is null;
create index deals_stage    on deals (tenant_id, pipeline_id, stage_id) where deleted_at is null;
create index deals_name_trgm on deals using gin (name gin_trgm_ops);
create index records_list   on records (tenant_id, object_key, updated_at desc) where deleted_at is null;
create index records_owner  on records (tenant_id, object_key, owner_id) where deleted_at is null;
create index records_name_trgm on records using gin (name gin_trgm_ops);
create index tasks_assignee on tasks (tenant_id, assignee_id, status, due_at);
create index tasks_related  on tasks (tenant_id, related_object, related_id);
create index activities_related on activities (tenant_id, related_object, related_id, occurred_at desc);

-- Housekeeping triggers
create trigger accounts_touch before update on accounts for each row execute function app.touch_row();
create trigger contacts_touch before update on contacts for each row execute function app.touch_row();
create trigger deals_touch    before update on deals    for each row execute function app.touch_row();
create trigger leads_touch    before update on leads    for each row execute function app.touch_row();
create trigger records_touch  before update on records  for each row execute function app.touch_row();
create trigger tasks_touch    before update on tasks    for each row execute function app.touch_row();

-- Custom-field index maintenance -------------------------------------------------------------
create or replace function app.sync_record_index() returns trigger
language plpgsql as $$
declare
  obj text;
begin
  if tg_op = 'DELETE' then
    delete from record_index where tenant_id = old.tenant_id and record_id = old.id;
    return old;
  end if;

  obj := coalesce(tg_argv[0], to_jsonb(new) ->> 'object_key');

  if tg_op = 'UPDATE' and new.custom is not distinct from old.custom then
    return new;
  end if;

  delete from record_index where tenant_id = new.tenant_id and object_key = obj and record_id = new.id;

  insert into record_index (tenant_id, object_key, field_key, record_id, v_text, v_num, v_date, v_bool)
  select new.tenant_id, obj, cf.key, new.id,
         case when cf.field_type in ('text', 'textarea', 'email', 'phone', 'url', 'picklist', 'lookup', 'user')
              then left(lower(new.custom ->> cf.key), 256) end,
         case when cf.field_type in ('number', 'currency', 'percent')
              then app.try_numeric(new.custom ->> cf.key) end,
         case when cf.field_type in ('date', 'datetime')
              then app.try_timestamptz(new.custom ->> cf.key) end,
         case when cf.field_type = 'boolean'
              then app.try_boolean(new.custom ->> cf.key) end
    from custom_fields cf
   where cf.tenant_id = new.tenant_id
     and cf.object_key = obj
     and cf.is_indexed
     and cf.field_type <> 'multipicklist'
     and new.custom ? cf.key
     and jsonb_typeof(new.custom -> cf.key) <> 'null';

  return new;
end
$$;

create trigger accounts_rindex after insert or update or delete on accounts for each row execute function app.sync_record_index('account');
create trigger contacts_rindex after insert or update or delete on contacts for each row execute function app.sync_record_index('contact');
create trigger leads_rindex    after insert or update or delete on leads    for each row execute function app.sync_record_index('lead');
create trigger deals_rindex    after insert or update or delete on deals    for each row execute function app.sync_record_index('deal');
create trigger records_rindex  after insert or update or delete on records  for each row execute function app.sync_record_index();
