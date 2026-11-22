/**
 * Revenue intelligence API: agents, the Copilot workspace, action items, AI suggestions,
 * insights, scores, meetings (notes, transcripts, prep and debrief), competitors and
 * "Ask SanchalanOS". Everything runs as the signed-in person and only touches what they can see.
 */
import { AGENTS, fieldAccess, objectPerm } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { actAs } from '../services/system';
import { requireAdmin, scope } from '../middleware';
import { AiUnavailableError } from '../services/ai/router';
import { enqueue, eventJobs } from '../services/jobs';
import { loadRow, type RecordCtx, updateRecord } from '../services/records';
import { type AgentEnv, focusList, loadEvent, runAgent, settingsOf } from '../services/intel/agents';
import { askSynapse } from '../services/intel/ask';
import { buildContext, canRead, visibleIds } from '../services/intel/context';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const RECORD_OBJECTS = ['lead', 'contact', 'account', 'deal'] as const;

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const agentEnv = (c: { env: AppEnv['Bindings']; var: AppEnv['Variables'] }): AgentEnv => ({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, principal: c.var.principal, meta: c.var.meta, requestId: c.var.requestId });

/** May the caller see runs, items and suggestions about this subject? */
async function assertSubject(ctx: RecordCtx, object: string, id: string, write = false) {
  if (object === 'event') return loadEvent(ctx, id, write);
  if (object === 'call') {
    const a = await ctx.tx.one<{ related_object: string; related_id: string }>(`select related_object, related_id from activities where tenant_id = $1 and id = $2 and kind = 'call'`, [ctx.tenantId, id]);
    if (!a) throw notFound();
    return loadRow(ctx, a.related_object, a.related_id, write ? 'update' : 'read');
  }
  return loadRow(ctx, object, id, write ? 'update' : 'read');
}

/** Transcribes audio with Workers AI Whisper. */
async function transcribe(env: AppEnv['Bindings'], bytes: Uint8Array): Promise<string> {
  if (!env.AI) throw new AiUnavailableError([{ provider: 'workers-ai', error: 'speech-to-text needs Workers AI' }]);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const out = (await env.AI.run((env.AI_MODEL_WHISPER ?? '@cf/openai/whisper-large-v3-turbo') as never, { audio: btoa(bin) } as never)) as { text?: string };
  const text = String(out?.text ?? '').trim();
  if (!text) throw badRequest('No speech was recognised in this recording');
  return text;
}
const MAX_AUDIO = 20 * 1024 * 1024;
/** Reads the upload with a hard cap (a chunked body has no Content-Length to check up front). */
async function readAudio(c: { req: { header: (n: string) => string | undefined; raw: Request } }) {
  if (Number(c.req.header('content-length') ?? 0) > MAX_AUDIO) throw badRequest('Recordings can be at most 20 MB (about 20 minutes)');
  const type = c.req.header('content-type') ?? '';
  if (!/^(audio|video)\//.test(type) && type !== 'application/octet-stream') throw badRequest('Upload an audio file (mp3, m4a, wav, ogg or webm)');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw badRequest('The recording is empty');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AUDIO) {
      await reader.cancel().catch(() => undefined);
      throw badRequest('Recordings can be at most 20 MB (about 20 minutes)');
    }
    parts.push(value);
  }
  if (!size) throw badRequest('The recording is empty');
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (bytes.set(p, at), (at += p.byteLength));
  return bytes;
}

/** Transcriptions count against the workspace's daily platform AI allowance. */
async function chargeTranscription(c: { env: AppEnv['Bindings']; var: AppEnv['Variables'] }) {
  const limit = Number(c.env.AI_DAILY_LIMIT_PER_TENANT ?? 300);
  await c.var.db.tx(scope(c), async (tx) => {
    const used = await tx.one<{ n: number }>(`select count(*)::int as n from ai_usage where tenant_id = $1 and created_at > now() - interval '1 day' and ok and provider not like 'tenant:%'`, [c.var.tenant.id]);
    if ((used?.n ?? 0) >= limit) throw tooMany('Daily AI limit reached for this workspace');
    await tx.query(`insert into ai_usage (tenant_id, task, provider, model, ok) values ($1, 'transcribe', 'workers-ai', $2, true)`, [c.var.tenant.id, c.env.AI_MODEL_WHISPER ?? '@cf/openai/whisper-large-v3-turbo']);
  });
}

const itemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(4000).nullish(),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  ownerId: uuid.nullish(),
  relatedObject: z.enum(RECORD_OBJECTS).nullish(),
  relatedId: uuid.nullish(),
});

const competitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  website: z.string().max(300).nullish(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  description: z.string().max(4000).nullish(),
  strengths: z.string().max(4000).nullish(),
  weaknesses: z.string().max(4000).nullish(),
  pricingNotes: z.string().max(4000).nullish(),
  howWeWin: z.string().max(4000).nullish(),
  isActive: z.boolean().default(true),
});

export const intelRoutes = new Hono<AppEnv>()
  // ============================================================================ agents
  .get('/agents', async (c) => {
    const rows = await c.var.db.tx(scope(c, true), (tx) => tx.query<{ agent_key: string; enabled: boolean; auto_run: boolean }>(`select agent_key, enabled, auto_run from agent_settings where tenant_id = $1`, [c.var.tenant.id]));
    return c.json({ items: AGENTS.map((a) => ({ ...a, enabled: rows.find((r) => r.agent_key === a.key)?.enabled ?? true, autoRunOn: rows.find((r) => r.agent_key === a.key)?.auto_run ?? false })) });
  })
  .post('/agents/:key/run', async (c) => {
    const b = z
      .object({
        object: z.enum(['lead', 'contact', 'account', 'deal', 'event', 'call']).optional(),
        id: uuid.optional(),
        notes: z.string().max(20_000).optional(),
        transcript: z.string().max(200_000).optional(),
        intent: z.string().max(500).optional(),
        channel: z.enum(['email', 'whatsapp']).optional(),
        useAi: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const subject = b.object && b.id ? { object: b.object, id: b.id } : null;
    const r = await runAgent(agentEnv(c), c.req.param('key'), subject, { notes: b.notes, transcript: b.transcript, intent: b.intent, channel: b.channel }, { useAi: b.useAi });
    return c.json(r, 201);
  })
  .get('/runs', async (c) => {
    const q = z.object({ object: z.string().max(40), id: uuid.optional(), agent: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(c.req.query());
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      if (q.object === 'me' || q.object === 'team') {
        return tx.query(`select id, agent_key, trigger, subject_object, subject_id, status, output, citations, ai_used, model, started_at from agent_runs where tenant_id = $1 and subject_object = $2 and requested_by = $3 and ($4::text is null or agent_key = $4) order by started_at desc limit $5`, [c.var.tenant.id, q.object, c.var.principal.user.id, q.agent ?? null, q.limit]);
      }
      if (!q.id) throw badRequest('id is required');
      await assertSubject(ctx, q.object, q.id);
      // runs are built from what their requester can see, so each person sees their own
      return tx.query(`select id, agent_key, trigger, subject_object, subject_id, status, output, citations, ai_used, model, started_at from agent_runs where tenant_id = $1 and subject_object = $2 and subject_id = $3 and requested_by = $6 and ($4::text is null or agent_key = $4) order by started_at desc limit $5`, [c.var.tenant.id, q.object, q.id, q.agent ?? null, q.limit, c.var.principal.user.id]);
    });
    return c.json({ items: rows });
  })

  // ============================================================================ Copilot workspace
  .get('/copilot', async (c) => {
    const me = c.var.principal.user.id;
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const meetings = await tx.query(
        `select e.id, e.title, e.kind, e.starts_at, e.ends_at, e.status, e.location, e.related_object, e.related_id,
                exists (select 1 from agent_runs r where r.tenant_id = e.tenant_id and r.subject_object = 'event' and r.subject_id = e.id and r.agent_key = 'meeting_prep' and r.requested_by = $2) as prepped,
                exists (select 1 from agent_runs r where r.tenant_id = e.tenant_id and r.subject_object = 'event' and r.subject_id = e.id and r.agent_key = 'meeting_debrief' and r.requested_by = $2) as debriefed,
                (select count(*)::int from action_items i where i.tenant_id = e.tenant_id and i.event_id = e.id) as action_items
           from events e
          where e.tenant_id = $1 and e.status <> 'cancelled' and (e.owner_id = $2 or e.attendees @> jsonb_build_array(jsonb_build_object('userId', $2::text)))
            and e.starts_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
            and e.starts_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'
          order by e.starts_at limit 30`,
        [c.var.tenant.id, me],
      );
      const counts = await tx.one<{ open: number; in_progress: number; overdue: number; done_week: number; ai: number }>(
        `select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'in_progress')::int as in_progress,
                count(*) filter (where status in ('open','in_progress') and due_at < now())::int as overdue,
                count(*) filter (where status = 'done' and completed_at > now() - interval '7 days')::int as done_week,
                count(*) filter (where status in ('open','in_progress') and ai_generated)::int as ai
           from action_items where tenant_id = $1 and owner_id = $2`,
        [c.var.tenant.id, me],
      );
      const insights = await tx.query(
        `select id, kind, severity, title, body, related_object, related_id, score, status, created_at from insights
          where tenant_id = $1 and owner_id = $2 and status in ('new','seen') and (snooze_until is null or snooze_until < now())
          order by case severity when 'risk' then 0 when 'opportunity' then 1 when 'warn' then 2 else 3 end, created_at desc limit 25`,
        [c.var.tenant.id, me],
      );
      return { meetings, actionItems: counts, insights, focus: await focusList(ctx) };
    });
    return c.json(out);
  })

  // ============================================================================ action items
  .get('/action-items', async (c) => {
    const q = z
      .object({ scope: z.enum(['mine', 'record', 'event', 'team']).default('mine'), object: z.enum(RECORD_OBJECTS).optional(), id: uuid.optional(), status: z.enum(['open', 'in_progress', 'done', 'dismissed', 'active', 'overdue', 'all']).default('active') })
      .parse(c.req.query());
    const statusSql =
      q.status === 'active' ? `i.status in ('open','in_progress')` : q.status === 'overdue' ? `i.status in ('open','in_progress') and i.due_at < now()` : q.status === 'all' ? 'true' : `i.status = '${q.status}'`;
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const base = `select i.*, u.full_name as owner_name from action_items i left join users u on u.tenant_id = i.tenant_id and u.id = i.owner_id where i.tenant_id = $1 and ${statusSql}`;
      if (q.scope === 'mine') return tx.query(`${base} and i.owner_id = $2 order by i.due_at nulls last, i.created_at desc limit 200`, [c.var.tenant.id, c.var.principal.user.id]);
      if (q.scope === 'record') {
        if (!q.object || !q.id) throw badRequest('object and id are required');
        await loadRow(ctx, q.object, q.id, 'read');
        return tx.query(`${base} and i.related_object = $2 and i.related_id = $3 order by i.status = 'done', i.due_at nulls last limit 200`, [c.var.tenant.id, q.object, q.id]);
      }
      if (q.scope === 'event') {
        if (!q.id) throw badRequest('id is required');
        await loadEvent(ctx, q.id);
        return tx.query(`${base} and i.event_id = $2 order by i.created_at limit 100`, [c.var.tenant.id, q.id]);
      }
      // team: items on records the caller can see
      const rows = await tx.query<Record<string, any>>(`${base} and i.related_id is not null order by i.due_at nulls last limit 500`, [c.var.tenant.id]);
      const ok = new Map<string, Set<string>>();
      for (const o of RECORD_OBJECTS) ok.set(o, await visibleIds(ctx, o, rows.filter((r) => r.related_object === o).map((r) => r.related_id)));
      return rows.filter((r) => ok.get(r.related_object)?.has(r.related_id)).slice(0, 200);
    });
    return c.json({ items: rows });
  })
  .post('/action-items', async (c) => {
    const b = itemSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.relatedObject && b.relatedId) await loadRow(rctx(c, tx), b.relatedObject, b.relatedId, 'read');
      if (b.ownerId && b.ownerId !== c.var.principal.user.id) {
        const other = await actAs(c.env, tx, c.var.tenant.id, b.ownerId, 'assign');
        if (!other) throw badRequest('That person cannot be assigned work');
        if (b.relatedObject && b.relatedId) {
          try {
            await loadRow(other, b.relatedObject, b.relatedId, 'read');
          } catch (e) {
            if (e instanceof ApiError) throw badRequest('That person cannot see this record');
            throw e;
          }
        }
      }
      return tx.one(
        `insert into action_items (tenant_id, title, detail, priority, due_at, owner_id, related_object, related_id, source) values ($1,$2,$3,$4,$5,$6,$7,$8,'manual') returning *`,
        [c.var.tenant.id, b.title, b.detail ?? null, b.priority, b.dueAt ?? null, b.ownerId ?? c.var.principal.user.id, b.relatedObject ?? null, b.relatedId ?? null],
      );
    });
    return c.json(row, 201);
  })
  .patch('/action-items/:id', async (c) => {
    const b = itemSchema.partial().extend({ status: z.enum(['open', 'in_progress', 'done', 'dismissed']).optional() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const cur = await tx.one<Record<string, any>>(`select * from action_items where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!cur) throw notFound();
      const me = c.var.principal.user.id;
      if (cur.owner_id !== me && cur.created_by !== me) {
        if (!cur.related_object || !cur.related_id) throw notFound();
        await loadRow(ctx, cur.related_object, cur.related_id, 'update');
      }
      return tx.one(
        `update action_items set title = coalesce($3, title), detail = case when $4::boolean then $5 else detail end, priority = coalesce($6, priority),
                due_at = case when $7::boolean then $8::timestamptz else due_at end, owner_id = coalesce($9, owner_id), status = coalesce($10, status),
                completed_at = case when $10 = 'done' then now() when $10 is not null then null else completed_at end
          where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, id, b.title ?? null, b.detail !== undefined, b.detail ?? null, b.priority ?? null, b.dueAt !== undefined, b.dueAt ?? null, b.ownerId ?? null, b.status ?? null],
      );
    });
    return c.json(row);
  })

  // ============================================================================ suggestions
  .get('/suggestions', async (c) => {
    const q = z.object({ object: z.enum(RECORD_OBJECTS), id: uuid }).parse(c.req.query());
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      await loadRow(rctx(c, tx), q.object, q.id, 'read');
      return tx.query(`select * from agent_suggestions where tenant_id = $1 and object_key = $2 and record_id = $3 and status = 'pending' order by created_at desc limit 50`, [c.var.tenant.id, q.object, q.id]);
    });
    const perms = c.var.principal.permissions;
    return c.json({ items: rows.filter((r: any) => fieldAccess(perms, q.object, r.field_key) !== 'hidden') });
  })
  .post('/suggestions/:id/:action{apply|reject}', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const action = c.req.param('action');
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const s = await tx.one<Record<string, any>>(`select * from agent_suggestions where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!s) throw notFound();
      await loadRow(ctx, s.object_key, s.record_id, 'update');
      if (s.status !== 'pending') throw badRequest('This suggestion was already handled');
      if (action === 'reject') {
        await tx.query(`update agent_suggestions set status = 'rejected', decided_by = $3, decided_at = now() where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, c.var.principal.user.id]);
        return { status: 'rejected', events: [] };
      }
      const r = await updateRecord(ctx, s.object_key, s.record_id, { [s.field_key]: s.proposed_value });
      await tx.query(`update agent_suggestions set status = 'applied', decided_by = $3, decided_at = now() where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, c.var.principal.user.id]);
      await tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1,'ai',$2,$3,$4,$5,$6)`, [
        c.var.tenant.id,
        'Applied an AI suggestion',
        `Updated ${(c.var.meta.objects.find((o) => o.key === s.object_key)?.fields.find((f) => f.key === s.field_key)?.label ?? s.field_key).slice(0, 80)} from a meeting or call debrief.`,
        s.object_key,
        s.record_id,
        JSON.stringify({ suggestionId: id, runId: s.run_id }),
      ]);
      return { status: 'applied', record: r.record, events: r.events };
    });
    if (out.events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, out.events));
    return c.json({ status: out.status, record: 'record' in out ? out.record : undefined });
  })

  // ============================================================================ insights
  .get('/insights', async (c) => {
    const q = z.object({ status: z.enum(['open', 'all']).default('open'), object: z.enum([...RECORD_OBJECTS, 'quote', 'event'] as [string, ...string[]]).optional(), id: uuid.optional() }).parse(c.req.query());
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const st = q.status === 'open' ? `and i.status in ('new','seen') and (i.snooze_until is null or i.snooze_until < now())` : '';
      if (q.object && q.id) {
        await assertSubject(ctx, q.object, q.id);
        return tx.query(`select i.* from insights i where i.tenant_id = $1 and i.related_object = $2 and i.related_id = $3 ${st} order by i.created_at desc limit 50`, [c.var.tenant.id, q.object, q.id]);
      }
      const rows = await tx.query<Record<string, any>>(`select i.*, u.full_name as owner_name from insights i left join users u on u.tenant_id = i.tenant_id and u.id = i.owner_id where i.tenant_id = $1 ${st} order by i.created_at desc limit 500`, [c.var.tenant.id]);
      const me = c.var.principal.user.id;
      const ok = new Map<string, Set<string>>();
      for (const o of ['lead', 'contact', 'account', 'deal', 'quote']) ok.set(o, await visibleIds(ctx, o, rows.filter((r) => r.related_object === o && r.owner_id !== me).map((r) => r.related_id)));
      return rows.filter((r) => r.owner_id === me || ok.get(r.related_object)?.has(r.related_id)).slice(0, 200);
    });
    return c.json({ items: rows });
  })
  .patch('/insights/:id', async (c) => {
    const b = z.object({ status: z.enum(['seen', 'acted', 'dismissed']).optional(), snoozeDays: z.number().int().min(1).max(30).optional() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const cur = await tx.one<Record<string, any>>(`select * from insights where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!cur) throw notFound();
      if (cur.owner_id !== c.var.principal.user.id) {
        if (!cur.related_object || !cur.related_id) throw notFound();
        await assertSubject(rctx(c, tx), cur.related_object, cur.related_id, true);
      }
      return tx.one(`update insights set status = coalesce($3, status), snooze_until = case when $4::int is null then snooze_until else now() + make_interval(days => $4::int) end where tenant_id = $1 and id = $2 returning *`, [c.var.tenant.id, id, b.status ?? null, b.snoozeDays ?? null]);
    });
    return c.json(row);
  })

  // ============================================================================ context + scores
  .get('/context/:object/:id', async (c) => {
    const object = z.enum(RECORD_OBJECTS).parse(c.req.param('object'));
    const id = uuid.parse(c.req.param('id'));
    const ctxOut = await c.var.db.tx(scope(c, true), (tx) => buildContext(rctx(c, tx), object, id));
    return c.json({ subject: ctxOut.subject, facts: ctxOut.facts });
  })
  .get('/scores/:object/:id', async (c) => {
    const object = z.enum(RECORD_OBJECTS).parse(c.req.param('object'));
    const id = uuid.parse(c.req.param('id'));
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      await loadRow(ctx, object, id, 'read');
      const r = await tx.query<{ kind: string; score: number; band: string; factors: { label: string; impact: number; object: string }[]; computed_at: Date }>(
        `select kind, score, band, factors, computed_at from record_scores where tenant_id = $1 and object_key = $2 and record_id = $3`,
        [c.var.tenant.id, object, id],
      );
      return r.map((s) => ({ ...s, factors: s.factors.filter((f) => f.object === 'activity' || canRead(ctx, f.object)) }));
    });
    return c.json({ items: rows });
  })

  // ============================================================================ meetings
  .get('/meetings/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const e = await loadEvent(ctx, id);
      const n = await tx.one<Record<string, any>>(`select notes, transcript, transcript_source, updated_at from meeting_notes where tenant_id = $1 and event_id = $2`, [c.var.tenant.id, id]);
      // the caller's own brief and debrief (each is built from what its requester can see)
      const runs = await tx.query<Record<string, any>>(
        `select distinct on (agent_key) id, agent_key, output, citations, ai_used, model, started_at from agent_runs
          where tenant_id = $1 and subject_object = 'event' and subject_id = $2 and requested_by = $3 and agent_key in ('meeting_prep','meeting_debrief') order by agent_key, started_at desc`,
        [c.var.tenant.id, id, c.var.principal.user.id],
      );
      let related: { object: string; id: string; title: string } | null = null;
      if (e.related_object && e.related_id && canRead(ctx, e.related_object) && (await visibleIds(ctx, e.related_object, [e.related_id])).size) {
        const s = await tx.one<{ t: string }>(`select coalesce((select name from deals where tenant_id = $1 and id = $2), (select name from accounts where tenant_id = $1 and id = $2), (select full_name from contacts where tenant_id = $1 and id = $2), (select full_name from leads where tenant_id = $1 and id = $2)) as t`, [c.var.tenant.id, e.related_id]);
        related = { object: e.related_object, id: e.related_id, title: s?.t ?? e.related_object };
      }
      const items = await tx.query(`select * from action_items where tenant_id = $1 and event_id = $2 order by created_at`, [c.var.tenant.id, id]);
      return {
        event: { id: e.id, title: e.title, kind: e.kind, startsAt: e.starts_at, endsAt: e.ends_at, location: e.location, description: e.description, status: e.status, attendees: e.attendees, related },
        notes: n?.notes ?? '',
        transcript: n?.transcript ?? '',
        transcriptSource: n?.transcript_source ?? null,
        prep: runs.find((r) => r.agent_key === 'meeting_prep') ?? null,
        debrief: runs.find((r) => r.agent_key === 'meeting_debrief') ?? null,
        actionItems: items,
        canWrite: e.owner_id === c.var.principal.user.id || objectPerm(c.var.principal.permissions, 'deal').update === 'all' || (Array.isArray(e.attendees) && e.attendees.some((x: { userId?: string }) => x.userId === c.var.principal.user.id)),
      };
    });
    return c.json(out);
  })
  .put('/meetings/:id/notes', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ notes: z.string().max(20_000).optional(), transcript: z.string().max(200_000).optional() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      await loadEvent(rctx(c, tx), id, true);
      await tx.query(
        `insert into meeting_notes (tenant_id, event_id, notes, transcript, transcript_source) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, event_id) do update set notes = case when $6::boolean then excluded.notes else meeting_notes.notes end,
           transcript = case when $7::boolean then excluded.transcript else meeting_notes.transcript end,
           transcript_source = case when $7::boolean then excluded.transcript_source else meeting_notes.transcript_source end, updated_at = now(), updated_by = app.current_user_id()`,
        [c.var.tenant.id, id, b.notes ?? null, b.transcript ?? null, b.transcript ? 'pasted' : null, b.notes !== undefined, b.transcript !== undefined],
      );
    });
    return c.json({ ok: true });
  })
  .post('/meetings/:id/transcribe', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c, true), (tx) => loadEvent(rctx(c, tx), id, true));
    await chargeTranscription(c);
    const text = await transcribe(c.env, await readAudio(c));
    await c.var.db.tx(scope(c), (tx) =>
      tx.query(
        `insert into meeting_notes (tenant_id, event_id, transcript, transcript_source) values ($1,$2,$3,'audio')
         on conflict (tenant_id, event_id) do update set transcript = left(coalesce(meeting_notes.transcript || E'\\n\\n', '') || excluded.transcript, 200000), transcript_source = 'audio', updated_at = now()`,
        [c.var.tenant.id, id, text.slice(0, 190_000)],
      ),
    );
    return c.json({ transcript: text });
  })
  .post('/calls/:id/transcribe', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c, true), (tx) => assertSubject(rctx(c, tx), 'call', id, true));
    await chargeTranscription(c);
    const text = await transcribe(c.env, await readAudio(c));
    const r = await runAgent(agentEnv(c), 'call_debrief', { object: 'call', id }, { transcript: text });
    return c.json({ transcript: text, run: r }, 201);
  })

  // ============================================================================ competitors
  .get('/competitors', async (c) => {
    if (objectPerm(c.var.principal.permissions, 'deal').read === 'none') throw forbidden();
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(
        `select c.*, (select count(*)::int from deal_competitors d where d.tenant_id = c.tenant_id and d.competitor_id = c.id and d.status = 'active') as active_deals,
                (select count(*)::int from deal_competitors d where d.tenant_id = c.tenant_id and d.competitor_id = c.id and d.status = 'beaten') as beaten,
                (select count(*)::int from deal_competitors d where d.tenant_id = c.tenant_id and d.competitor_id = c.id and d.status = 'lost_to') as lost_to
           from competitors c where c.tenant_id = $1 order by c.is_active desc, lower(c.name)`,
        [c.var.tenant.id],
      ),
    );
    return c.json({ items: rows });
  })
  .get('/deals/:id/competitors', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const rows = await c.var.db.tx(scope(c, true), async (tx) => {
      await loadRow(rctx(c, tx), 'deal', id, 'read');
      return tx.query(
        `select dc.competitor_id, dc.status, dc.note, dc.source, c.name, c.strengths, c.weaknesses, c.how_we_win, c.pricing_notes from deal_competitors dc join competitors c on c.tenant_id = dc.tenant_id and c.id = dc.competitor_id
          where dc.tenant_id = $1 and dc.deal_id = $2 order by c.name`,
        [c.var.tenant.id, id],
      );
    });
    return c.json({ items: rows });
  })
  .put('/deals/:id/competitors/:competitorId', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const cid = uuid.parse(c.req.param('competitorId'));
    const b = z.object({ status: z.enum(['active', 'beaten', 'lost_to']).default('active'), note: z.string().max(1000).nullish() }).parse(await c.req.json().catch(() => ({})));
    await c.var.db.tx(scope(c), async (tx) => {
      await loadRow(rctx(c, tx), 'deal', id, 'update');
      if (!(await tx.one(`select 1 from competitors where tenant_id = $1 and id = $2`, [c.var.tenant.id, cid]))) throw notFound();
      await tx.query(
        `insert into deal_competitors (tenant_id, deal_id, competitor_id, status, note) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, deal_id, competitor_id) do update set status = excluded.status, note = coalesce(excluded.note, deal_competitors.note), source = 'manual'`,
        [c.var.tenant.id, id, cid, b.status, b.note ?? null],
      );
    });
    return c.json({ ok: true });
  })
  .delete('/deals/:id/competitors/:competitorId', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      await loadRow(rctx(c, tx), 'deal', id, 'update');
      await tx.query(`delete from deal_competitors where tenant_id = $1 and deal_id = $2 and competitor_id = $3`, [c.var.tenant.id, id, uuid.parse(c.req.param('competitorId'))]);
    });
    return c.json({ ok: true });
  })

  // ============================================================================ ask
  .post('/ask', async (c) => {
    const b = z.object({ question: z.string().trim().min(3).max(800), object: z.enum(RECORD_OBJECTS).optional(), id: uuid.optional() }).parse(await c.req.json());
    if (!canReadAny(c)) throw forbidden();
    return c.json(await askSynapse(agentEnv(c), b.question, b.object && b.id ? { object: b.object, id: b.id } : undefined));
  });

function canReadAny(c: { var: AppEnv['Variables'] }) {
  return ['lead', 'contact', 'account', 'deal'].some((o) => objectPerm(c.var.principal.permissions, o).read !== 'none');
}

/** Agent switches, auto-run and budgets; battlecards. */
export const intelAdminRoutes = new Hono<AppEnv>()
  .get('/agents', requireAdmin('ai'), async (c) => {
    const rows = await c.var.db.tx(scope(c, true), (tx) => tx.query<Record<string, any>>(`select * from agent_settings where tenant_id = $1`, [c.var.tenant.id]));
    const runs = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query<{ agent_key: string; n: number; ai: number }>(`select agent_key, count(*)::int as n, count(*) filter (where ai_used)::int as ai from agent_runs where tenant_id = $1 and started_at > now() - interval '30 days' group by agent_key`, [c.var.tenant.id]),
    );
    return c.json({
      items: AGENTS.map((a) => {
        const s = rows.find((r) => r.agent_key === a.key);
        return { ...a, enabled: s?.enabled ?? true, autoRunOn: s?.auto_run ?? false, dailyBudget: s?.daily_budget ?? 25, settings: s?.settings ?? {}, runs30d: runs.find((r) => r.agent_key === a.key)?.n ?? 0, aiRuns30d: runs.find((r) => r.agent_key === a.key)?.ai ?? 0 };
      }),
    });
  })
  .put('/agents/:key', requireAdmin('ai'), async (c) => {
    const key = c.req.param('key');
    if (!AGENTS.some((a) => a.key === key)) throw notFound();
    const b = z
      .object({
        enabled: z.boolean().optional(),
        autoRun: z.boolean().optional(),
        dailyBudget: z.number().int().min(0).max(1000).optional(),
        settings: z.object({ stalledDays: z.number().int().min(3).max(90).optional(), leadWaitHours: z.number().int().min(1).max(72).optional() }).optional(),
      })
      .parse(await c.req.json());
    if (b.autoRun && !AGENTS.find((a) => a.key === key)?.autoRun) throw badRequest('This agent only runs when someone asks for it');
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const cur = await settingsOf(tx, c.var.tenant.id, key);
      return tx.one(
        `insert into agent_settings (tenant_id, agent_key, enabled, auto_run, daily_budget, settings) values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, agent_key) do update set enabled = excluded.enabled, auto_run = excluded.auto_run, daily_budget = excluded.daily_budget, settings = excluded.settings, updated_at = now(), updated_by = app.current_user_id()
         returning *`,
        [c.var.tenant.id, key, b.enabled ?? cur.enabled, b.autoRun ?? cur.auto_run, b.dailyBudget ?? cur.daily_budget, JSON.stringify({ ...cur.settings, ...(b.settings ?? {}) })],
      );
    });
    return c.json(row);
  })
  .post('/competitors', requireAdmin('ai'), async (c) => {
    const b = competitorSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (await tx.one(`select 1 from competitors where tenant_id = $1 and lower(name) = lower($2)`, [c.var.tenant.id, b.name])) throw badRequest('A competitor with this name already exists');
      return tx.one(
        `insert into competitors (tenant_id, name, website, aliases, description, strengths, weaknesses, pricing_notes, how_we_win, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [c.var.tenant.id, b.name, b.website ?? null, b.aliases, b.description ?? null, b.strengths ?? null, b.weaknesses ?? null, b.pricingNotes ?? null, b.howWeWin ?? null, b.isActive],
      );
    });
    return c.json(row, 201);
  })
  .patch('/competitors/:id', requireAdmin('ai'), async (c) => {
    const b = competitorSchema.partial().parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const cur = await tx.one<Record<string, any>>(`select * from competitors where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!cur) throw notFound();
      const v = <T>(k: keyof typeof b, col: string): T => (b[k] !== undefined ? (b[k] as T) : (cur[col] as T));
      return tx.one(
        `update competitors set name = $3, website = $4, aliases = $5, description = $6, strengths = $7, weaknesses = $8, pricing_notes = $9, how_we_win = $10, is_active = $11 where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, id, v('name', 'name'), v('website', 'website'), v('aliases', 'aliases'), v('description', 'description'), v('strengths', 'strengths'), v('weaknesses', 'weaknesses'), v('pricingNotes', 'pricing_notes'), v('howWeWin', 'how_we_win'), v('isActive', 'is_active')],
      );
    });
    return c.json(row);
  })
  .delete('/competitors/:id', requireAdmin('ai'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from competitors where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  });

