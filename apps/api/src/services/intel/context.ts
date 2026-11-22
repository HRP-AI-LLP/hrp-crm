/**
 * The context layer: everything SanchalanOS knows about one customer or deal, gathered as the viewer
 * (record visibility and field security apply to every piece) and turned into numbered facts.
 *
 * Agents receive facts as "[F3] …" lines and must cite the refs they rely on; citations that do
 * not match a fact are dropped, so every claim in an agent's output can be traced to a record.
 */
import { type FieldDef, fieldAccess, objectPerm, storageFor } from '@synapse/shared';
import type { Tx } from '../../lib/db';
import { ApiError } from '../../lib/errors';
import { listRecords, loadRow, type RecordCtx, toDto } from '../records';

export interface Fact {
  ref: string;
  object: string;
  id: string;
  kind: string;
  label: string;
  at: string | null;
  text: string;
}

export interface Citation {
  ref: string;
  object: string;
  id: string;
  kind: string;
  label: string;
  at: string | null;
}

export interface Context {
  subject: { object: string; id: string; label: string };
  record: Record<string, unknown>;
  facts: Fact[];
  /** visible related records by object (ids), used by agents for deterministic signals */
  related: Record<string, Record<string, unknown>[]>;
}

const MAX_FACTS = 70;

/** A record's display name ("title" can be a field, e.g. a contact's job title). */
export const titleOf = (object: string, dto: Record<string, unknown>) => String(dto[storageFor(object).titleColumn] ?? dto.title ?? '');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** True when the viewer can read the object at all (and it exists in this workspace). */
export const canRead = (ctx: RecordCtx, object: string) => ctx.meta.objects.some((o) => o.key === object) && objectPerm(ctx.principal.permissions, object).read !== 'none';

/** Records of `object` matching simple equality filters, as the viewer sees them; [] if not allowed. */
export async function visibleWhere(ctx: RecordCtx, object: string, filters: { field: string; value: unknown }[], limit = 20, sort?: string) {
  if (!canRead(ctx, object)) return [];
  const obj = ctx.meta.objects.find((o) => o.key === object)!;
  if (filters.some((f) => !obj.fields.some((x) => x.key === f.field))) return [];
  try {
    const r = await listRecords(ctx, object, { filters: filters.map((f) => ({ field: f.field, op: 'eq', value: f.value })), limit, sort, dir: 'desc' });
    return r.items as Record<string, unknown>[];
  } catch (e) {
    // permission / validation refusals only: a SQL error must surface (the transaction is aborted)
    if (e instanceof ApiError) return [];
    throw e;
  }
}

/** The subset of `ids` the viewer can read. */
export async function visibleIds(ctx: RecordCtx, object: string, ids: string[]): Promise<Set<string>> {
  const uniq = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  if (!uniq.length || !canRead(ctx, object)) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < uniq.length; i += 200) {
    const r = await listRecords(ctx, object, { ids: uniq.slice(i, i + 200), limit: 200 });
    for (const it of r.items) out.add(String(it.id));
  }
  return out;
}

const SKIP_TYPES = new Set(['email', 'phone', 'url', 'file', 'user', 'lookup', 'json', 'formula_hidden']);

/** Score factors the viewer may see: the object behind each one, and the field when it names one. */
export function visibleFactors<T extends { object: string; field?: string }>(ctx: RecordCtx, factors: T[]): T[] {
  return factors.filter((f) => (f.object === 'activity' || canRead(ctx, f.object)) && (!f.field || fieldAccess(ctx.principal.permissions, f.object, f.field) !== 'hidden'));
}

/** A record as one readable line: "Label: value; …" (no ids, contact details or PII-flagged fields). */
export function describe(ctx: RecordCtx, object: string, dto: Record<string, unknown>): string {
  const obj = ctx.meta.objects.find((o) => o.key === object);
  const parts: string[] = [];
  for (const f of obj?.fields ?? ([] as FieldDef[])) {
    const v = dto[f.key];
    if (v === null || v === undefined || v === '' || f.pii || SKIP_TYPES.has(f.type)) continue;
    if (f.key === 'stage_id') {
      const st = ctx.meta.pipelines.flatMap((p) => p.stages).find((x) => x.id === v);
      if (st) parts.push(`Stage: ${st.label}`);
      continue;
    }
    if (f.key.endsWith('_id') || f.key === 'consent' || f.key === 'custom' || f.key === 'currency' || f.key === storageFor(object).titleColumn) continue;
    const choices = f.options?.choices as { value: string; label: string }[] | undefined;
    let shown = choices?.find((c) => c.value === v)?.label ?? (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (f.type === 'currency' && Number.isFinite(Number(v))) shown = `₹${Number(v).toLocaleString('en-IN')}`;
    else if (f.type === 'datetime') shown = String(v).slice(0, 10);
    else if (f.type === 'boolean') shown = v ? 'yes' : 'no';
    parts.push(`${f.label}: ${clip(shown, 160)}`);
  }
  return parts.join('; ');
}

function stageInfo(ctx: RecordCtx, stageId: unknown) {
  const st = ctx.meta.pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.id }))).find((x) => x.id === stageId);
  return st ?? null;
}
export const stageCategory = (ctx: RecordCtx, stageId: unknown): 'open' | 'won' | 'lost' => ((stageInfo(ctx, stageId) as { category?: 'open' | 'won' | 'lost' } | null)?.category ?? 'open');
export const stageLabel = (ctx: RecordCtx, stageId: unknown) => stageInfo(ctx, stageId)?.label ?? null;

class FactList {
  items: Fact[] = [];
  add(f: Omit<Fact, 'ref'>) {
    if (this.items.length >= MAX_FACTS || !f.text) return;
    this.items.push({ ...f, ref: `F${this.items.length + 1}` });
  }
}

/**
 * Builds the context of a lead, contact, account or deal. The subject itself must be readable
 * (loadRow throws otherwise); everything else is included only when the viewer can see it.
 */
export async function buildContext(ctx: RecordCtx, object: string, id: string, opts: { interactions?: number } = {}): Promise<Context> {
  const { obj, row } = await loadRow(ctx, object, id, 'read');
  const record = toDto(obj, row, ctx.principal.permissions) as Record<string, unknown>;
  const facts = new FactList();
  const related: Record<string, Record<string, unknown>[]> = {};
  const label = titleOf(object, record) || obj.label;
  facts.add({ object, id, kind: 'record', label: `${obj.label}: ${label}`, at: iso(record.updated_at), text: `${obj.label} "${label}". ${describe(ctx, object, record)}` });

  const push = (o: string, items: Record<string, unknown>[]) => {
    related[o] = [...(related[o] ?? []), ...items.filter((x) => !(related[o] ?? []).some((y) => y.id === x.id))];
  };
  const addRecords = (o: string, items: Record<string, unknown>[], prefix?: string) => {
    const meta = ctx.meta.objects.find((x) => x.key === o);
    push(o, items);
    for (const it of items) facts.add({ object: o, id: String(it.id), kind: 'record', label: `${meta?.label ?? o}: ${titleOf(o, it)}`, at: iso(it.updated_at), text: `${prefix ? `${prefix} ` : ''}${meta?.label ?? o} "${titleOf(o, it)}". ${describe(ctx, o, it)}` });
  };

  // ------------------------------------------------------------------ the customer around the subject
  const accountId = (object === 'account' ? id : (record.account_id as string | null)) ?? null;
  if (accountId && object !== 'account') {
    const acc = canRead(ctx, 'account') ? ((await listRecords(ctx, 'account', { ids: [accountId], limit: 1 })).items as Record<string, unknown>[]) : [];
    addRecords('account', acc, 'Customer');
  }
  if (object === 'deal' && record.contact_id) {
    const c = (await visibleIds(ctx, 'contact', [String(record.contact_id)])).size ? (await listRecords(ctx, 'contact', { ids: [String(record.contact_id)], limit: 1 })).items : [];
    addRecords('contact', c as Record<string, unknown>[], 'Main contact');
  }
  if (accountId) {
    if (object !== 'contact') addRecords('contact', await visibleWhere(ctx, 'contact', [{ field: 'account_id', value: accountId }], 8), 'Contact at the customer');
    addRecords('deal', (await visibleWhere(ctx, 'deal', [{ field: 'account_id', value: accountId }], 8)).filter((d) => d.id !== id), 'Deal');
  }
  if (object === 'contact') addRecords('deal', await visibleWhere(ctx, 'deal', [{ field: 'contact_id', value: id }], 6), 'Deal');
  if (object === 'deal') addRecords('quote', await visibleWhere(ctx, 'quote', [{ field: 'deal_id', value: id }], 5), 'Quote');
  if (accountId) {
    if (object !== 'deal') addRecords('quote', await visibleWhere(ctx, 'quote', [{ field: 'account_id', value: accountId }], 4), 'Quote');
    addRecords('sales_order', await visibleWhere(ctx, 'sales_order', [{ field: 'account_id', value: accountId }], 4), 'Order');
    addRecords('invoice', await visibleWhere(ctx, 'invoice', [{ field: 'account_id', value: accountId }], 4), 'Invoice');
    addRecords('ticket', await visibleWhere(ctx, 'ticket', [{ field: 'account_id', value: accountId }], 5), 'Service ticket');
    addRecords('installation', await visibleWhere(ctx, 'installation', [{ field: 'account_id', value: accountId }], 3), 'Installation');
  }

  // ------------------------------------------------------------------ competitors on the deal(s)
  const dealIds = [...(object === 'deal' ? [id] : []), ...(related.deal ?? []).map((d) => String(d.id))];
  if (dealIds.length) {
    const comps = await ctx.tx.query<{ deal_id: string; name: string; status: string; note: string | null; strengths: string | null; weaknesses: string | null; how_we_win: string | null; id: string }>(
      `select dc.deal_id, dc.status, dc.note, c.id, c.name, c.strengths, c.weaknesses, c.how_we_win from deal_competitors dc join competitors c on c.tenant_id = dc.tenant_id and c.id = dc.competitor_id
        where dc.tenant_id = $1 and dc.deal_id = any($2::uuid[]) limit 10`,
      [ctx.tenantId, dealIds],
    );
    for (const c of comps) {
      facts.add({
        object: 'deal',
        id: c.deal_id,
        kind: 'competitor',
        label: `Competitor: ${c.name}`,
        at: null,
        text: `Competing against ${c.name} (${c.status.replace('_', ' ')})${c.note ? `: ${clip(c.note, 200)}` : ''}. Their strengths: ${clip(c.strengths, 200) || 'unknown'}. Weaknesses: ${clip(c.weaknesses, 200) || 'unknown'}. How we win: ${clip(c.how_we_win, 300) || 'not written yet'}.`,
      });
    }
  }

  // ------------------------------------------------------------------ interactions on visible records
  const touch: [string, string][] = [[object, id]];
  for (const [o, items] of Object.entries(related)) if (['account', 'contact', 'deal', 'ticket', 'sales_order', 'quote'].includes(o)) for (const it of items) touch.push([o, String(it.id)]);
  const objs = touch.map((t) => t[0]);
  const ids = touch.map((t) => t[1]);
  const n = opts.interactions ?? 25;
  const acts = await ctx.tx.query<{ id: string; kind: string; subject: string | null; body: string | null; direction: string | null; related_object: string; related_id: string; occurred_at: Date; sentiment: string | null }>(
    `select a.id, a.kind, a.subject, a.body, a.direction, a.related_object, a.related_id, a.occurred_at, a.sentiment
       from activities a join unnest($2::text[], $3::uuid[]) as t(o, i) on a.related_object = t.o and a.related_id = t.i
      where a.tenant_id = $1 and a.kind not in ('system', 'webhook') order by a.occurred_at desc limit $4`,
    [ctx.tenantId, objs, ids, n],
  );
  for (const a of acts) {
    const what = a.kind === 'stage_change' ? 'Stage change' : a.kind === 'ai' ? 'AI note' : `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)}${a.direction ? (a.direction === 'in' ? ' from customer' : ' to customer') : ''}`;
    facts.add({
      object: a.related_object,
      id: a.related_id,
      kind: 'activity',
      label: `${what} · ${a.occurred_at.toISOString().slice(0, 10)}`,
      at: a.occurred_at.toISOString(),
      text: `${what} on ${a.occurred_at.toISOString().slice(0, 10)}${a.subject ? `: ${clip(a.subject, 140)}` : ''}${a.body ? ` — ${clip(a.body, 420)}` : ''}${a.sentiment ? ` (sentiment ${a.sentiment})` : ''}`,
    });
  }
  const msgs = await ctx.tx.query<{ id: string; channel: string; direction: string; subject: string | null; body: string | null; related_object: string; related_id: string; created_at: Date }>(
    `select m.id, m.channel, m.direction, m.subject, m.body, m.related_object, m.related_id, m.created_at
       from messages m join unnest($2::text[], $3::uuid[]) as t(o, i) on m.related_object = t.o and m.related_id = t.i
      where m.tenant_id = $1 and m.body is not null and m.campaign_id is null
        and not exists (select 1 from activities a where a.tenant_id = m.tenant_id and a.metadata ->> 'messageId' = m.id::text)
      order by m.created_at desc limit 12`,
    [ctx.tenantId, objs, ids],
  );
  for (const m of msgs) {
    facts.add({
      object: m.related_object,
      id: m.related_id,
      kind: 'message',
      label: `${m.channel === 'whatsapp' ? 'WhatsApp' : m.channel} ${m.direction === 'in' ? 'from customer' : 'to customer'} · ${m.created_at.toISOString().slice(0, 10)}`,
      at: m.created_at.toISOString(),
      text: `${m.channel} ${m.direction === 'in' ? 'from the customer' : 'to the customer'} on ${m.created_at.toISOString().slice(0, 10)}${m.subject ? ` "${clip(m.subject, 120)}"` : ''}: ${clip(m.body, 400)}`,
    });
  }
  const evs = await ctx.tx.query<{ id: string; title: string; kind: string; starts_at: Date; status: string; outcome: string | null; related_object: string; related_id: string; summary: string | null }>(
    `select e.id, e.title, e.kind, e.starts_at, e.status, e.outcome, e.related_object, e.related_id,
            (select r.output -> 'sections' -> 0 ->> 'text' from agent_runs r where r.tenant_id = e.tenant_id and r.agent_key = 'meeting_debrief' and r.subject_object = 'event' and r.subject_id = e.id and r.requested_by = $5 order by r.started_at desc limit 1) as summary
       from events e join unnest($2::text[], $3::uuid[]) as t(o, i) on e.related_object = t.o and e.related_id = t.i
      where e.tenant_id = $1 and e.status <> 'cancelled'
        and ($4::boolean or e.owner_id = $5 or e.attendees @> jsonb_build_array(jsonb_build_object('userId', $5::text)))
      order by e.starts_at desc limit 8`,
    [ctx.tenantId, objs, ids, objectPerm(ctx.principal.permissions, 'deal').read === 'all', ctx.principal.user.id],
  );
  for (const e of evs) {
    const future = e.starts_at.getTime() > Date.now();
    facts.add({
      object: e.related_object,
      id: e.related_id,
      kind: 'meeting',
      label: `${e.kind.replace('_', ' ')} "${clip(e.title, 60)}" · ${e.starts_at.toISOString().slice(0, 10)}`,
      at: e.starts_at.toISOString(),
      text: `${future ? 'Upcoming' : 'Past'} ${e.kind.replace('_', ' ')} "${clip(e.title, 120)}" on ${e.starts_at.toISOString().slice(0, 16).replace('T', ' ')} UTC${e.outcome ? `. Outcome: ${clip(e.outcome, 300)}` : ''}${e.summary ? `. Debrief: ${clip(e.summary, 400)}` : ''}`,
    });
  }
  const items = await ctx.tx.query<{ id: string; title: string; status: string; due_at: Date | null; related_object: string; related_id: string }>(
    `select i.id, i.title, i.status, i.due_at, i.related_object, i.related_id from action_items i join unnest($2::text[], $3::uuid[]) as t(o, i2) on i.related_object = t.o and i.related_id = t.i2
      where i.tenant_id = $1 and i.status in ('open', 'in_progress') order by i.due_at nulls last limit 10`,
    [ctx.tenantId, objs, ids],
  );
  for (const it of items) facts.add({ object: it.related_object, id: it.related_id, kind: 'action_item', label: `Open action: ${clip(it.title, 60)}`, at: iso(it.due_at), text: `Open action item${it.due_at ? ` due ${it.due_at.toISOString().slice(0, 10)}` : ''}: ${clip(it.title, 200)} (${it.status.replace('_', ' ')})` });
  const taskRead = objectPerm(ctx.principal.permissions, 'task').read;
  const tasks =
    taskRead === 'none'
      ? []
      : await ctx.tx.query<{ title: string; status: string; due_at: Date | null; related_object: string; related_id: string }>(
          `select k.title, k.status, k.due_at, k.related_object, k.related_id from tasks k join unnest($2::text[], $3::uuid[]) as t(o, i) on k.related_object = t.o and k.related_id = t.i
            where k.tenant_id = $1 and k.status not in ('done', 'cancelled') and ($4::boolean is false or k.assignee_id = $5 or k.created_by = $5)
            order by k.due_at nulls last limit 8`,
          [ctx.tenantId, objs, ids, taskRead === 'own', ctx.principal.user.id],
        );
  for (const t of tasks) facts.add({ object: t.related_object, id: t.related_id, kind: 'task', label: `Task: ${clip(t.title, 60)}`, at: iso(t.due_at), text: `Open task${t.due_at ? ` due ${t.due_at.toISOString().slice(0, 10)}` : ''}: ${clip(t.title, 200)}` });
  const scores = await ctx.tx.query<{ object_key: string; record_id: string; kind: string; score: number; band: string; factors: { label: string; object: string; field?: string }[] }>(
    `select object_key, record_id, kind, score, band, factors from record_scores where tenant_id = $1 and (object_key, record_id) in (select * from unnest($2::text[], $3::uuid[]))`,
    [ctx.tenantId, objs, ids],
  );
  for (const s of scores) {
    const shown = visibleFactors(ctx, (s.factors ?? []) as { label: string; object: string; field?: string }[]);
    facts.add({ object: s.object_key, id: s.record_id, kind: 'score', label: `${s.kind.replace('_', ' ')} ${s.score}`, at: null, text: `${s.kind.replace('_', ' ')} score ${s.score}/100 (${s.band}): ${shown.slice(0, 4).map((f) => f.label).join('; ')}` });
  }

  return { subject: { object, id, label }, record, facts: facts.items, related };
}

/** Facts as the lines an agent reads. */
export const factLines = (facts: Fact[]) => facts.map((f) => `[${f.ref}] ${f.text}`).join('\n');

/** Keeps only refs that exist; returns citation objects in first-use order. */
export function resolveRefs(facts: Fact[], refs: unknown): Citation[] {
  const byRef = new Map(facts.map((f) => [f.ref, f]));
  const out: Citation[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(refs) ? refs : typeof refs === 'string' ? refs.match(/F\d+/g) ?? [] : [];
  for (const r of list) {
    const k = String(r).replace(/[^F0-9]/g, '');
    const f = byRef.get(k);
    if (!f || seen.has(k)) continue;
    seen.add(k);
    out.push({ ref: f.ref, object: f.object, id: f.id, kind: f.kind, label: f.label, at: f.at });
  }
  return out;
}

/**
 * Links stored emails that arrived without a record to the contact, lead or account they came
 * from: exact address first, then the sender's company domain (never public mail domains).
 */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'rediffmail.com', 'protonmail.com', 'aol.com', 'zoho.com', 'ymail.com', 'msn.com']);

export async function resolveUnlinked(tx: Tx, tenantId: string, limit = 200) {
  const rows = await tx.query<{ id: string; addr: string }>(
    `select id, lower(substring(coalesce(case when direction = 'in' then from_addr else to_addr end, '') from '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+')) as addr
       from messages where tenant_id = $1 and related_id is null and channel = 'email' and created_at > now() - interval '90 days' order by created_at desc limit $2`,
    [tenantId, limit],
  );
  let linked = 0;
  for (const m of rows) {
    if (!m.addr) continue;
    const exact = await tx.one<{ o: string; id: string }>(
      `select 'contact' as o, id from contacts where tenant_id = $1 and lower(email) = $2 and deleted_at is null
       union all select 'lead', id from leads where tenant_id = $1 and lower(email) = $2 and deleted_at is null and converted_at is null
       limit 1`,
      [tenantId, m.addr],
    );
    let target = exact;
    const domain = m.addr.split('@')[1] ?? '';
    if (!target && domain && !PUBLIC_DOMAINS.has(domain)) {
      const acc = await tx.query<{ id: string }>(
        `select id from accounts where tenant_id = $1 and deleted_at is null and (lower(domain) = $2 or split_part(regexp_replace(regexp_replace(lower(coalesce(website, '')), '^https?://', ''), '^www\\.', ''), '/', 1) = $2) limit 2`,
        [tenantId, domain],
      );
      if (acc.length === 1) target = { o: 'account', id: acc[0]!.id };
    }
    if (!target) continue;
    await tx.query(`update messages set related_object = $3, related_id = $4 where tenant_id = $1 and id = $2 and related_id is null`, [tenantId, m.id, target.o, target.id]);
    linked++;
  }
  return { linked };
}
