-- Project calls: meetings with clients or the team, held on Zoom / Google Meet / Microsoft Teams
-- (each person may connect several of their own accounts), transcripts fetched or uploaded, and an
-- analysis (summary, points discussed, requirements, decisions, actions by person).

alter table events
  add column online_meeting        jsonb,         -- { provider, integrationId, joinUrl, meetingId, meetingCode, calendarEventId }
  add column transcript_status     text not null default 'none' check (transcript_status in ('none', 'waiting', 'fetched', 'not_available', 'failed')),
  add column transcript_checks     integer not null default 0,
  add column transcript_checked_at timestamptz,
  add column external_ref          text check (length(external_ref) <= 300);
create unique index events_external_ref on events (tenant_id, external_ref) where external_ref is not null;
create index events_transcript_waiting on events (tenant_id, ends_at) where transcript_status = 'waiting';

alter table meeting_notes
  add column analysis          jsonb,
  add column analyzed_at       timestamptz,
  add column analysis_by       text check (length(analysis_by) <= 120),
  add column transcript_file_id uuid;

alter table integrations drop constraint integrations_provider_check;
alter table integrations add constraint integrations_provider_check
  check (provider in ('google', 'microsoft', 'razorpay', 'exotel', 'meta_leads', 'google_leads', 'tally', 'teams', 'slack', 'gchat', 'jira', 'azure_devops', 'asana', 'dynamics_bc', 'sap_b1', 'netsuite',
                      'zoom_meet', 'google_meet', 'ms_teams_meet'));

alter table meeting_notes drop constraint meeting_notes_transcript_source_check;
alter table meeting_notes add constraint meeting_notes_transcript_source_check check (transcript_source in ('typed', 'pasted', 'audio', 'upload', 'zoom', 'google_meet', 'ms_teams'));

-- one mailbox per person stays; meeting apps may have several accounts per person
drop index integrations_one_mailbox_per_person;
create unique index integrations_one_mailbox_per_person on integrations (tenant_id, user_id, provider)
  where user_id is not null and provider not in ('zoom_meet', 'google_meet', 'ms_teams_meet');
