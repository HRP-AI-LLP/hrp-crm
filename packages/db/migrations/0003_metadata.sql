-- HRP Synapse · 0003 metadata engine (custom objects, custom fields, pipelines, forms, modules)
--
-- Storage model ("JSONB + EAV index hybrid"):
--   * Every record keeps its custom field values in a `custom jsonb` column (one read, no joins).
--   * Fields flagged is_indexed are mirrored into `record_index` (typed EAV rows) by trigger, so
--     custom-field filters/sorts hit B-tree indexes without per-tenant DDL on pooled tables.
--   * Standard objects (lead/contact/account/deal) are also rows in custom_objects
--     (is_standard = true) so fields, layouts and permissions treat every object uniformly.

create table custom_objects (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  key           text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label         text not null,
  plural_label  text not null,
  icon          text,
  description   text,
  is_standard   boolean not null default false,
  module_key    text,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table custom_fields (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id(),
  object_key  text not null,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label       text not null,
  field_type  text not null check (field_type in (
                'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean',
                'picklist', 'multipicklist', 'email', 'phone', 'url', 'lookup', 'user')),
  is_required boolean not null default false,
  is_indexed  boolean not null default false,
  -- PII flag drives masking, export controls and AI-provider routing (DPDP / GDPR)
  is_pii      boolean not null default false,
  -- {choices:[{value,label,color}], lookupObject, precision, min, max, maxLength, default}
  options     jsonb not null default '{}'::jsonb,
  help_text   text,
  position    integer not null default 0,
  module_key  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, object_key, key),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key)
    on update cascade on delete cascade
);

create table pipelines (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id(),
  object_key  text not null,
  name        text not null,
  is_default  boolean not null default false,
  position    integer not null default 0,
  module_key  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key)
    on update cascade on delete cascade
);
create unique index pipelines_one_default on pipelines (tenant_id, object_key) where is_default;

create table pipeline_stages (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id(),
  pipeline_id  uuid not null,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label        text not null,
  position     integer not null default 0,
  probability  integer not null default 0 check (probability between 0 and 100),
  category     text not null default 'open' check (category in ('open', 'won', 'lost')),
  color        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, pipeline_id, id),
  unique (pipeline_id, key),
  foreign key (tenant_id, pipeline_id) references pipelines (tenant_id, id) on delete cascade
);

-- Installed domain modules (Real Estate, Healthcare, E-Commerce, Financial Services, ...)
create table tenant_modules (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  module_key    text not null,
  version       text not null,
  is_enabled    boolean not null default true,
  settings      jsonb not null default '{}'::jsonb,
  installed_at  timestamptz not null default now(),
  primary key (tenant_id, module_key)
);

-- Dynamic form builder (internal layouts + public web-to-lead forms)
create table forms (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  name        text not null,
  kind        text not null default 'layout' check (kind in ('layout', 'public')),
  -- {sections:[{title, columns, fields:[fieldKey...]}]}
  layout      jsonb not null default '{"sections":[]}'::jsonb,
  public_key  text unique,
  settings    jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key)
    on update cascade on delete cascade
);

create trigger custom_objects_touch  before update on custom_objects  for each row execute function app.touch_row();
create trigger custom_fields_touch   before update on custom_fields   for each row execute function app.touch_row();
create trigger pipelines_touch       before update on pipelines       for each row execute function app.touch_row();
create trigger pipeline_stages_touch before update on pipeline_stages for each row execute function app.touch_row();
create trigger forms_touch           before update on forms           for each row execute function app.touch_row();
