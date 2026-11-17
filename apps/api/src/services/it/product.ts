/**
 * Product management: products with a vision; a roadmap of features scored with RICE (reach × impact ×
 * confidence ÷ effort) and planned by quarter; customer feature requests linked to roadmap items (each
 * request is a vote, weighted by how important it is to that customer and what they pay); items turned
 * into project work and shipped in releases; a public roadmap link.
 *
 * Also the client portal: a read-only page per project for the customer (progress, milestones, the
 * running sprint, releases and their notes) where they can approve or reject change requests.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { Tx } from '../../lib/db';
import { createTask, projectAccess } from '../projects';
import type { RecordCtx } from '../records';
import { changeRequestAction } from './contracts';
import { r2, today } from './common';

const token = () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function canManage(ctx: RecordCtx) {
  return hasAdmin(ctx.principal.permissions, 'projects') || objectPerm(ctx.principal.permissions, 'project').update === 'all';
}
function assertPm(ctx: RecordCtx) {
  if (!canManage(ctx)) throw forbidden('Product management needs the projects admin permission');
}
function assertView(ctx: RecordCtx) {
  if (!canManage(ctx) && objectPerm(ctx.principal.permissions, 'project').read === 'none') throw forbidden();
}

/** RICE score: reach × impact × confidence% ÷ effort (person-months). */
export const rice = (i: { reach: number | null; impact: number | null; confidence: number | null; effort: number | null }) =>
  i.reach != null && i.impact != null && i.confidence != null && i.effort ? r2((i.reach * i.impact * (i.confidence / 100)) / i.effort) : null;

/* ───────────── products ───────────── */

export async function listProducts(ctx: RecordCtx) {
  assertView(ctx);
  return ctx.tx.query(
    `select p.id, p.name, p.key, p.description, p.vision, p.owner_id, u.full_name as owner_name, p.project_id, pr.name as project_name, p.public_token, p.created_at,
            (select count(*)::int from pm_items i where i.tenant_id = p.tenant_id and i.product_id = p.id and i.status not in ('released','declined')) as open_items,
            (select count(*)::int from pm_requests r where r.tenant_id = p.tenant_id and r.product_id = p.id and r.status = 'new') as new_requests
       from pm_products p left join users u on u.tenant_id = p.tenant_id and u.id = p.owner_id left join projects pr on pr.tenant_id = p.tenant_id and pr.id = p.project_id
      where p.tenant_id = $1 order by p.name`,
    [ctx.tenantId],
  );
}

export async function saveProduct(ctx: RecordCtx, id: string | null, input: { name: string; key?: string | null; description?: string | null; vision?: string | null; ownerId?: string | null; projectId?: string | null }) {
  assertPm(ctx);
  if (input.projectId && !(await ctx.tx.one(`select 1 from projects where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.projectId]))) throw badRequest('Project not found');
  const vals = [input.name, input.key?.toUpperCase() || null, input.description ?? null, input.vision ?? null, input.ownerId ?? ctx.principal.user.id, input.projectId ?? null];
  if (id) {
    const r = await ctx.tx.one(`update pm_products set name = $3, key = $4, description = $5, vision = $6, owner_id = $7, project_id = $8 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, ...vals]);
    if (!r) throw notFound('Product not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_products (tenant_id, name, key, description, vision, owner_id, project_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [ctx.tenantId, ...vals]);
  return { id: r!.id };
}

/** Turns the public roadmap link on (a new link each time) or off. */
export async function shareRoadmap(ctx: RecordCtx, id: string, on: boolean) {
  assertPm(ctx);
  const r = await ctx.tx.one<{ public_token: string | null }>(`update pm_products set public_token = $3 where tenant_id = $1 and id = $2 returning public_token`, [ctx.tenantId, id, on ? token() : null]);
  if (!r) throw notFound('Product not found');
  return { token: r.public_token };
}

/* ───────────── roadmap items ───────────── */

export interface ItemInput {
  title: string;
  description?: string | null;
  kind?: 'feature' | 'improvement' | 'bug' | 'tech_debt' | 'integration';
  status?: 'idea' | 'under_review' | 'planned' | 'in_progress' | 'released' | 'declined';
  quarter?: string | null;
  reach?: number | null;
  impact?: number | null;
  confidence?: number | null;
  effort?: number | null;
  releaseId?: string | null;
  public?: boolean;
}

export async function roadmap(ctx: RecordCtx, productId: string) {
  assertView(ctx);
  const p = await ctx.tx.one<Record<string, any>>(`select id, name, key, description, vision, project_id, public_token from pm_products where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]);
  if (!p) throw notFound('Product not found');
  const items = await ctx.tx.query<Record<string, any>>(
    `select i.id, i.item_number, i.title, i.description, i.kind, i.status, i.quarter, i.reach, i.impact::float8 as impact, i.confidence, i.effort::float8 as effort, i.public,
            i.release_id, r.name as release_name, r.version as release_version, r.status as release_status, i.task_id, t.task_number, t.status as task_status, t.project_id as task_project_id,
            count(q.id)::int as votes,
            count(q.id) filter (where q.importance = 'critical')::int as critical,
            coalesce(sum(case q.importance when 'critical' then 3 when 'important' then 2 else 1 end), 0)::int as weight,
            coalesce((select sum(s.mrr) from saas_subscriptions s where s.tenant_id = i.tenant_id and s.status in ('active','past_due') and s.account_id in (select account_id from pm_requests x where x.tenant_id = i.tenant_id and x.item_id = i.id)), 0)::float8 as mrr_asking,
            i.created_at, i.updated_at
       from pm_items i left join pm_requests q on q.tenant_id = i.tenant_id and q.item_id = i.id
       left join project_releases r on r.tenant_id = i.tenant_id and r.id = i.release_id
       left join project_tasks t on t.tenant_id = i.tenant_id and t.id = i.task_id
      where i.tenant_id = $1 and i.product_id = $2 group by i.id, r.id, t.id order by i.item_number`,
    [ctx.tenantId, productId],
  );
  for (const i of items) i.score = rice(i as never);
  const requests = await ctx.tx.query(
    `select q.id, q.item_id, q.title, q.description, q.source, q.importance, q.status, q.contact_name, q.account_id, a.name as account_name, q.created_at
       from pm_requests q left join accounts a on a.tenant_id = q.tenant_id and a.id = q.account_id where q.tenant_id = $1 and q.product_id = $2 order by q.created_at desc limit 500`,
    [ctx.tenantId, productId],
  );
  const releases = p.project_id
    ? await ctx.tx.query(`select id, name, version, status, target_date::text, released_at::text from project_releases where tenant_id = $1 and project_id = $2 order by coalesce(target_date, released_at, '2100-01-01')`, [ctx.tenantId, p.project_id])
    : [];
  return { product: p, items, requests, releases };
}

async function checkRelease(ctx: RecordCtx, productId: string, releaseId: string | null | undefined) {
  if (!releaseId) return;
  const ok = await ctx.tx.one(
    `select 1 from project_releases r join pm_products p on p.tenant_id = r.tenant_id and p.id = $3 where r.tenant_id = $1 and r.id = $2 and (p.project_id is null or r.project_id = p.project_id)`,
    [ctx.tenantId, releaseId, productId],
  );
  if (!ok) throw badRequest('Release not found in the product\'s project');
}

export async function saveItem(ctx: RecordCtx, productId: string, id: string | null, input: ItemInput) {
  assertPm(ctx);
  if (!(await ctx.tx.one(`select 1 from pm_products where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]))) throw notFound('Product not found');
  await checkRelease(ctx, productId, input.releaseId);
  const vals = [
    input.title, input.description ?? null, input.kind ?? 'feature', input.status ?? 'idea', input.quarter ?? null, input.reach ?? null, input.impact ?? null, input.confidence ?? null,
    input.effort ?? null, input.releaseId ?? null, input.public ?? true,
  ];
  if (id) {
    const r = await ctx.tx.one(
      `update pm_items set title = $4, description = $5, kind = $6, status = $7, quarter = $8, reach = $9, impact = $10, confidence = $11, effort = $12, release_id = $13, public = $14, updated_at = now()
        where tenant_id = $1 and id = $2 and product_id = $3 returning id`,
      [ctx.tenantId, id, productId, ...vals],
    );
    if (!r) throw notFound('Roadmap item not found');
    return { id };
  }
  await ctx.tx.query(`select 1 from pm_products where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, productId]);
  const n = (await ctx.tx.one<{ n: number }>(`select coalesce(max(item_number), 0) + 1 as n from pm_items where tenant_id = $1 and product_id = $2`, [ctx.tenantId, productId]))!.n;
  const r = await ctx.tx.one<{ id: string }>(
    `insert into pm_items (tenant_id, product_id, item_number, title, description, kind, status, quarter, reach, impact, confidence, effort, release_id, public)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [ctx.tenantId, productId, n, ...vals],
  );
  return { id: r!.id, number: n };
}

export async function deleteItem(ctx: RecordCtx, productId: string, id: string) {
  assertPm(ctx);
  await ctx.tx.query(`delete from pm_items where tenant_id = $1 and id = $2 and product_id = $3`, [ctx.tenantId, id, productId]);
}

/** Makes a roadmap item project work: a story (or epic) in the product's project backlog. */
export async function itemToWork(ctx: RecordCtx, productId: string, id: string, asEpic = false) {
  assertPm(ctx);
  const i = await ctx.tx.one<{ title: string; description: string | null; kind: string; task_id: string | null; release_id: string | null; project_id: string | null; item_number: number; key: string | null }>(
    `select i.title, i.description, i.kind, i.task_id, i.release_id, p.project_id, i.item_number, p.key from pm_items i join pm_products p on p.tenant_id = i.tenant_id and p.id = i.product_id
      where i.tenant_id = $1 and i.id = $2 and i.product_id = $3 for update of i`,
    [ctx.tenantId, id, productId],
  );
  if (!i) throw notFound('Roadmap item not found');
  if (!i.project_id) throw badRequest('Link the product to a project first');
  if (i.task_id) throw badRequest('This item is already project work');
  const t = await createTask(ctx, i.project_id, { name: i.title.slice(0, 300), description: `${i.description ?? ''}\n\nRoadmap ${i.key ? `${i.key}-` : '#'}${i.item_number}`.trim(), status: 'open', priority: 'medium' });
  await ctx.tx.query(`update project_tasks set work_type = $3, release_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, t.id, asEpic ? 'epic' : i.kind === 'bug' ? 'bug' : 'story', i.release_id]);
  await ctx.tx.query(`update pm_items set task_id = $3, status = case when status in ('idea','under_review') then 'planned' else status end, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, t.id]);
  return { taskId: t.id, number: t.number, projectId: i.project_id };
}

/* ───────────── feature requests ───────────── */

export async function saveRequest(ctx: RecordCtx, productId: string, id: string | null, input: { title: string; description?: string | null; accountId?: string | null; contactName?: string | null; source?: string; importance?: string; itemId?: string | null }) {
  // anyone working with customers may log what they ask for
  if (!canManage(ctx) && objectPerm(ctx.principal.permissions, 'account').read === 'none') throw forbidden();
  if (!(await ctx.tx.one(`select 1 from pm_products where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]))) throw notFound('Product not found');
  if (input.itemId && !(await ctx.tx.one(`select 1 from pm_items where tenant_id = $1 and id = $2 and product_id = $3`, [ctx.tenantId, input.itemId, productId]))) throw badRequest('Roadmap item not found');
  if (input.accountId && !(await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.accountId]))) throw badRequest('Customer not found');
  const status = input.itemId ? 'linked' : 'new';
  const vals = [input.title, input.description ?? null, input.accountId ?? null, input.contactName ?? null, input.source ?? 'sales', input.importance ?? 'nice_to_have', input.itemId ?? null, status];
  if (id) {
    if (!canManage(ctx)) throw forbidden('Only product managers change requests');
    const r = await ctx.tx.one(
      `update pm_requests set title = $4, description = $5, account_id = $6, contact_name = $7, source = $8, importance = $9, item_id = $10, status = case when status = 'declined' and $10::uuid is null then status else $11 end
        where tenant_id = $1 and id = $2 and product_id = $3 returning id`,
      [ctx.tenantId, id, productId, ...vals],
    );
    if (!r) throw notFound('Request not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into pm_requests (tenant_id, product_id, title, description, account_id, contact_name, source, importance, item_id, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, productId, ...vals],
  );
  return { id: r!.id };
}

/** Links a request to a roadmap item (a vote), or declines it. */
export async function triageRequest(ctx: RecordCtx, productId: string, id: string, input: { itemId?: string | null; newItem?: boolean; decline?: boolean }) {
  assertPm(ctx);
  const q = await ctx.tx.one<{ title: string; description: string | null }>(`select title, description from pm_requests where tenant_id = $1 and id = $2 and product_id = $3 for update`, [ctx.tenantId, id, productId]);
  if (!q) throw notFound('Request not found');
  if (input.decline) {
    await ctx.tx.query(`update pm_requests set status = 'declined', item_id = null where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    return { status: 'declined' };
  }
  let itemId = input.itemId ?? null;
  if (input.newItem) itemId = (await saveItem(ctx, productId, null, { title: q.title, description: q.description, status: 'under_review' })).id;
  if (!itemId) throw badRequest('Choose a roadmap item');
  if (!(await ctx.tx.one(`select 1 from pm_items where tenant_id = $1 and id = $2 and product_id = $3`, [ctx.tenantId, itemId, productId]))) throw badRequest('Roadmap item not found');
  await ctx.tx.query(`update pm_requests set status = 'linked', item_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, itemId]);
  return { status: 'linked', itemId };
}

/* ───────────── public roadmap ───────────── */

export async function publicRoadmap(tx: Tx, tenantId: string, productId: string) {
  const p = await tx.one<{ name: string; description: string | null; vision: string | null }>(`select name, description, vision from pm_products where tenant_id = $1 and id = $2`, [tenantId, productId]);
  if (!p) throw notFound();
  const items = await tx.query(
    `select i.title, i.description, i.kind, i.status, i.quarter, r.name as release_name, r.version as release_version, r.released_at::text,
            (select count(*)::int from pm_requests q where q.tenant_id = i.tenant_id and q.item_id = i.id) as votes
       from pm_items i left join project_releases r on r.tenant_id = i.tenant_id and r.id = i.release_id
      where i.tenant_id = $1 and i.product_id = $2 and i.public and i.status in ('planned','in_progress','released','under_review')
      order by case i.status when 'in_progress' then 0 when 'planned' then 1 when 'under_review' then 2 else 3 end, i.quarter nulls last, i.item_number`,
    [tenantId, productId],
  );
  const company = await tx.one<{ settings: any; name: string }>(`select name, settings from tenants where id = $1`, [tenantId]);
  return { company: company?.settings?.company?.legalName ?? company?.name ?? '', product: p, items };
}

/** A customer asking for something on the public roadmap. */
export async function publicRequest(tx: Tx, tenantId: string, productId: string, input: { title: string; description?: string | null; name: string; email?: string | null }) {
  await tx.query(
    `insert into pm_requests (tenant_id, product_id, title, description, contact_name, source, importance, status, created_by) values ($1,$2,$3,$4,$5,'portal','nice_to_have','new', null)`,
    [tenantId, productId, input.title, input.description ?? null, `${input.name}${input.email ? ` <${input.email}>` : ''}`.slice(0, 200)],
  );
}

/* ───────────── client portal ───────────── */

export async function sharePortal(ctx: RecordCtx, projectId: string, on: boolean) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await ctx.tx.one<{ portal_token: string | null }>(`update projects set portal_token = $3 where tenant_id = $1 and id = $2 returning portal_token`, [ctx.tenantId, projectId, on ? token() : null]);
  return { token: r!.portal_token };
}

/** What the customer sees: progress, milestones, the running sprint, releases, change requests. */
export async function portalView(tx: Tx, tenantId: string, projectId: string) {
  const p = await tx.one<Record<string, any>>(
    `select p.name, p.project_code, p.status, p.start_date::text, p.end_date::text, p.progress::float8 as progress, p.description, a.name as account_name, u.full_name as manager
       from projects p left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id left join users u on u.tenant_id = p.tenant_id and u.id = p.owner_id
      where p.tenant_id = $1 and p.id = $2 and p.deleted_at is null`,
    [tenantId, projectId],
  );
  if (!p) throw notFound();
  // one connection: queries run one after another
  const milestones = await tx.query(`select name, start_date::text, due_date::text, status, completed_at from project_milestones where tenant_id = $1 and project_id = $2 order by position, due_date`, [tenantId, projectId]);
  const sprint = await tx.one(
      `select s.name, s.goal, s.start_date::text, s.end_date::text, coalesce(s.committed_points, 0)::float8 as committed,
              (select coalesce(sum(story_points), 0)::float8 from project_tasks t where t.tenant_id = s.tenant_id and t.sprint_id = s.id and t.status = 'done') as done,
              (select count(*)::int from project_tasks t where t.tenant_id = s.tenant_id and t.sprint_id = s.id and t.parent_id is null) as items,
              (select count(*)::int from project_tasks t where t.tenant_id = s.tenant_id and t.sprint_id = s.id and t.parent_id is null and t.status = 'done') as done_items
         from project_sprints s where s.tenant_id = $1 and s.project_id = $2 and s.status = 'active'`,
      [tenantId, projectId],
    );
  const releases = await tx.query(`select name, version, status, target_date::text, released_at::text, notes from project_releases where tenant_id = $1 and project_id = $2 and status <> 'cancelled' order by coalesce(released_at, target_date) desc nulls last limit 20`, [tenantId, projectId]);
  const crs = await tx.query(
      `select id, cr_number, title, description, reason, impact_hours::float8 as impact_hours, impact_amount::float8 as impact_amount, impact_days, status, decided_by, decided_at, decision_note
         from change_requests where tenant_id = $1 and project_id = $2 and status <> 'draft' order by cr_number desc`,
      [tenantId, projectId],
    );
  const tasks = await tx.one<{ total: number; done: number }>(`select count(*)::int as total, count(*) filter (where status = 'done')::int as done from project_tasks where tenant_id = $1 and project_id = $2 and parent_id is null`, [tenantId, projectId]);
  const company = await tx.one<{ settings: any; name: string }>(`select name, settings from tenants where id = $1`, [tenantId]);
  return { company: company?.settings?.company?.legalName ?? company?.name ?? '', project: p, milestones, sprint, releases, changeRequests: crs, tasks, asOf: today() };
}

/** The customer approves or rejects a submitted change request from the portal. */
export async function portalDecide(tx: Tx, tenantId: string, projectId: string, crId: string, input: { decision: 'approve' | 'reject'; name: string; note?: string | null }) {
  return changeRequestAction(null, projectId, crId, input.decision, { tx, tenantId, by: `${input.name} (client)`, note: input.note ?? null });
}
