/**
 * Approval workflow, generic over objects that carry an `approval_status` column (quotes today;
 * purchase orders and credit notes use the same engine).
 *
 *   rule matches the record  →  approval_status = 'required'  →  submit  →  'pending'
 *   approver decides         →  'approved' | 'rejected'      →  any later change  →  re-evaluated
 *
 * Approvers: the requester's manager (falls back to the workspace owner), a named user, everyone
 * holding a role, or the owner. Requesters can never approve their own request (except the owner).
 */
import { type ApprovalRuleMeta, hasAdmin, matchCriteria, storageFor } from '@synapse/shared';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { ident, loadRow, type RecordCtx, type RecordEvent, readRowSystem } from './records';

/** Objects whose table has approval_status (kept in sync with the migrations). */
export const APPROVABLE = new Set(['quote', 'purchase_order', 'invoice', 'sales_order']);

const flat = (row: Record<string, unknown>) => ({ ...row, ...((row.custom as Record<string, unknown>) ?? {}) });

export function matchingRule(ctx: RecordCtx, objectKey: string, row: Record<string, unknown>): ApprovalRuleMeta | null {
  return (ctx.meta.automation?.approval ?? []).find((r) => r.objectKey === objectKey && matchCriteria(r.criteria, flat(row))) ?? null;
}

/**
 * Re-evaluates after the record changed: cancels an open request and sets 'required' or
 * 'not_required'. An approved record stays approved only while it still matches nothing new —
 * any edit after approval needs a fresh approval when a rule applies.
 */
export async function reevaluate(ctx: RecordCtx, objectKey: string, id: string): Promise<string | null> {
  if (!APPROVABLE.has(objectKey)) return null;
  const s = storageFor(objectKey);
  const row = await readRowSystem(ctx, objectKey, id);
  if (!row) return null;
  const rule = matchingRule(ctx, objectKey, row);
  const cancelled = await ctx.tx.query(
    `update approval_requests set status = 'cancelled', decision_comment = 'Record changed after the request', decided_at = now()
      where tenant_id = $1 and object_key = $2 and record_id = $3 and status = 'pending' returning id`,
    [ctx.tenantId, objectKey, id],
  );
  const next = rule ? 'required' : 'not_required';
  if (next !== row.approval_status || cancelled.length) {
    await ctx.tx.query(`update ${ident(s.table)} set approval_status = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, next]);
  }
  return next;
}

async function resolveApprover(ctx: RecordCtx, rule: ApprovalRuleMeta, requester: string): Promise<{ userId: string | null; role: string | null }> {
  const owner = async () => (await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner and status = 'active' order by created_at limit 1`, [ctx.tenantId]))?.id ?? null;
  switch (rule.approverType) {
    case 'manager': {
      const m = await ctx.tx.one<{ manager_id: string | null }>(
        `select u.manager_id from users u join users m on m.tenant_id = u.tenant_id and m.id = u.manager_id and m.status = 'active' where u.tenant_id = $1 and u.id = $2`,
        [ctx.tenantId, requester],
      );
      return { userId: m?.manager_id ?? (await owner()), role: null };
    }
    case 'user':
      return { userId: rule.approverId, role: null };
    case 'role':
      return { userId: null, role: rule.approverRole };
    default:
      return { userId: await owner(), role: null };
  }
}

async function approverUserIds(ctx: RecordCtx, approverId: string | null, role: string | null): Promise<string[]> {
  if (approverId) return [approverId];
  if (!role) return [];
  const rows = await ctx.tx.query<{ id: string }>(
    `select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where u.tenant_id = $1 and r.key = $2 and u.status = 'active'`,
    [ctx.tenantId, role],
  );
  return rows.map((r) => r.id);
}

function summaryOf(objectKey: string, row: Record<string, unknown>) {
  const pick = ['quote_number', 'order_number', 'po_number', 'invoice_number', 'grand_total', 'subtotal', 'discount_total', 'max_discount_pct', 'currency'];
  const out: Record<string, unknown> = { title: row[storageFor(objectKey).titleColumn] ?? null };
  for (const k of pick) if (row[k] !== undefined && row[k] !== null) out[k] = typeof row[k] === 'string' && /^-?\d+(\.\d+)?$/.test(row[k] as string) ? Number(row[k]) : row[k];
  return out;
}

async function notify(ctx: RecordCtx, users: string[], title: string, body: string | null, link: string) {
  for (const u of new Set(users)) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'approval',$3,$4,$5)`, [ctx.tenantId, u, title, body, link]);
  }
}

export async function submitForApproval(ctx: RecordCtx, objectKey: string, id: string, note: string | null): Promise<RecordEvent[]> {
  if (!APPROVABLE.has(objectKey)) throw badRequest('This record type has no approvals');
  const { obj, row } = await loadRow(ctx, objectKey, id, 'update', true);
  const rule = matchingRule(ctx, objectKey, row);
  if (!rule) {
    await reevaluate(ctx, objectKey, id);
    throw badRequest('No approval is needed for this record');
  }
  if (row.approval_status === 'pending') throw conflict('An approval request is already pending');
  if (row.approval_status === 'approved') throw conflict('This record is already approved');
  const requester = ctx.principal.user.id;
  const ap = await resolveApprover(ctx, rule, requester);
  if (!ap.userId && !ap.role) throw badRequest('No approver is configured for this rule');
  const s = storageFor(objectKey);
  const req = await ctx.tx.one<{ id: string }>(
    `insert into approval_requests (tenant_id, object_key, record_id, rule_id, rule_name, requested_by, approver_id, approver_role, note, summary)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, objectKey, id, rule.id, rule.name, requester, ap.userId, ap.role, note, JSON.stringify(summaryOf(objectKey, row))],
  );
  await ctx.tx.query(`update ${ident(s.table)} set approval_status = 'pending' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const title = String(row[s.titleColumn] ?? obj.label);
  await ctx.tx.query(
    `insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1,'system',$2,$3,$4,$5,$6)`,
    [ctx.tenantId, `Sent for approval (${rule.name})`, note, objectKey, id, JSON.stringify({ approvalRequestId: req!.id })],
  );
  await notify(ctx, (await approverUserIds(ctx, ap.userId, ap.role)).filter((u) => u !== requester), `Approval needed: ${title}`, `${ctx.principal.user.fullName} · ${rule.name}${note ? ` — ${note}` : ''}`, `/approvals?request=${req!.id}`);
  return [{ objectKey, recordId: id, kind: 'updated', changes: { approval_status: [row.approval_status, 'pending'] } }];
}

async function canDecide(ctx: RecordCtx, r: { approver_id: string | null; approver_role: string | null; requested_by: string | null }) {
  const me = ctx.principal.user;
  if (r.requested_by === me.id && !me.isOwner) return false;
  if (me.isOwner) return true;
  if (r.approver_id) return r.approver_id === me.id;
  return !!r.approver_role && me.roles.includes(r.approver_role);
}

export async function decide(ctx: RecordCtx, requestId: string, approve: boolean, comment: string | null): Promise<RecordEvent[]> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw notFound();
  const r = await ctx.tx.one<{ id: string; object_key: string; record_id: string; status: string; approver_id: string | null; approver_role: string | null; requested_by: string | null; rule_name: string }>(
    `select * from approval_requests where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, requestId],
  );
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict(`This request was already ${r.status}`);
  if (!(await canDecide(ctx, r))) throw forbidden('You are not the approver for this request');
  const status = approve ? 'approved' : 'rejected';
  await ctx.tx.query(`update approval_requests set status = $3, decision_comment = $4, decided_by = $5, decided_at = now() where tenant_id = $1 and id = $2`, [
    ctx.tenantId, requestId, status, comment, ctx.principal.user.id,
  ]);
  const s = storageFor(r.object_key);
  const row = await ctx.tx.one<Record<string, unknown>>(`update ${ident(s.table)} set approval_status = $3 where tenant_id = $1 and id = $2 returning *`, [ctx.tenantId, r.record_id, status]);
  const title = String(row?.[s.titleColumn] ?? '');
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1,'system',$2,$3,$4,$5,$6)`, [
    ctx.tenantId, `${approve ? 'Approved' : 'Rejected'} by ${ctx.principal.user.fullName}`, comment, r.object_key, r.record_id, JSON.stringify({ approvalRequestId: requestId }),
  ]);
  if (r.requested_by) await notify(ctx, [r.requested_by], `${approve ? 'Approved' : 'Rejected'}: ${title}`, comment ?? `${ctx.principal.user.fullName} · ${r.rule_name}`, `/o/${r.object_key}/${r.record_id}`);
  return [{ objectKey: r.object_key, recordId: r.record_id, kind: 'updated', changes: { approval_status: ['pending', status] } }];
}

export async function recallRequest(ctx: RecordCtx, requestId: string) {
  const r = await ctx.tx.one<{ id: string; object_key: string; record_id: string; status: string; requested_by: string | null }>(
    `select * from approval_requests where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, requestId],
  );
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('Only pending requests can be recalled');
  if (r.requested_by !== ctx.principal.user.id && !ctx.principal.user.isOwner) throw forbidden();
  await ctx.tx.query(`update approval_requests set status = 'cancelled', decided_by = $3, decided_at = now(), decision_comment = 'Recalled' where tenant_id = $1 and id = $2`, [ctx.tenantId, requestId, ctx.principal.user.id]);
  await reevaluate(ctx, r.object_key, r.record_id);
  return { ok: true };
}

/** Approval inbox: waiting for me, requested by me, or (owner/admin) everything. */
export async function listApprovals(ctx: RecordCtx, box: 'inbox' | 'mine' | 'all', status: string | null) {
  const me = ctx.principal.user;
  const where = ['a.tenant_id = $1'];
  const vals: unknown[] = [ctx.tenantId];
  if (status) {
    vals.push(status);
    where.push(`a.status = $${vals.length}`);
  }
  if (box === 'inbox') {
    vals.push(me.id, me.roles);
    where.push(`(a.approver_id = $${vals.length - 1} or a.approver_role = any($${vals.length}::text[])${me.isOwner ? ' or true' : ''}) and a.requested_by is distinct from $${vals.length - 1}`);
  } else if (box === 'mine') {
    vals.push(me.id);
    where.push(`a.requested_by = $${vals.length}`);
  } else if (!me.isOwner && !hasAdmin(ctx.principal.permissions, 'workflows')) {
    throw forbidden();
  }
  const rows = await ctx.tx.query<Record<string, unknown>>(
    `select a.*, rq.full_name as requested_by_name, ap.full_name as approver_name, dc.full_name as decided_by_name
       from approval_requests a
       left join users rq on rq.tenant_id = a.tenant_id and rq.id = a.requested_by
       left join users ap on ap.tenant_id = a.tenant_id and ap.id = a.approver_id
       left join users dc on dc.tenant_id = a.tenant_id and dc.id = a.decided_by
      where ${where.join(' and ')}
      order by (a.status = 'pending') desc, a.created_at desc limit 200`,
    vals,
  );
  return rows.map((r) => ({
    id: r.id,
    objectKey: r.object_key,
    recordId: r.record_id,
    ruleName: r.rule_name,
    status: r.status,
    note: r.note,
    summary: r.summary,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    approverId: r.approver_id,
    approverRole: r.approver_role,
    approverName: r.approver_name,
    decisionComment: r.decision_comment,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    canDecide: r.status === 'pending' && (me.isOwner ? true : r.requested_by !== me.id && (r.approver_id === me.id || (!!r.approver_role && me.roles.includes(String(r.approver_role))))),
  }));
}

export async function approvalHistory(ctx: RecordCtx, objectKey: string, id: string) {
  await loadRow(ctx, objectKey, id, 'read');
  return ctx.tx.query(
    `select a.id, a.status, a.rule_name, a.note, a.decision_comment, a.created_at, a.decided_at, rq.full_name as requested_by_name, dc.full_name as decided_by_name,
            coalesce(ap.full_name, a.approver_role) as approver
       from approval_requests a
       left join users rq on rq.tenant_id = a.tenant_id and rq.id = a.requested_by
       left join users ap on ap.tenant_id = a.tenant_id and ap.id = a.approver_id
       left join users dc on dc.tenant_id = a.tenant_id and dc.id = a.decided_by
      where a.tenant_id = $1 and a.object_key = $2 and a.record_id = $3 order by a.created_at desc limit 50`,
    [ctx.tenantId, objectKey, id],
  );
}

/** Guard used before a record leaves the building (sending a quote, issuing a PO). */
export function assertApproved(row: Record<string, unknown>, what: string) {
  if (row.approval_status === 'required' || row.approval_status === 'rejected') throw badRequest(`This ${what} needs approval first. Submit it for approval.`);
  if (row.approval_status === 'pending') throw badRequest(`This ${what} is waiting for approval.`);
}

