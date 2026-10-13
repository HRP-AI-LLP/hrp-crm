-- HRP Synapse · 0015 files (R2), lead routing & scoring, partner attribution, quote revisions + approvals

-- ---------------------------------------------------------------------------------------------
-- Object → physical table, in one place for SQL helpers (mirrors storageFor() in @synapse/shared)
-- ---------------------------------------------------------------------------------------------
create or replace function app.object_table(p_key text) returns text
language sql immutable as $$
  select case p_key
    when 'lead' then 'leads' when 'contact' then 'contacts' when 'account' then 'accounts' when 'deal' then 'deals'
    when 'product' then 'products' when 'quote' then 'quotes'
    when 'sales_order' then 'sales_orders' when 'vendor' then 'vendors' when 'purchase_order' then 'purchase_orders'
    when 'shipment' then 'shipments' when 'installation' then 'installations' when 'ticket' then 'tickets'
    when 'invoice' then 'invoices' when 'payment' then 'payments'
    else 'records' end
$$;

create or replace function app.reindex_custom_field(p_object_key text, p_field_key text) returns integer
language plpgsql as $$
declare
  ftype text;
  n integer := 0;
  tbl text := app.object_table(p_object_key);
begin
  select app.field_value_type(field_type, options) into ftype from custom_fields
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and key = p_field_key and is_indexed;

  delete from record_index
   where tenant_id = app.current_tenant_id() and object_key = p_object_key and field_key = p_field_key;

  if ftype is null or ftype = 'multipicklist' then
    return 0;
  end if;

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

-- ---------------------------------------------------------------------------------------------
-- Files: metadata here, bytes in R2 under <tenant>/<object>/<record>/<file id>
-- ---------------------------------------------------------------------------------------------
create table files (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key    text not null,
  record_id     uuid not null,
  name          text not null check (length(name) between 1 and 255),
  content_type  text not null check (length(content_type) <= 120),
  size_bytes    bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  storage_key   text not null,
  kind          text not null default 'attachment' check (kind in ('attachment', 'photo', 'proof', 'signature', 'document')),
  description   text check (length(description) <= 500),
  sha256        text,
  uploaded_by   uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, uploaded_by) references users (tenant_id, id) on delete set null (uploaded_by)
);
create index files_record on files (tenant_id, object_key, record_id, created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Leads: richer sources, partner attribution, follow-ups, activity recency, rule-based score
-- ---------------------------------------------------------------------------------------------
alter table accounts add column account_type text check (account_type in ('customer', 'prospect', 'architect', 'interior_designer', 'dealer', 'builder', 'partner', 'other'));
alter table leads
  add column source_detail          text check (length(source_detail) <= 200),
  add column referred_by_id         uuid,
  add column score                  integer check (score between 0 and 100),
  add column rating                 text check (rating in ('hot', 'warm', 'cold')),
  add column next_follow_up_at      timestamptz,
  add column follow_up_reminded_at  timestamptz,
  add column last_activity_at       timestamptz,
  add column assigned_at            timestamptz,
  add foreign key (tenant_id, referred_by_id) references accounts (tenant_id, id) on delete set null (referred_by_id);
alter table deals
  add column referred_by_id    uuid,
  add column last_activity_at  timestamptz,
  add foreign key (tenant_id, referred_by_id) references accounts (tenant_id, id) on delete set null (referred_by_id);
create index leads_follow_up on leads (next_follow_up_at) where follow_up_reminded_at is null and deleted_at is null and converted_at is null;
create index leads_referred on leads (tenant_id, referred_by_id) where referred_by_id is not null;

-- field visits are logged as activities
alter table activities drop constraint activities_kind_check;
alter table activities add constraint activities_kind_check check (kind in ('note', 'call', 'email', 'meeting', 'whatsapp', 'sms', 'instagram',
  'visit', 'stage_change', 'system', 'ai', 'webhook'));

-- touching a lead or deal with a human interaction refreshes its "last activity" (aging)
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
  end if;
  return new;
end
$$;
create trigger activities_last_touch after insert on activities for each row execute function app.touch_last_activity();

-- Instagram DMs arrive like WhatsApp messages (Meta webhook)
alter table channel_accounts drop constraint channel_accounts_channel_check;
alter table channel_accounts add constraint channel_accounts_channel_check check (channel in ('email', 'whatsapp', 'instagram', 'sms', 'webhook'));

-- ---------------------------------------------------------------------------------------------
-- Assignment rules (first match wins) and scoring rules — both part of the cached metadata
-- ---------------------------------------------------------------------------------------------
create table assignment_rules (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null,
  name        text not null check (length(name) between 1 and 120),
  position    integer not null default 0,
  -- [{"field": "source", "op": "eq", "value": "instagram"}]
  criteria    jsonb not null default '[]'::jsonb,
  strategy    text not null default 'round_robin' check (strategy in ('round_robin', 'load_balanced', 'fixed')),
  user_ids    uuid[] not null default '{}',
  team_id     uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete set null (team_id)
);

-- round-robin pointer, kept apart so moving it neither audits nor invalidates cached metadata
create table assignment_cursors (
  tenant_id  uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  rule_id    uuid not null,
  position   integer not null default 0,
  primary key (tenant_id, rule_id),
  foreign key (tenant_id, rule_id) references assignment_rules (tenant_id, id) on delete cascade
);

create table scoring_rules (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key  text not null default 'lead',
  name        text not null check (length(name) between 1 and 120),
  criteria    jsonb not null default '[]'::jsonb,
  points      integer not null check (points between -100 and 100),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Quote revisions + approval workflow (generic: quotes now, purchase orders / credit notes later)
-- ---------------------------------------------------------------------------------------------
alter table quotes drop constraint quotes_status_check;
alter table quotes add constraint quotes_status_check check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'));
alter table quotes
  add column revision          integer not null default 1,
  add column root_id           uuid,
  add column max_discount_pct  numeric(5, 2) not null default 0,
  add column approval_status   text not null default 'not_required' check (approval_status in ('not_required', 'required', 'pending', 'approved', 'rejected'));
create index quotes_root on quotes (tenant_id, root_id) where root_id is not null;

create table approval_rules (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key     text not null,
  name           text not null check (length(name) between 1 and 120),
  -- approval is needed when ALL criteria match, e.g. max_discount_pct gt 10
  criteria       jsonb not null default '[]'::jsonb,
  approver_type  text not null default 'manager' check (approver_type in ('manager', 'user', 'role', 'owner')),
  approver_id    uuid,
  approver_role  text,
  position       integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  check (approver_type <> 'user' or approver_id is not null),
  check (approver_type <> 'role' or approver_role is not null),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade,
  foreign key (tenant_id, approver_id) references users (tenant_id, id) on delete cascade
);

create table approval_requests (
  id                uuid primary key default app.uuidv7(),
  tenant_id         uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  object_key        text not null,
  record_id         uuid not null,
  rule_id           uuid,
  rule_name         text not null,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by      uuid default app.current_user_id(),
  -- exactly one of approver_id / approver_role addresses the approver
  approver_id       uuid,
  approver_role     text,
  note              text check (length(note) <= 2000),
  -- what was approved: title, amounts, discount (the record may change later)
  summary           jsonb not null default '{}'::jsonb,
  decision_comment  text check (length(decision_comment) <= 2000),
  decided_by        uuid,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, rule_id) references approval_rules (tenant_id, id) on delete set null (rule_id),
  foreign key (tenant_id, requested_by) references users (tenant_id, id) on delete set null (requested_by),
  foreign key (tenant_id, approver_id) references users (tenant_id, id) on delete set null (approver_id),
  foreign key (tenant_id, decided_by) references users (tenant_id, id) on delete set null (decided_by)
);
create index approval_requests_record on approval_requests (tenant_id, object_key, record_id, created_at desc);
create index approval_requests_pending on approval_requests (tenant_id, status, approver_id) where status = 'pending';
-- one open request per record
create unique index approval_requests_one_pending on approval_requests (tenant_id, object_key, record_id) where status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- RLS, grants, triggers
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['files', 'assignment_rules', 'assignment_cursors', 'scoring_rules', 'approval_rules', 'approval_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger assignment_rules_touch before update on assignment_rules for each row execute function app.touch_row();
create trigger scoring_rules_touch    before update on scoring_rules    for each row execute function app.touch_row();
create trigger approval_rules_touch   before update on approval_rules   for each row execute function app.touch_row();

-- rule definitions travel with the cached metadata
create trigger assignment_rules_meta after insert or update or delete on assignment_rules for each statement execute function app.bump_meta_version();
create trigger scoring_rules_meta    after insert or update or delete on scoring_rules    for each statement execute function app.bump_meta_version();
create trigger approval_rules_meta   after insert or update or delete on approval_rules   for each statement execute function app.bump_meta_version();

create trigger files_audit             after insert or update or delete on files             for each row execute function app.audit_row_change('file');
create trigger assignment_rules_audit  after insert or update or delete on assignment_rules  for each row execute function app.audit_row_change('assignment_rule');
create trigger scoring_rules_audit     after insert or update or delete on scoring_rules     for each row execute function app.audit_row_change('scoring_rule');
create trigger approval_rules_audit    after insert or update or delete on approval_rules    for each row execute function app.audit_row_change('approval_rule');
create trigger approval_requests_audit after insert or update or delete on approval_requests for each row execute function app.audit_row_change('approval_request');

-- scoring bands (settings.scoring) are cached metadata too
create or replace function app.bump_meta_on_security_change() returns trigger
language plpgsql as $$
begin
  if (old.settings -> 'security') is distinct from (new.settings -> 'security')
     or (old.settings -> 'scoring') is distinct from (new.settings -> 'scoring') then
    new.meta_version := old.meta_version + 1;
  end if;
  return new;
end
$$;
