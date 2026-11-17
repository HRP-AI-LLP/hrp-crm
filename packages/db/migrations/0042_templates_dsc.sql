-- 0042: document templates and digital signature certificates.
--
--  * doc_templates     how invoices (and quotes, orders, purchase orders) look: a built-in design with
--                      the workspace's colours, logo, columns and wording; the company letterhead (an
--                      image of the page, or a PDF turned into one) with the document laid inside its
--                      margins; or an HTML template with placeholders. `defaults` names the kinds of
--                      document it is the default for.
--  * dsc_certificates  digital signature certificates: a .pfx kept encrypted (never handed back) or a
--                      USB token's certificate, used through the local signer; who may sign with each
--  * document_signatures gains how a document was signed (signature image, DSC file, DSC token), the
--                      certificate, and the signed PDF kept with the record

create table doc_templates (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  base        text not null default 'classic' check (base in ('classic', 'modern', 'compact', 'gst_detailed', 'letterhead', 'html')),
  settings    jsonb not null default '{}'::jsonb check (octet_length(settings::text) <= 400000),
  letterhead  text check (letterhead ~ '^data:image/(png|jpeg|webp);base64,' and length(letterhead) <= 6000000),
  html        text check (length(html) <= 200000),
  defaults    text[] not null default '{}',
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id)
);

create table dsc_certificates (
  id            uuid primary key default app.uuidv7(),
  tenant_id     uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  label         text not null check (length(label) between 1 and 120),
  kind          text not null check (kind in ('pfx', 'token')),
  subject_cn    text not null,
  subject       text,
  issuer        text,
  serial        text not null,
  thumbprint    text not null check (thumbprint ~ '^[0-9a-f]{40}$'),
  valid_from    timestamptz not null,
  valid_to      timestamptz not null,
  -- the .pfx and its password, encrypted with the deployment key (tenant id as associated data)
  pfx_enc       text,
  pass_enc      text,
  -- the token's certificate (PEM) as the signer reported it
  cert_pem      text,
  signature_id  uuid,
  user_ids      uuid[] not null default '{}',
  is_active     boolean not null default true,
  created_by    uuid default app.current_user_id(),
  created_at    timestamptz not null default now(),
  check ((kind = 'pfx') = (pfx_enc is not null)),
  unique (tenant_id, id),
  unique (tenant_id, thumbprint),
  foreign key (tenant_id, signature_id) references signatures (tenant_id, id) on delete set null (signature_id)
);

alter table document_signatures alter column image drop not null;
alter table document_signatures add column method text not null default 'image' check (method in ('image', 'dsc_pfx', 'dsc_token'));
alter table document_signatures add column certificate_id uuid;
alter table document_signatures add column cert_subject text;
alter table document_signatures add column cert_serial text;
alter table document_signatures add column file_id uuid;
alter table document_signatures add column pdf_sha256 text check (pdf_sha256 ~ '^[0-9a-f]{64}$');
alter table document_signatures add constraint document_signatures_cert foreign key (tenant_id, certificate_id) references dsc_certificates (tenant_id, id) on delete set null (certificate_id);

-- a local signer paired with the workspace: it signs only what this workspace asks it to, proven by a
-- ticket made with the pairing secret (shown once to the person pairing it; kept encrypted here)
create table dsc_signers (
  id           uuid primary key default app.uuidv7(),
  tenant_id    uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  label        text not null check (length(label) between 1 and 120),
  secret_enc   text not null,
  created_by   uuid default app.current_user_id(),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  unique (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['doc_templates', 'dsc_certificates', 'dsc_signers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I as permissive for all to public using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format('grant select, insert, update, delete on %I to synapse_app', t);
  end loop;
end $$;
