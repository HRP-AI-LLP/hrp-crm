-- the chat messages (and their photos, voice notes, files) a WhatsApp suggestion rests on
alter table project_chat_proposals add column message_ids uuid[] not null default '{}';
