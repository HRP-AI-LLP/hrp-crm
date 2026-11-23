-- Invoices raised for a milestone belong to its project.
update invoices i set project_id = m.project_id
  from project_milestones m
 where m.tenant_id = i.tenant_id and m.invoice_id = i.id and i.project_id is null;
update invoices i set project_id = m.project_id
  from milestone_links l join project_milestones m on m.tenant_id = l.tenant_id and m.id = l.milestone_id
 where l.tenant_id = i.tenant_id and l.kind = 'invoice' and l.target_id = i.id and i.project_id is null;

-- A project's progress follows its milestones (by amount, or counted equally); tasks only without milestones.
update projects p set progress = coalesce(
    (select case when count(*) = 0 then null
                 when bool_and(coalesce(m.amount, 0) > 0) then round(100 * coalesce(sum(m.amount) filter (where m.status = 'done'), 0) / sum(m.amount), 2)
                 else round(100.0 * count(*) filter (where m.status = 'done') / count(*), 2) end
       from project_milestones m where m.tenant_id = p.tenant_id and m.project_id = p.id),
    (select round(sum(case when t.status = 'done' then 100 else t.progress end * coalesce(nullif(t.estimate_hours, 0), 1)) / nullif(sum(coalesce(nullif(t.estimate_hours, 0), 1)), 0), 2)
       from project_tasks t where t.tenant_id = p.tenant_id and t.project_id = p.id and t.parent_id is null and t.status <> 'cancelled'),
    0)
 where exists (select 1 from project_milestones m where m.tenant_id = p.tenant_id and m.project_id = p.id);
