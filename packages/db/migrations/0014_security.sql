-- HRP Synapse · 0014 security & admin: TOTP two-factor, invite / reset / MFA tokens, teams,
-- sharing rules, per-record sharing and API keys.

-- ---------------------------------------------------------------------------------------------
-- Two-factor authentication (TOTP). The secret is AES-GCM encrypted by the API (tenant+user AAD).
-- ---------------------------------------------------------------------------------------------
alter table users add column mfa_secret_ciphertext text;
alter table users add column mfa_enabled_at timestamptz;
-- sha-256 hashes of one-time recovery codes; a used code is removed
alter table users add column mfa_recovery_hashes text[] not null default '{}';
alter table users add column password_changed_at timestamptz;
-- last accepted TOTP time step (blocks replaying a code inside its 30-second window)
alter table users add column mfa_last_step bigint;

-- one-time tokens: invitations, password resets, pending MFA sign-ins (only hashes are stored)
create table user_tokens (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id     uuid not null,
  kind        text not null check (kind in ('invite', 'reset', 'mfa')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer not null default 0,
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index user_tokens_user on user_tokens (tenant_id, user_id, kind);

-- ---------------------------------------------------------------------------------------------
-- Teams (territories, branches, squads). A team lead sees the team's records under "team" access.
-- ---------------------------------------------------------------------------------------------
create table teams (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name         text not null check (length(name) between 1 and 80),
  description  text,
  lead_id      uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, lead_id) references users (tenant_id, id) on delete set null (lead_id)
);

create table team_members (
  tenant_id  uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  team_id    uuid not null,
  user_id    uuid not null,
  primary key (tenant_id, team_id, user_id),
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index team_members_user on team_members (tenant_id, user_id);

-- ---------------------------------------------------------------------------------------------
-- Sharing rules: widen "own"/"team" access for records that match criteria, for a team or role.
-- ---------------------------------------------------------------------------------------------
create table sharing_rules (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  name        text not null check (length(name) between 1 and 120),
  -- [{field, op, value}] — all must match; [] = every record of the object
  criteria    jsonb not null default '[]'::jsonb,
  team_id     uuid,
  role_key    text,
  access      text not null default 'read' check (access in ('read', 'edit')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check ((team_id is null) <> (role_key is null)),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade
);

-- Manual sharing of one record with a person or a team
create table record_shares (
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  record_id   uuid not null,
  user_id     uuid,
  team_id     uuid,
  access      text not null default 'read' check (access in ('read', 'edit')),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null)),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade
);
create unique index record_shares_uq on record_shares (tenant_id, object_key, record_id, coalesce(user_id, team_id));
create index record_shares_user on record_shares (tenant_id, user_id) where user_id is not null;
create index record_shares_team on record_shares (tenant_id, team_id) where team_id is not null;

-- ---------------------------------------------------------------------------------------------
-- API keys for integrations: act as a user, limited to read or read+write on /api/v1
-- ---------------------------------------------------------------------------------------------
create table api_keys (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name          text not null check (length(name) between 1 and 80),
  prefix        text not null,
  key_hash      text not null unique,
  user_id       uuid not null,
  scopes        text[] not null default '{read}',
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  last_used_ip  text,
  use_count     bigint not null default 0,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['user_tokens', 'teams', 'team_members', 'sharing_rules', 'record_shares', 'api_keys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger teams_touch         before update on teams         for each row execute function app.touch_row();
create trigger sharing_rules_touch before update on sharing_rules for each row execute function app.touch_row();

create trigger teams_audit         after insert or update or delete on teams         for each row execute function app.audit_row_change('team');
create trigger sharing_rules_audit after insert or update or delete on sharing_rules for each row execute function app.audit_row_change('sharing_rule');
create trigger api_keys_audit      after insert or update or delete on api_keys      for each row execute function app.audit_row_change('api_key');

-- membership and rules change what people can see: rotate cached principals
create trigger teams_meta         after insert or update or delete on teams         for each statement execute function app.bump_meta_version();
create trigger team_members_meta  after insert or update or delete on team_members  for each statement execute function app.bump_meta_version();
create trigger sharing_rules_meta after insert or update or delete on sharing_rules for each statement execute function app.bump_meta_version();

-- never let secrets reach the audit log
create or replace function app.audit_row_change() returns trigger
language plpgsql as $$
declare
  redact constant text[] := array['password_hash', 'secret_ciphertext', 'secret', 'refresh_hash',
                                  'updated_at', 'version', 'updated_by', 'mfa_secret_ciphertext',
                                  'mfa_recovery_hashes', 'key_hash', 'token_hash', 'share_token',
                                  'failed_logins', 'last_login_at', 'last_used_at', 'last_used_ip', 'use_count'];
  o jsonb;
  n jsonb;
  diff jsonb := '{}'::jsonb;
  k text;
  act text;
  tid uuid;
  rid uuid;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new) - redact; act := 'create'; tid := new.tenant_id; rid := (to_jsonb(new) ->> 'id')::uuid;
    diff := n;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old) - redact; n := to_jsonb(new) - redact; tid := new.tenant_id; rid := (to_jsonb(new) ->> 'id')::uuid;
    act := case when (o ->> 'deleted_at') is null and (n ->> 'deleted_at') is not null then 'delete' else 'update' end;
    for k in select jsonb_object_keys(n) loop
      if (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
      end if;
    end loop;
    if diff = '{}'::jsonb then
      return new;
    end if;
  else
    o := to_jsonb(old) - redact; act := 'delete'; tid := old.tenant_id; rid := (to_jsonb(old) ->> 'id')::uuid;
    diff := o;
  end if;

  insert into audit_logs (tenant_id, action, object_key, record_id, changes)
  values (tid, act, coalesce(tg_argv[0], (coalesce(n, o) ->> 'object_key'), tg_table_name), rid, diff);

  return coalesce(new, old);
end
$$;

-- the workspace security policy (settings.security) is part of the cached metadata
create or replace function app.bump_meta_on_security_change() returns trigger
language plpgsql as $$
begin
  if (old.settings -> 'security') is distinct from (new.settings -> 'security') then
    new.meta_version := old.meta_version + 1;
  end if;
  return new;
end
$$;
create trigger tenants_security_meta before update of settings on tenants for each row execute function app.bump_meta_on_security_change();
