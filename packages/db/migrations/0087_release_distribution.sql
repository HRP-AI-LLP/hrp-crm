-- Publishing a release channel: upload the build to a chosen Google Drive account, set who can open
-- it, and send the link to a linked person on WhatsApp. A build that carries client data is shared
-- only with the chosen recipient, never "anyone with the link".
alter table project_release_channels
  add column if not exists drive_account_id uuid,                  -- which connected Google account uploads it
  add column if not exists drive_folder_id text,                   -- the destination folder in that Drive
  add column if not exists drive_file_id text,                     -- the uploaded file, once done
  add column if not exists contains_client_data boolean not null default true,  -- the installer bundles the member database
  add column if not exists share_access text not null default 'restricted'
    check (share_access in ('restricted', 'public')),             -- restricted: only the recipient; public: anyone with the link
  add column if not exists recipient_object text,                  -- the linked person's record (contact, account, lead…)
  add column if not exists recipient_id uuid,
  add column if not exists delivered_at timestamptz,
  add column if not exists wa_message_id uuid;                     -- the WhatsApp message that carried the link

-- a build that carries client data is never world-readable
alter table project_release_channels drop constraint if exists release_channel_data_not_public;
alter table project_release_channels add constraint release_channel_data_not_public
  check (not (contains_client_data and share_access = 'public'));
