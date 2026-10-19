-- HRP Synapse · 0022 WhatsApp Business: templates, shared inbox, campaigns
--
-- wa_templates           message templates approved by Meta (synced, or submitted from Synapse)
-- conversations          one thread per customer address per channel account (WhatsApp, Instagram),
--                        with an owner, open/closed state and the 24-hour customer-service window
-- campaigns              bulk sends to an audience (WhatsApp templates or email), with consent checks
-- campaign_recipients    one row per person: queued → sent → delivered → read → replied, or skipped
-- quick_replies          saved answers for the inbox

create table wa_templates (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel_account_id  uuid not null,
  name                text not null check (name ~ '^[a-z0-9_]+$' and length(name) <= 512),
  language            text not null check (length(language) between 2 and 15),
  category            text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  status              text not null default 'PENDING' check (status in ('APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'DELETED')),
  components          jsonb not null default '[]'::jsonb,
  body_text           text,
  variable_count      integer not null default 0,
  header_type         text check (header_type in ('TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION')),
  external_id         text,
  rejected_reason     text,
  synced_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, channel_account_id, name, language),
  foreign key (tenant_id, channel_account_id) references channel_accounts (tenant_id, id) on delete cascade
);

create table conversations (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  channel_account_id  uuid not null,
  channel             text not null check (channel in ('whatsapp', 'instagram', 'sms')),
  address             text not null check (length(address) between 3 and 120),
  display_name        text check (length(display_name) <= 200),
  related_object      text,
  related_id          uuid,
  assigned_to         uuid,
  status              text not null default 'open' check (status in ('open', 'pending', 'closed')),
  last_inbound_at     timestamptz,
  last_message_at     timestamptz not null default now(),
  last_preview        text check (length(last_preview) <= 200),
  last_direction      text check (last_direction in ('in', 'out')),
  unread              integer not null default 0,
  first_response_at   timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, channel_account_id, address),
  foreign key (tenant_id, channel_account_id) references channel_accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, assigned_to) references users (tenant_id, id) on delete set null (assigned_to)
);
create index conversations_inbox on conversations (tenant_id, status, last_message_at desc);
create index conversations_mine on conversations (tenant_id, assigned_to, last_message_at desc) where status <> 'closed';
create index conversations_record on conversations (tenant_id, related_object, related_id);

create table campaigns (
  id                  uuid primary key default app.uuidv7(),
  tenant_id           uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name                text not null check (length(name) between 1 and 160),
  channel             text not null check (channel in ('whatsapp', 'email')),
  channel_account_id  uuid not null,
  template_id         uuid,
  -- whatsapp: [{"source":"field","field":"first_name","fallback":"there"} | {"source":"text","value":"..."}]
  variables           jsonb not null default '[]'::jsonb,
  header_media        jsonb,
  -- email: subject and body with {{field}} merge tags
  subject             text check (length(subject) <= 300),
  body                text check (length(body) <= 20000),
  purpose             text not null default 'marketing' check (purpose in ('marketing', 'transactional')),
  -- {"object":"lead","filters":[...],"q":"..."}
  audience            jsonb not null,
  status              text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at        timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  total               integer not null default 0,
  skipped             integer not null default 0,
  sent                integer not null default 0,
  delivered           integer not null default 0,
  read                integer not null default 0,
  replied             integer not null default 0,
  failed              integer not null default 0,
  last_error          text,
  created_by          uuid default app.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, channel_account_id) references channel_accounts (tenant_id, id) on delete restrict,
  foreign key (tenant_id, template_id) references wa_templates (tenant_id, id) on delete restrict,
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);
create index campaigns_sending on campaigns (tenant_id, status) where status in ('scheduled', 'sending');

create table campaign_recipients (
  id              uuid primary key default app.uuidv7(),
  tenant_id       uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  campaign_id     uuid not null,
  subject_object  text not null check (subject_object in ('lead', 'contact')),
  subject_id      uuid not null,
  address         text not null,
  address_key     text not null,
  status          text not null default 'queued' check (status in ('queued', 'skipped', 'sent', 'delivered', 'read', 'replied', 'failed')),
  skip_reason     text,
  message_id      uuid,
  error           text check (length(error) <= 500),
  sent_at         timestamptz,
  updated_at      timestamptz not null default now(),
  unique (tenant_id, campaign_id, address_key),
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id) on delete cascade
);
create index campaign_recipients_queue on campaign_recipients (tenant_id, campaign_id, status);
create index campaign_recipients_message on campaign_recipients (tenant_id, message_id) where message_id is not null;

create table quick_replies (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  shortcut    text not null check (shortcut ~ '^[a-z0-9_-]{1,30}$'),
  title       text not null check (length(title) between 1 and 100),
  body        text not null check (length(body) between 1 and 4000),
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  unique (tenant_id, shortcut)
);

-- messages learn their conversation, template, campaign, media and purpose
alter table messages
  add column conversation_id uuid,
  add column template_id     uuid,
  add column campaign_id     uuid,
  add column media           jsonb,
  add column purpose         text not null default 'transactional' check (purpose in ('transactional', 'marketing')),
  add column sent_by         uuid default app.current_user_id(),
  add column delivered_at    timestamptz,
  add column read_at         timestamptz,
  add foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete set null (conversation_id),
  add foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id) on delete set null (campaign_id);
create index messages_conversation on messages (tenant_id, conversation_id, created_at);
create index messages_external_any on messages (tenant_id, external_id) where external_id is not null;

do $$
declare t text;
begin
  foreach t in array array['wa_templates', 'conversations', 'campaigns', 'campaign_recipients', 'quick_replies'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I as permissive for all to public
      using (tenant_id = (select app.current_tenant_id()))
      with check (tenant_id = (select app.current_tenant_id()))$p$, t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end
$$;

create trigger wa_templates_touch        before update on wa_templates        for each row execute function app.touch_row();
create trigger campaigns_touch           before update on campaigns           for each row execute function app.touch_row();
create trigger campaign_recipients_touch before update on campaign_recipients for each row execute function app.touch_row();
create trigger campaigns_audit after insert or delete or update of status, name, audience on campaigns for each row execute function app.audit_row_change('campaign');
