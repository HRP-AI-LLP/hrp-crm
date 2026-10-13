-- HRP Synapse · 0005 workflows, communication channels, webhooks, AI knowledge base & usage

create table workflows (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id(),
  name           text not null,
  object_key     text not null,
  trigger_event  text not null check (trigger_event in ('created', 'updated', 'stage_changed', 'deleted')),
  -- [{field, op, value}]  (all must match)
  conditions     jsonb not null default '[]'::jsonb,
  -- [{type:'create_task'|'update_field'|'send_webhook'|'send_email'|'send_whatsapp'|'ai_score'|'assign_owner', ...}]
  actions        jsonb not null default '[]'::jsonb,
  is_enabled     boolean not null default true,
  module_key     text,
  run_count      integer not null default 0,
  last_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_key) references custom_objects (tenant_id, key) on update cascade on delete cascade
);
create index workflows_lookup on workflows (tenant_id, object_key, trigger_event) where is_enabled;

create table workflow_runs (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id(),
  workflow_id  uuid not null,
  record_id    uuid,
  status       text not null check (status in ('success', 'skipped', 'failed')),
  output       jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  foreign key (tenant_id, workflow_id) references workflows (tenant_id, id) on delete cascade
);
create index workflow_runs_wf on workflow_runs (tenant_id, workflow_id, started_at desc);

create table channel_accounts (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel            text not null check (channel in ('email', 'whatsapp', 'sms', 'webhook')),
  name               text not null,
  provider           text not null, -- 'resend' | 'smtp_relay' | 'meta_cloud' | 'generic' ...
  config             jsonb not null default '{}'::jsonb,  -- non-secret settings only
  secret_ciphertext  text,  -- AES-GCM encrypted with the platform DATA_ENCRYPTION_KEY
  inbound_key        text not null unique default encode(gen_random_bytes(18), 'hex'),
  status             text not null default 'active' check (status in ('active', 'disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id)
);

create table messages (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel_account_id  uuid,
  channel             text not null,
  direction           text not null check (direction in ('in', 'out')),
  from_addr           text,
  to_addr             text,
  subject             text,
  body                text,
  status              text not null default 'queued'
                        check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  external_id         text,
  related_object      text,
  related_id          uuid,
  sentiment           text,
  error               text,
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, channel_account_id) references channel_accounts (tenant_id, id) on delete set null (channel_account_id)
);
create index messages_related on messages (tenant_id, related_object, related_id, created_at desc);
create unique index messages_external on messages (tenant_id, channel, external_id) where external_id is not null;

create table webhook_subscriptions (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  url            text not null check (url ~ '^https://'),
  events         text[] not null default '{}',
  secret         text not null default encode(gen_random_bytes(24), 'hex'),
  is_enabled     boolean not null default true,
  failure_count  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table kb_documents (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  title        text not null,
  source       text,
  content      text,  -- extracted plain text (source of truth for re-indexing)
  mime_type    text not null default 'text/plain',
  status       text not null default 'pending' check (status in ('pending', 'indexed', 'failed')),
  chunk_count  integer not null default 0,
  error        text,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Chunk text lives in Postgres (RLS protected); vectors live in Vectorize under namespace = tenant_id.
-- Retrieval re-reads chunk text through RLS, so a Vectorize mistake can never return another
-- tenant's text.
create table kb_chunks (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id(),
  document_id  uuid not null,
  idx          integer not null,
  content      text not null,
  embedded_at  timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, document_id) references kb_documents (tenant_id, id) on delete cascade
);
create index kb_chunks_doc on kb_chunks (tenant_id, document_id, idx);

-- Per-tenant AI metering (quota enforcement on shared free-tier provider keys)
create table ai_usage (
  id             uuid primary key default app.uuidv7(),
  tenant_id      uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  task           text not null,
  provider       text not null,
  model          text not null,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  ok             boolean not null,
  created_at     timestamptz not null default now()
);
create index ai_usage_day on ai_usage (tenant_id, created_at desc);

create trigger workflows_touch        before update on workflows             for each row execute function app.touch_row();
create trigger channel_accounts_touch before update on channel_accounts      for each row execute function app.touch_row();
create trigger webhook_subs_touch     before update on webhook_subscriptions for each row execute function app.touch_row();
create trigger kb_documents_touch     before update on kb_documents          for each row execute function app.touch_row();
