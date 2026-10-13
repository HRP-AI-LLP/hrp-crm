-- HRP Synapse · 0006 append-only audit trail

create table audit_logs (
  id          uuid primary key default app.uuidv7(),
  tenant_id   uuid not null default app.current_tenant_id(),
  actor_id    uuid default app.current_user_id(),
  action      text not null,  -- create | update | delete | login | login_failed | logout | export | permission_change | ...
  object_key  text,
  record_id   uuid,
  changes     jsonb,
  request_id  text default app.current_request_id(),
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index audit_logs_recent on audit_logs (tenant_id, created_at desc);
create index audit_logs_record on audit_logs (tenant_id, object_key, record_id, created_at desc);

-- Immutability: nobody (including the owner) can rewrite history through normal DML.
create or replace function app.audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only (% blocked)', tg_op using errcode = 'insufficient_privilege';
end
$$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function app.audit_immutable();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function app.audit_immutable();

-- Field-level diff for UPDATE, full snapshot for INSERT/DELETE. Secrets are never captured.
create or replace function app.audit_row_change() returns trigger
language plpgsql as $$
declare
  redact constant text[] := array['password_hash', 'secret_ciphertext', 'secret', 'refresh_hash',
                                  'updated_at', 'version', 'updated_by'];
  o jsonb;
  n jsonb;
  diff jsonb := '{}'::jsonb;
  k text;
  act text;
  tid uuid;
  rid uuid;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new) - redact; act := 'create'; tid := new.tenant_id; rid := (to_jsonb(new) ->> 'id')::uuid;
    diff := n;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old) - redact; n := to_jsonb(new) - redact; tid := new.tenant_id; rid := (to_jsonb(new) ->> 'id')::uuid;
    act := case when (o ->> 'deleted_at') is null and (n ->> 'deleted_at') is not null then 'delete' else 'update' end;
    for k in select jsonb_object_keys(n) loop
      if (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
      end if;
    end loop;
    if diff = '{}'::jsonb then
      return new;
    end if;
  else
    o := to_jsonb(old) - redact; act := 'delete'; tid := old.tenant_id; rid := (to_jsonb(old) ->> 'id')::uuid;
    diff := o;
  end if;

  insert into audit_logs (tenant_id, action, object_key, record_id, changes)
  values (tid, act, coalesce(tg_argv[0], (coalesce(n, o) ->> 'object_key'), tg_table_name), rid, diff);

  return coalesce(new, old);
end
$$;

create trigger accounts_audit        after insert or update or delete on accounts        for each row execute function app.audit_row_change('account');
create trigger contacts_audit        after insert or update or delete on contacts        for each row execute function app.audit_row_change('contact');
create trigger leads_audit           after insert or update or delete on leads           for each row execute function app.audit_row_change('lead');
create trigger deals_audit           after insert or update or delete on deals           for each row execute function app.audit_row_change('deal');
create trigger records_audit         after insert or update or delete on records         for each row execute function app.audit_row_change();
create trigger tasks_audit           after insert or update or delete on tasks           for each row execute function app.audit_row_change('task');
create trigger users_audit           after insert or update or delete on users           for each row execute function app.audit_row_change('user');
create trigger roles_audit           after insert or update or delete on roles           for each row execute function app.audit_row_change('role');
create trigger custom_objects_audit  after insert or update or delete on custom_objects  for each row execute function app.audit_row_change('custom_object');
create trigger custom_fields_audit   after insert or update or delete on custom_fields   for each row execute function app.audit_row_change('custom_field');
create trigger pipelines_audit       after insert or update or delete on pipelines       for each row execute function app.audit_row_change('pipeline');
create trigger pipeline_stages_audit after insert or update or delete on pipeline_stages for each row execute function app.audit_row_change('pipeline_stage');
create trigger workflows_audit       after insert or update or delete on workflows       for each row execute function app.audit_row_change('workflow');
create trigger channel_accounts_audit after insert or update or delete on channel_accounts for each row execute function app.audit_row_change('channel_account');
