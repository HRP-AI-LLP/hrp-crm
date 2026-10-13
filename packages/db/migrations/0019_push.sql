-- HRP Synapse · 0019 web push (installable app / Android TWA): device subscriptions and delivery state.

create table push_subscriptions (
  id               uuid primary key default app.uuidv7(),
  tenant_id        uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  user_id          uuid not null,
  endpoint         text not null check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh           text not null check (length(p256dh) between 80 and 100),
  auth             text not null check (length(auth) between 16 and 30),
  label            text check (length(label) <= 120),
  user_agent       text check (length(user_agent) <= 300),
  failures         integer not null default 0,
  last_success_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, endpoint),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index push_subscriptions_user on push_subscriptions (tenant_id, user_id);

alter table notifications add column pushed_at timestamptz;
-- only fresh, unpushed notifications are ever scanned (old rows never qualify)
create index notifications_unpushed on notifications (tenant_id, created_at) where pushed_at is null;
-- existing notifications are history, not news
update notifications set pushed_at = created_at where pushed_at is null;

do $$
begin
  execute 'alter table push_subscriptions enable row level security';
  execute 'alter table push_subscriptions force row level security';
  execute $p$create policy tenant_isolation on push_subscriptions as permissive for all to public
    using (tenant_id = (select app.current_tenant_id()))
    with check (tenant_id = (select app.current_tenant_id()))$p$;
  execute 'grant select, insert, update, delete on push_subscriptions to synapse_app';
end
$$;
