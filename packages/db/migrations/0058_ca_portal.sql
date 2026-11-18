-- The CA portal: a conversation on each filing between the business and its chartered accountant.
create table compliance_comments (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id() references tenants (id) on delete cascade,
  item_id     uuid not null,
  author_id   uuid default app.current_user_id(),
  body        text not null check (length(body) between 1 and 4000),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references compliance_items (tenant_id, id) on delete cascade
);
create index compliance_comments_item on compliance_comments (tenant_id, item_id, created_at);

do $$
begin
  alter table compliance_comments enable row level security;
  alter table compliance_comments force row level security;
  create policy tenant_isolation on compliance_comments as permissive for all to public
    using (tenant_id = (select app.current_tenant_id()))
    with check (tenant_id = (select app.current_tenant_id()));
  grant select, insert, update, delete on compliance_comments to synapse_app;
end
$$;
create trigger compliance_comments_audit after insert or update or delete on compliance_comments for each row execute function app.audit_row_change('compliance_comment');

