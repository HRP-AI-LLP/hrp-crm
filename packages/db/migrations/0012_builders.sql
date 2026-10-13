-- HRP Synapse · 0012 visual builders: formula + roll-up fields, validation rules

-- 1. computed field types --------------------------------------------------------------------
alter table custom_fields drop constraint custom_fields_field_type_check;
alter table custom_fields add constraint custom_fields_field_type_check check (field_type in (
  'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean',
  'picklist', 'multipicklist', 'email', 'phone', 'url', 'lookup', 'user', 'formula', 'rollup'));

-- the storage type of a field: computed fields are indexed like their declared result type
create or replace function app.field_value_type(p_type text, p_options jsonb) returns text
language sql immutable as $$
  select case when p_type in ('formula', 'rollup') then coalesce(p_options ->> 'returnType', 'number') else p_type end
$$;

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
         case when t.vt in ('text', 'textarea', 'email', 'phone', 'url', 'picklist', 'lookup', 'user')
              then left(lower(new.custom ->> cf.key), 256) end,
         case when t.vt in ('number', 'currency', 'percent')
              then app.try_numeric(new.custom ->> cf.key) end,
         case when t.vt in ('date', 'datetime')
              then app.try_timestamptz(new.custom ->> cf.key) end,
         case when t.vt = 'boolean'
              then app.try_boolean(new.custom ->> cf.key) end
    from custom_fields cf
    cross join lateral (select app.field_value_type(cf.field_type, cf.options) as vt) t
   where cf.tenant_id = new.tenant_id
     and cf.object_key = obj
     and cf.is_indexed
     and t.vt <> 'multipicklist'
     and new.custom ? cf.key
     and jsonb_typeof(new.custom -> cf.key) <> 'null';

  return new;
end
$$;

create or replace function app.reindex_custom_field(p_object_key text, p_field_key text) returns integer
language plpgsql as $$
declare
  ftype text;
  n integer := 0;
  tbl text;
begin
  select app.field_value_type(field_type, options) into ftype from custom_fields
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and key = p_field_key and is_indexed;

  delete from record_index
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and field_key = p_field_key;

  if ftype is null or ftype = 'multipicklist' then
    return 0;
  end if;

  tbl := case p_object_key when 'lead' then 'leads' when 'contact' then 'contacts'
                           when 'account' then 'accounts' when 'deal' then 'deals' else 'records' end;

  execute format($q$
    insert into record_index (tenant_id, object_key, field_key, record_id, v_text, v_num, v_date, v_bool)
    select r.tenant_id, $1, $2, r.id,
           case when $3 in ('text','textarea','email','phone','url','picklist','lookup','user') then left(lower(r.custom ->> $2), 256) end,
           case when $3 in ('number','currency','percent') then app.try_numeric(r.custom ->> $2) end,
           case when $3 in ('date','datetime') then app.try_timestamptz(r.custom ->> $2) end,
           case when $3 = 'boolean' then app.try_boolean(r.custom ->> $2) end
      from %I r
     where r.tenant_id = app.current_tenant_id()
       and r.custom ? $2 and jsonb_typeof(r.custom -> $2) <> 'null'
       %s
  $q$, tbl, case when tbl = 'records' then 'and r.object_key = $1' else '' end)
  using p_object_key, p_field_key, ftype;

  get diagnostics n = row_count;
  return n;
end
$$;

-- 2. validation rules --------------------------------------------------------------------------
create table validation_rules (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  name        text not null check (length(name) between 1 and 120),
  -- error condition formula: the save is rejected when it evaluates to true
  condition   text not null check (length(condition) between 1 and 2000),
  message     text not null check (length(message) between 1 and 300),
  field_key   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade
);
create index validation_rules_object on validation_rules (tenant_id, object_key);

-- 3. page layouts live in custom_objects.settings -> 'layout' (versioned + audited with the object)

do $$
begin
  execute 'alter table validation_rules enable row level security';
  execute 'alter table validation_rules force row level security';
  execute $p$create policy tenant_isolation on validation_rules as permissive for all to public
    using (tenant_id = (select app.current_tenant_id()))
    with check (tenant_id = (select app.current_tenant_id()))$p$;
  execute 'grant select, insert, update, delete on validation_rules to synapse_app';
end
$$;

create trigger validation_rules_touch before update on validation_rules for each row execute function app.touch_row();
-- rules are part of the cached metadata
create trigger validation_rules_meta after insert or update or delete on validation_rules for each statement execute function app.bump_meta_version();
create trigger validation_rules_audit after insert or update or delete on validation_rules for each row execute function app.audit_row_change('validation_rule');
create trigger forms_audit            after insert or update or delete on forms            for each row execute function app.audit_row_change('form');
