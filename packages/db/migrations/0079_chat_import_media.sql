-- Exported chats uploaded with their media: read from a chosen date (all of an export by default).
alter table project_chats add column read_since timestamptz;
