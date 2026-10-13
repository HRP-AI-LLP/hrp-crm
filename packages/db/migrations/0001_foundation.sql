-- HRP Synapse · 0001 foundation
-- Extensions, the `app` helper schema, the least-privilege runtime role and core helper functions.
--
-- Role model
--   <owner>       Neon project owner (e.g. neondb_owner). Owns every object, runs migrations.
--   synapse_app   Runtime role used by Workers / Hyperdrive / Oracle jobs. LOGIN is enabled by the
--                 migrate runner (password comes from env). NOBYPASSRLS, not an owner of anything,
--                 so Row Level Security always applies to it.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists app;
create schema if not exists ops;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'synapse_app') then
    create role synapse_app nologin nobypassrls noinherit;
  end if;
end
$$;

-- Guard rail: the runtime role must never be able to bypass RLS or own objects.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'synapse_app' and (rolbypassrls or rolsuper)) then
    raise exception 'synapse_app must be NOBYPASSRLS and NOSUPERUSER';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Tenant context. Set per *transaction* by the API with set_config(..., true) so a pooled
-- connection can never carry one tenant's context into another tenant's request.
-- An unset context yields NULL, and NULL = tenant_id is never true, so the default is "no rows".
-- A malformed value raises (fail closed).
-- ---------------------------------------------------------------------------------------------
create or replace function app.current_tenant_id() returns uuid
language sql stable parallel safe as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app.current_user_id() returns uuid
language sql stable parallel safe as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.current_request_id() returns text
language sql stable parallel safe as $$
  select nullif(current_setting('app.request_id', true), '')
$$;

-- RFC 9562 UUIDv7 (time ordered, B-tree friendly). Works on PG 14+; PG 18 has uuidv7() natively.
create or replace function app.uuidv7() returns uuid
language plpgsql volatile parallel safe as $$
declare
  ts bytea := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  b  bytea := uuid_send(gen_random_uuid());
begin
  b := overlay(b placing ts from 1 for 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); -- RFC variant
  return encode(b, 'hex')::uuid;
end
$$;

-- updated_at / optimistic-concurrency version bump
create or replace function app.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if to_jsonb(new) ? 'version' then
    new.version := coalesce(old.version, 0) + 1;
  end if;
  if to_jsonb(new) ? 'updated_by' then
    new.updated_by := coalesce(app.current_user_id(), new.updated_by);
  end if;
  return new;
end
$$;

-- Lenient casts used by the custom-field index (bad data must never break a write)
create or replace function app.try_numeric(v text) returns numeric
language plpgsql immutable as $$
begin
  return v::numeric;
exception when others then
  return null;
end
$$;

create or replace function app.try_timestamptz(v text) returns timestamptz
language plpgsql stable as $$
begin
  return v::timestamptz;
exception when others then
  return null;
end
$$;

create or replace function app.try_boolean(v text) returns boolean
language plpgsql immutable as $$
begin
  return v::boolean;
exception when others then
  return null;
end
$$;
