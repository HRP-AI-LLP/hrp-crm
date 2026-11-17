-- Every journal now gets a voucher number (JV/<FY>/0001) when posted, not only manual and opening
-- entries. Entries posted before this are numbered here, in date order within each financial year,
-- after the numbers already given.

-- a journal without a number may be given one, once (posted entries are otherwise immutable)
create or replace function app.guard_journal() returns trigger
language plpgsql as $$
declare lock date;
begin
  select lock_date into lock from books_config where tenant_id = coalesce(new.tenant_id, old.tenant_id);
  if tg_op = 'INSERT' then
    if lock is not null and new.entry_date <= lock then
      raise exception 'the books are locked up to %', lock using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'journals cannot be deleted; void them instead' using errcode = 'check_violation';
  end if;
  if old.number is null and new.number is not null
     and (to_jsonb(new) - 'number') = (to_jsonb(old) - 'number') then
    return new;
  end if;
  if old.status = 'void' then
    raise exception 'a void journal cannot change' using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - array['status', 'void_reason', 'voided_at']) is distinct from (to_jsonb(old) - array['status', 'void_reason', 'voided_at']) then
    raise exception 'posted journals cannot be edited; void and re-post' using errcode = 'check_violation';
  end if;
  if lock is not null and old.entry_date <= lock then
    raise exception 'the books are locked up to %', lock using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$
declare t uuid;
begin
  for t in select distinct tenant_id from journals loop
    perform set_config('app.tenant_id', t::text, true);
    with j as (
      select id, created_at, entry_date,
             case when extract(month from entry_date) >= 4 then extract(year from entry_date)::int else extract(year from entry_date)::int - 1 end as y
        from journals where tenant_id = t and number is null
    ), f as (
      select j.*, lpad((y % 100)::text, 2, '0') || '-' || lpad(((y + 1) % 100)::text, 2, '0') as fy from j
    ), n as (
      select f.id, f.fy,
             coalesce((select value from tenant_counters c where c.tenant_id = t and c.key = 'journal:' || f.fy), 0)
               + row_number() over (partition by f.fy order by f.entry_date, f.created_at, f.id) as seq
        from f
    ), upd as (
      update journals x set number = 'JV/' || n.fy || '/' || lpad(n.seq::text, 4, '0')
        from n where x.tenant_id = t and x.id = n.id
      returning n.fy, n.seq
    )
    insert into tenant_counters (tenant_id, key, value)
    select t, 'journal:' || fy, max(seq) from upd group by fy
    on conflict (tenant_id, key) do update set value = greatest(tenant_counters.value, excluded.value);
  end loop;
  perform set_config('app.tenant_id', '', true);
end
$$;
