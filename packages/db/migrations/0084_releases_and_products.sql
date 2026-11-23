-- Releases: what kind (major, minor, patch, hotfix, pre-release, maintenance), the milestone it
-- delivers and the sprints that feed it, where its version number was read from — and how it reaches
-- people: a web deployment, a Windows installer sent by mail or shared on Google Drive / OneDrive /
-- SharePoint, an app on Google Play or the App Store…
alter table project_releases
  add column release_type   text not null default 'minor' check (release_type in ('major', 'minor', 'patch', 'hotfix', 'prerelease', 'maintenance')),
  add column milestone_id   uuid,
  add column version_source text check (length(version_source) <= 300),
  add column created_by     uuid default app.current_user_id(),
  add foreign key (tenant_id, milestone_id) references project_milestones (tenant_id, id) on delete set null (milestone_id);

alter table project_sprints
  add column release_id uuid,
  add foreign key (tenant_id, release_id) references project_releases (tenant_id, id) on delete set null (release_id);

create table project_release_channels (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  project_id  uuid not null,
  release_id  uuid not null,
  platform    text not null check (platform in ('web', 'windows', 'macos', 'linux', 'android', 'ios', 'api', 'other')),
  method      text not null check (method in ('deploy', 'email', 'google_drive', 'onedrive', 'sharepoint', 'download_link', 'play_store', 'app_store', 'testflight', 'microsoft_store', 'other')),
  target      text check (length(target) <= 300),      -- environment, store track, folder, audience
  url         text check (length(url) <= 1000),        -- the site, the shared link, the store listing
  build_ref   text check (length(build_ref) <= 120),   -- build number, version code, file version
  recipients  text check (length(recipients) <= 4000), -- who it was sent / shared to
  file_ids    uuid[] not null default '{}',            -- the installer, APK / AAB, IPA …
  checklist   jsonb not null default '[]'::jsonb,      -- [{ "label": "...", "done": true }]
  status      text not null default 'planned' check (status in ('planned', 'in_progress', 'in_review', 'done', 'failed', 'rejected')),
  notes       text check (length(notes) <= 4000),
  done_at     timestamptz,
  created_by  uuid default app.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, release_id) references project_releases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade
);
create index project_release_channels_release on project_release_channels (tenant_id, release_id);
alter table project_release_channels enable row level security;
alter table project_release_channels force row level security;
create policy tenant_isolation on project_release_channels as permissive for all to public
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
grant select, insert, update, delete on project_release_channels to synapse_app;

-- Projects: for a client, or the company's own product (in-house), and what is being built.
alter table projects
  add column project_kind text not null default 'client' check (project_kind in ('client', 'in_house')),
  add column product_type text check (product_type in ('web_app', 'saas', 'website', 'mobile_app', 'mobile_game', 'desktop_app', 'api_service', 'data_ai', 'iot_embedded', 'erp_implementation', 'other'));
