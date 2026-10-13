-- HRP Synapse · 0010 bring-your-own AI provider keys per tenant
--
-- A tenant admin can register their own model API keys (OpenAI, Anthropic, Gemini, Groq,
-- OpenRouter or any OpenAI-compatible endpoint). Keys are AES-256-GCM encrypted by the API with
-- the platform DATA_ENCRYPTION_KEY and the tenant id as additional authenticated data, so a
-- ciphertext copied into another tenant's row cannot be decrypted. Only a short hint is readable.

create table tenant_ai_providers (
  id                 uuid primary key default app.uuidv7(),
  tenant_id          uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  provider           text not null check (provider in ('openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'openai_compatible')),
  label              text not null,
  model              text not null check (length(model) between 1 and 120),
  base_url           text check (base_url is null or base_url ~ '^https://'),
  secret_ciphertext  text not null,
  key_hint           text,
  -- the tenant decides whether its own contract with this provider covers personal data
  allow_pii          boolean not null default false,
  priority           integer not null default 100,
  is_enabled         boolean not null default true,
  last_used_at       timestamptz,
  last_error         text,
  created_by         uuid default app.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id)
);
create index tenant_ai_providers_order on tenant_ai_providers (tenant_id, priority) where is_enabled;

alter table tenant_ai_providers enable row level security;
alter table tenant_ai_providers force row level security;
create policy tenant_isolation on tenant_ai_providers as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

grant select, insert, update, delete on tenant_ai_providers to synapse_app;

create trigger tenant_ai_providers_touch before update on tenant_ai_providers
  for each row execute function app.touch_row();
-- audit_row_change already redacts secret_ciphertext
create trigger tenant_ai_providers_audit after insert or update or delete on tenant_ai_providers
  for each row execute function app.audit_row_change('ai_provider');

-- Workspace vanity subdomain (<slug>.<base domain>) registered for the current tenant
create or replace function app.add_workspace_subdomain(p_hostname text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_tenant_id() is null then
    raise exception 'tenant context required';
  end if;
  insert into tenant_domains (hostname, tenant_id, kind, status)
  values (lower(p_hostname), app.current_tenant_id(), 'subdomain', 'pending')
  on conflict (hostname) do nothing;
end
$$;
revoke all on function app.add_workspace_subdomain(text) from public;
grant execute on function app.add_workspace_subdomain(text) to synapse_app;
