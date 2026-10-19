-- HRP Synapse · 0021 privacy and DPDP Act compliance
--
-- consent_events     append-only evidence of every consent given or withdrawn (who, purpose, notice
--                    version, source, IP). contacts.consent / leads.consent hold the current state.
-- suppressions       do-not-contact list keyed by address (phone last 10 digits / lower-case email),
--                    so an opt-out survives merges, deletions and re-imports.
-- privacy_notices    versioned notices shown to data principals (itemised purposes, languages).
-- privacy_config     per-workspace grievance officer, request deadlines and the public portal key.
-- data_requests      data-principal requests (access, correction, erasure, grievance, nomination,
--                    consent withdrawal) with deadlines, verification and a status link.
-- erasures           records whose personal data was erased; audit history of these is shown masked.
-- data_breaches      breach register (detected, contained, Board report, principals notified).

create table consent_events (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  subject_object text not null check (subject_object in ('lead', 'contact')),
  subject_id    uuid not null,
  purpose       text not null check (purpose in ('marketing', 'whatsapp', 'email', 'sms', 'calls', 'processing')),
  granted       boolean not null,
  source        text not null check (source in ('web_form', 'whatsapp', 'ad_form', 'manual', 'import', 'api', 'portal', 'request', 'reply_stop', 'unsubscribe_link')),
  notice_version integer,
  evidence      jsonb not null default '{}'::jsonb,
  actor_id      uuid default app.current_user_id(),
  created_at    timestamptz not null default now()
);
create index consent_events_subject on consent_events (tenant_id, subject_object, subject_id, created_at desc);

create table suppressions (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel       text not null check (channel in ('whatsapp', 'email', 'sms', 'calls', 'all')),
  address_key   text not null check (length(address_key) between 3 and 320),
  reason        text not null check (reason in ('opt_out', 'erasure', 'bounce', 'complaint', 'manual')),
  note          text check (length(note) <= 500),
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  primary key (tenant_id, channel, address_key)
);

create table privacy_notices (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  version       integer not null,
  language      text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  title         text not null check (length(title) between 1 and 200),
  body          text not null check (length(body) <= 40000),
  -- [{"key":"marketing_whatsapp","label":"Offers on WhatsApp","required":false}]
  purposes      jsonb not null default '[]'::jsonb,
  published_at  timestamptz,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, version, language)
);

create table privacy_config (
  tenant_id         uuid primary key default app.current_tenant_id() references tenants (id) on delete cascade,
  portal_enabled    boolean not null default false,
  portal_key        text not null unique default encode(gen_random_bytes(18), 'hex'),
  officer_name      text check (length(officer_name) <= 200),
  officer_email     text check (length(officer_email) <= 320),
  officer_phone     text check (length(officer_phone) <= 40),
  officer_address   text check (length(officer_address) <= 500),
  request_sla_days  integer not null default 30 check (request_sla_days between 1 and 90),
  -- {"leadsUnconvertedMonths":24,"lostDealsMonths":36,"messagesMonths":36,"recordingsMonths":12,"recycleBinDays":30}
  retention         jsonb not null default '{}'::jsonb,
  retention_last_run timestamptz,
  updated_at        timestamptz not null default now()
);

create table data_requests (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  number          text,
  kind            text not null check (kind in ('access', 'correction', 'erasure', 'grievance', 'nomination', 'withdraw_consent')),
  status          text not null default 'received' check (status in ('received', 'verifying', 'in_progress', 'completed', 'rejected')),
  source          text not null default 'manual' check (source in ('portal', 'email', 'phone', 'whatsapp', 'manual')),
  requester_name  text not null check (length(requester_name) between 1 and 200),
  requester_email text check (length(requester_email) <= 320),
  requester_phone text check (length(requester_phone) <= 40),
  details         text check (length(details) <= 5000),
  subject_object  text check (subject_object in ('lead', 'contact')),
  subject_id      uuid,
  verified_at     timestamptz,
  verify_hash     text,
  verify_expires  timestamptz,
  due_at          timestamptz not null,
  assigned_to     uuid,
  resolution      text check (length(resolution) <= 5000),
  resolved_at     timestamptz,
  resolved_by     uuid,
  status_token    text not null unique default encode(gen_random_bytes(18), 'hex'),
  created_by      uuid default app.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, assigned_to) references users (tenant_id, id) on delete set null (assigned_to)
);
create index data_requests_open on data_requests (tenant_id, due_at) where status not in ('completed', 'rejected');

create table erasures (
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key    text not null,
  record_id     uuid not null,
  request_id    uuid,
  summary       jsonb not null default '{}'::jsonb,
  erased_by     uuid default app.current_user_id(),
  erased_at     timestamptz not null default now(),
  primary key (tenant_id, object_key, record_id)
);

create table data_breaches (
  id                     uuid primary key default app.uuidv7(),
  tenant_id              uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  title                  text not null check (length(title) between 3 and 200),
  description            text check (length(description) <= 10000),
  occurred_at            timestamptz,
  detected_at            timestamptz not null default now(),
  status                 text not null default 'open' check (status in ('open', 'contained', 'reported', 'closed')),
  severity               text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  data_categories        text[] not null default '{}',
  affected_count         integer check (affected_count >= 0),
  contained_at           timestamptz,
  board_intimated_at     timestamptz,
  board_report_at        timestamptz,
  principals_notified_at timestamptz,
  actions                text check (length(actions) <= 10000),
  created_by             uuid default app.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, id)
);

-- public entry points: the privacy portal and a request's status link
alter table public_routes drop constraint public_routes_kind_check;
alter table public_routes add constraint public_routes_kind_check check (kind in ('form', 'channel', 'quote', 'shipment', 'installation', 'ticket', 'integration', 'meta_page', 'privacy', 'privacy_request'));

create or replace function app.sync_privacy_route() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'privacy_config' then
    delete from public_routes where kind = 'privacy' and tenant_id = coalesce(new.tenant_id, old.tenant_id);
    if tg_op <> 'DELETE' and new.portal_enabled then
      insert into public_routes (route_key, tenant_id, kind, target_id) values (new.portal_key, new.tenant_id, 'privacy', new.tenant_id);
    end if;
  else
    if tg_op = 'DELETE' then
      delete from public_routes where kind = 'privacy_request' and target_id = old.id;
    elsif tg_op = 'INSERT' then
      insert into public_routes (route_key, tenant_id, kind, target_id) values (new.status_token, new.tenant_id, 'privacy_request', new.id);
    end if;
  end if;
  return null;
end
$$;
create trigger privacy_config_route after insert or update or delete on privacy_config for each row execute function app.sync_privacy_route();
create trigger data_requests_route  after insert or delete on data_requests  for each row execute function app.sync_privacy_route();

do $$
declare t text;
begin
  foreach t in array array['consent_events', 'suppressions', 'privacy_notices', 'privacy_config', 'data_requests', 'erasures', 'data_breaches'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;
-- consent evidence and erasure records are never rewritten
revoke update, delete on consent_events from synapse_app;
revoke update on erasures from synapse_app;

create trigger privacy_config_touch before update on privacy_config for each row execute function app.touch_row();
create trigger data_requests_touch  before update on data_requests  for each row execute function app.touch_row();
create trigger data_breaches_touch  before update on data_breaches  for each row execute function app.touch_row();
create trigger data_requests_audit  after insert or update or delete on data_requests  for each row execute function app.audit_row_change('data_request');
create trigger data_breaches_audit  after insert or update or delete on data_breaches  for each row execute function app.audit_row_change('data_breach');
create trigger privacy_notices_audit after insert or update or delete on privacy_notices for each row execute function app.audit_row_change('privacy_notice');
create trigger suppressions_audit   after insert or delete on suppressions for each row execute function app.audit_row_change('suppression');

-- the hash-chained audit export reads the trail in a stable order
create index audit_logs_chain on audit_logs (tenant_id, created_at, id);
