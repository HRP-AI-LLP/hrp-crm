/**
 * Workflow automation engine: trigger (created/updated/stage_changed/deleted) → conditions → actions.
 * Actions run as the system on behalf of the tenant; updates they make are tagged fromAutomation
 * and never re-trigger workflows (no loops).
 */
import { z } from 'zod';
import type { Env } from '../env';
import { hmacSha256Hex } from '../lib/crypto';
import type { Db } from '../lib/db';
import type { Job } from './jobs';
import { readRowSystem, type RecordCtx, type RecordEvent, updateRecord } from './records';

export const workflowConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_empty', 'not_empty', 'changed', 'changed_to']),
  value: z.unknown().optional(),
});

export const workflowActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), title: z.string().min(1).max(200), description: z.string().max(2000).optional(), dueInHours: z.number().min(0).max(24 * 365).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assignTo: z.string().optional() }),
  z.object({ type: z.literal('update_field'), field: z.string().min(1), value: z.unknown() }),
  z.object({ type: z.literal('assign_owner'), userIds: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('send_webhook'), url: z.string().url().startsWith('https://'), secret: z.string().optional() }),
  z.object({ type: z.literal('send_email'), to: z.string().default('field:email'), subject: z.string().max(300), body: z.string().max(10_000) }),
  z.object({ type: z.literal('send_whatsapp'), to: z.string().default('field:phone'), body: z.string().max(4096) }),
  z.object({ type: z.literal('ai_score') }),
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

export const workflowSchema = z.object({
  name: z.string().min(1).max(120),
  objectKey: z.string().min(1),
  triggerEvent: z.enum(['created', 'updated', 'stage_changed', 'deleted']),
  conditions: z.array(workflowConditionSchema).max(20).default([]),
  actions: z.array(workflowActionSchema).min(1).max(10),
  isEnabled: z.boolean().default(true),
});

type Flat = Record<string, unknown>;

export function flatten(row: Record<string, unknown>): Flat {
  const { custom, ...rest } = row;
  return { ...rest, ...((custom as Flat) ?? {}) };
}

export function matches(conditions: z.infer<typeof workflowConditionSchema>[], rec: Flat, changes: Record<string, [unknown, unknown]> = {}): boolean {
  return conditions.every((c) => {
    const v = rec[c.field];
    const s = (x: unknown) => (x === null || x === undefined ? '' : String(x));
    switch (c.op) {
      case 'eq':
        return s(v) === s(c.value);
      case 'neq':
        return s(v) !== s(c.value);
      case 'gt':
        return Number(v) > Number(c.value);
      case 'gte':
        return Number(v) >= Number(c.value);
      case 'lt':
        return Number(v) < Number(c.value);
      case 'lte':
        return Number(v) <= Number(c.value);
      case 'contains':
        return Array.isArray(v) ? v.map(String).includes(s(c.value)) : s(v).toLowerCase().includes(s(c.value).toLowerCase());
      case 'in':
        return Array.isArray(c.value) && c.value.map(String).includes(s(v));
      case 'is_empty':
        return s(v) === '' || (Array.isArray(v) && !v.length);
      case 'not_empty':
        return !(s(v) === '' || (Array.isArray(v) && !v.length));
      case 'changed':
        return c.field in changes;
      case 'changed_to':
        return c.field in changes && s(changes[c.field]![1]) === s(c.value);
    }
  });
}

export function render(template: string, rec: Flat): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => (rec[k] === null || rec[k] === undefined ? '' : String(rec[k])));
}

function resolveAddress(spec: string, rec: Flat): string | null {
  if (spec.startsWith('field:')) {
    const v = rec[spec.slice(6)];
    return v ? String(v) : null;
  }
  return spec;
}

export async function runWorkflows(env: Env, db: Db, ctx: Omit<RecordCtx, 'tx'>, event: RecordEvent, requestId: string | null): Promise<Job[]> {
  const followUps: Job[] = [];
  if (event.fromAutomation) return followUps;
  const sc = { tenantId: ctx.tenantId, userId: ctx.principal.user.id, requestId };

  const { workflows, row } = await db.tx({ ...sc, readOnly: true }, async (tx) => ({
    workflows: await tx.query<{ id: string; name: string; conditions: unknown; actions: unknown; run_count: number }>(
      `select id, name, conditions, actions, run_count from workflows
        where tenant_id = $1 and object_key = $2 and trigger_event = $3 and is_enabled order by created_at`,
      [ctx.tenantId, event.objectKey, event.kind],
    ),
    row: event.kind === 'deleted' ? null : await readRowSystem({ ...ctx, tx }, event.objectKey, event.recordId),
  }));
  if (!workflows.length) return followUps;
  const rec: Flat = row ? flatten(row) : { id: event.recordId };

  for (const wf of workflows) {
    const conditions = z.array(workflowConditionSchema).safeParse(wf.conditions);
    const actions = z.array(workflowActionSchema).safeParse(wf.actions);
    const started = new Date();
    if (!conditions.success || !actions.success) {
      await logRun(db, sc, wf.id, event.recordId, 'failed', null, 'invalid workflow definition', started);
      continue;
    }
    if (!matches(conditions.data, rec, event.changes)) continue;

    const output: unknown[] = [];
    try {
      for (const action of actions.data) {
        output.push(await executeAction(env, db, ctx, sc, action, event, rec, wf.run_count, followUps));
      }
      await logRun(db, sc, wf.id, event.recordId, 'success', output, null, started);
    } catch (e) {
      await logRun(db, sc, wf.id, event.recordId, 'failed', output, (e as Error).message.slice(0, 1000), started);
    }
  }
  return followUps;
}

async function logRun(db: Db, sc: { tenantId: string; userId: string | null; requestId: string | null }, workflowId: string, recordId: string, status: string, output: unknown, error: string | null, started: Date) {
  await db.tx(sc, async (tx) => {
    await tx.query(
      `insert into workflow_runs (tenant_id, workflow_id, record_id, status, output, error, started_at, finished_at) values ($1,$2,$3,$4,$5,$6,$7,now())`,
      [sc.tenantId, workflowId, recordId, status, output === null ? null : JSON.stringify(output), error, started],
    );
    await tx.query(`update workflows set run_count = run_count + 1, last_run_at = now() where tenant_id = $1 and id = $2`, [sc.tenantId, workflowId]);
  });
}

async function executeAction(
  env: Env,
  db: Db,
  ctx: Omit<RecordCtx, 'tx'>,
  sc: { tenantId: string; userId: string | null; requestId: string | null },
  action: WorkflowAction,
  event: RecordEvent,
  rec: Flat,
  runCount: number,
  followUps: Job[],
): Promise<unknown> {
  switch (action.type) {
    case 'create_task': {
      const assignee = action.assignTo === 'creator' ? rec.created_by : action.assignTo && action.assignTo !== 'owner' ? action.assignTo : rec.owner_id;
      const due = action.dueInHours !== undefined ? new Date(Date.now() + action.dueInHours * 3600_000).toISOString() : null;
      const t = await db.tx(sc, (tx) =>
        tx.one<{ id: string }>(
          `insert into tasks (tenant_id, title, description, priority, due_at, assignee_id, related_object, related_id, source)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'workflow') returning id`,
          [sc.tenantId, render(action.title, rec), action.description ? render(action.description, rec) : null, action.priority ?? 'normal', due, assignee ?? null, event.objectKey, event.recordId],
        ),
      );
      return { taskId: t?.id };
    }
    case 'update_field': {
      await db.tx(sc, (tx) => updateRecord({ ...ctx, tx }, event.objectKey, event.recordId, { [action.field]: action.value }, { bypassPermissions: true, fromAutomation: true }));
      return { updated: action.field };
    }
    case 'assign_owner': {
      const owner = action.userIds[runCount % action.userIds.length]!;
      await db.tx(sc, (tx) => updateRecord({ ...ctx, tx }, event.objectKey, event.recordId, { owner_id: owner }, { bypassPermissions: true, fromAutomation: true }));
      return { owner };
    }
    case 'send_webhook': {
      const body = JSON.stringify({ event: `${event.objectKey}.${event.kind}`, tenantId: sc.tenantId, record: rec, changes: event.changes ?? {}, sentAt: new Date().toISOString() });
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'HRP-Synapse-Webhook/1' };
      if (action.secret) headers['x-synapse-signature'] = `sha256=${await hmacSha256Hex(action.secret, body)}`;
      const res = await fetch(action.url, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return { status: res.status };
    }
    case 'send_email':
    case 'send_whatsapp': {
      const channel = action.type === 'send_email' ? 'email' : 'whatsapp';
      const to = resolveAddress(action.to, rec);
      if (!to) return { skipped: 'no recipient' };
      const msg = await db.tx(sc, async (tx) => {
        const acc = await tx.one<{ id: string }>(`select id from channel_accounts where tenant_id = $1 and channel = $2 and status = 'active' order by created_at limit 1`, [sc.tenantId, channel]);
        if (!acc) return null;
        return tx.one<{ id: string }>(
          `insert into messages (tenant_id, channel_account_id, channel, direction, to_addr, subject, body, related_object, related_id)
           values ($1,$2,$3,'out',$4,$5,$6,$7,$8) returning id`,
          [sc.tenantId, acc.id, channel, to, action.type === 'send_email' ? render(action.subject, rec) : null, render(action.body, rec), event.objectKey, event.recordId],
        );
      });
      if (!msg) return { skipped: `no active ${channel} channel` };
      followUps.push({ type: 'message.send', tenantId: sc.tenantId, messageId: msg.id });
      return { messageId: msg.id };
    }
    case 'ai_score': {
      if (event.objectKey === 'lead') followUps.push({ type: 'ai.score_lead', tenantId: sc.tenantId, leadId: event.recordId });
      return { queued: event.objectKey === 'lead' };
    }
  }
}
