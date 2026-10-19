-- HRP Synapse · 0027 native push for the Android app (Firebase Cloud Messaging)
--
-- native_push_tokens   one FCM registration token per installed app; notifications go to these
--                      as well as to browser push subscriptions.

create table native_push_tokens (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id          uuid not null,
  platform         text not null check (platform in ('android', 'ios')),
  token            text not null check (length(token) between 20 and 4096),
  label            text check (length(label) <= 120),
  failures         integer not null default 0,
  last_success_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, token),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index native_push_tokens_user on native_push_tokens (tenant_id, user_id);

alter table native_push_tokens enable row level security;
alter table native_push_tokens force row level security;
create policy tenant_isolation on native_push_tokens as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on native_push_tokens to synapse_app;
