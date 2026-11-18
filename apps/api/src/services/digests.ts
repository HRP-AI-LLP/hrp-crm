/**
 * Scheduled digests: Business health, a dashboard or a report by email, daily / weekly / monthly
 * at a chosen hour (IST). Every recipient is a workspace user and the digest runs as them, so
 * each person sees only the numbers they could see in the app.
 */
import { KPI_BY_KEY } from '@synapse/shared';
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest } from '../lib/errors';
import { runReport, reportDefinitionSchema } from '../routes/sales';
import { businessHealth } from './kpis';
import { sendPlatformMail } from './mailer';
import type { RecordCtx } from './records';
import { actAs } from './system';

const IST = 330 * 60_000;
const KV_KEY = 'digests:next';

export interface ScheduleSpec {
  frequency: 'daily' | 'weekly' | 'monthly';
  send_hour: number;
  weekday?: number | null;
  monthday?: number | null;
}

/** The next send time strictly after `after`, in IST wall-clock terms. */
export function nextRun(s: ScheduleSpec, after = new Date()): Date {
  const local = new Date(after.getTime() + IST);
  for (let add = 0; add < 40; add++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add, s.send_hour));
    const at = new Date(d.getTime() - IST);
    if (at <= after) continue;
    const wd = ((d.getUTCDay() + 6) % 7) + 1; // Monday = 1
    if (s.frequency === 'weekly' && wd !== (s.weekday ?? 1)) continue;
    if (s.frequency === 'monthly' && d.getUTCDate() !== (s.monthday ?? 1)) continue;
    return at;
  }
  throw badRequest('Could not work out the next send time');
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

function fmt(v: number | null, f: string): string {
  if (v === null || v === undefined) return '—';
  if (f === 'money') return inr(v);
  if (f === 'money_per_day') return `${inr(v)}/day`;
  if (f === 'ratio') return `${v}×`;
  if (f === 'percent') return `${v}%`;
  if (f === 'minutes') return `${v} min`;
  if (f === 'hours') return `${v} h`;
  if (f === 'days') return `${v} days`;
  return v.toLocaleString('en-IN');
}

function table(title: string, rows: [string, string, string?][], link?: string) {
  const body = rows
    .map(([a, b, tone]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6">${esc(a)}</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;color:${tone === 'good' ? '#047857' : tone === 'bad' ? '#b91c1c' : tone === 'warn' ? '#b45309' : '#0f172a'}">${esc(b)}</td></tr>`)
    .join('');
  return `<h2 style="font-size:15px;margin:20px 0 6px;color:#075492">${esc(title)}${link ? ` <a href="${esc(link)}" style="font-size:12px;font-weight:400">open</a>` : ''}</h2><table role="presentation" width="100%" cellspacing="0" style="font-size:13.5px;border-collapse:collapse">${body || '<tr><td style="color:#64748b">Nothing to show.</td></tr>'}</table>`;
}

async function reportSection(ctx: RecordCtx, reportId: string, origin: string, title?: string) {
  const r = await ctx.tx.one<{ name: string; object_key: string; definition: unknown }>(`select name, object_key, definition from reports where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [ctx.tenantId, reportId, ctx.principal.user.id]);
  if (!r) return '';
  const d = reportDefinitionSchema.parse(r.definition);
  let res;
  try {
    res = await runReport(ctx, r.object_key, d);
  } catch {
    return table(title ?? r.name, [['You do not have access to this report', '']]);
  }
  const rows: [string, string][] = [];
  if (res.kind === 'table') {
    for (const it of res.items.slice(0, 10)) rows.push([String(it.title ?? ''), d.columns[1] ? String((it as Record<string, unknown>)[d.columns[1]] ?? '') : '']);
    if ((res.total ?? 0) > 10) rows.push([`…and ${(res.total ?? 0) - 10} more`, '']);
  } else {
    const labels = (res.labels ?? {}) as Record<string, Record<string, string>>;
    const field = d.groupBy ?? '';
    const sums = new Map<string, number>();
    for (const x of res.rows) sums.set(x.g1 ?? '(none)', (sums.get(x.g1 ?? '(none)') ?? 0) + Number(x.value ?? 0));
    const money = d.measure.agg !== 'count' && /amount|total|value|price|revenue|balance/.test(d.measure.field ?? '');
    for (const [k, v] of [...sums.entries()].slice(0, 12)) rows.push([labels[field]?.[k] ?? k, money ? inr(v) : v.toLocaleString('en-IN')]);
  }
  return table(title ?? r.name, rows, `${origin}/reports/${reportId}`);
}

async function healthSection(ctx: RecordCtx, origin: string) {
  const h = await businessHealth(ctx, 'this_month');
  const rows: [string, string, string?][] = h.items.map((i) => {
    const d = KPI_BY_KEY[i.key]!;
    return [`${d.label}${i.target !== null ? ` (target ${fmt(i.target, d.format)})` : ''}`, fmt(i.value, d.format), i.status ?? undefined];
  });
  return table(`Business health · ${h.period.label}`, rows, `${origin}/health`);
}

/** The books: last month's profit and loss, this month so far, cash, money owed both ways. */
async function booksSection(ctx: RecordCtx, origin: string) {
  const { booksOverview, profitAndLoss } = await import('./books/reports');
  let o;
  try {
    o = await booksOverview(ctx);
  } catch {
    return table('Books', [['Only the people who keep the books receive this digest', '']]);
  }
  const today = String(o.today).slice(0, 10);
  const lmEnd = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const lm = await profitAndLoss(ctx, `${lmEnd.slice(0, 7)}-01`, lmEnd);
  const month = new Date(`${lmEnd}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tone = (v: number) => (v < 0 ? 'bad' : 'good');
  let html = table(`Profit and loss · ${month}`, [
    ['Income', inr(lm.sections[0]!.total + lm.sections[3]!.total)],
    ['Cost of sales and expenses', inr(lm.sections[1]!.total + lm.sections[2]!.total + lm.sections[4]!.total)],
    ['Net profit', inr(lm.netProfit), tone(lm.netProfit)],
    ...(lm.grossMargin != null ? ([['Gross margin', `${lm.grossMargin}%`]] as [string, string][]) : []),
  ], `${origin}/books`);
  html += table('Where things stand today', [
    ['Cash and bank', inr(o.cash)],
    ['Customers owe', inr(o.receivables?.v ?? 0)],
    ['…of which overdue', inr(o.receivables?.overdue ?? 0), (o.receivables?.overdue ?? 0) > 0 ? 'warn' : undefined],
    ['We owe vendors', inr(o.payables?.v ?? 0)],
    [`Net profit this financial year`, inr(o.year.net), tone(o.year.net)],
  ]);
  if (o.owedBy?.length) html += table('Largest amounts to collect', o.owedBy.map((x: any) => [x.name, inr(x.v), x.overdue > 0 ? 'warn' : undefined]));
  if (o.topSpend?.length) html += table('Where the money went this year', o.topSpend.slice(0, 6).map((x: any) => [x.name, inr(x.amount)]));
  return html;
}

export async function renderDigest(ctx: RecordCtx, s: { kind: string; target_id: string | null; name: string }, origin: string) {
  let html = '';
  if (s.kind === 'health') html = await healthSection(ctx, origin);
  else if (s.kind === 'books') html = await booksSection(ctx, origin);
  else if (s.kind === 'report' && s.target_id) html = await reportSection(ctx, s.target_id, origin);
  else if (s.kind === 'dashboard' && s.target_id) {
    const d = await ctx.tx.one<{ name: string; widgets: { reportId: string; title?: string }[] }>(`select name, widgets from dashboards where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [ctx.tenantId, s.target_id, ctx.principal.user.id]);
    if (d) for (const w of d.widgets.slice(0, 12)) html += await reportSection(ctx, w.reportId, origin, w.title);
  }
  return html;
}

function wrap(company: string, title: string, inner: string, manage: string) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:620px;background:#fff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="background:#062f59;border-radius:12px 12px 0 0;padding:16px 24px;color:#fff"><b>${esc(company)}</b> · ${esc(title)}</td></tr>
<tr><td style="padding:8px 24px 24px">${inner}</td></tr></table>
<p style="color:#94a3b8;font-size:12px;margin:14px 0 0">HRP Synapse digest · <a href="${esc(manage)}" style="color:#94a3b8">manage digests</a></p>
</td></tr></table></body></html>`;
}

/** Sends one schedule to every recipient, as that recipient. */
export async function sendSchedule(env: Env, db: Db, tenantId: string, id: string, origin: string) {
  const s = await db.tx({ tenantId }, (tx) => tx.one<Record<string, any>>(`select * from report_schedules where tenant_id = $1 and id = $2`, [tenantId, id]));
  if (!s) return { sent: 0 };
  let sent = 0;
  let reachable = 0;
  let lastError: string | null = null;
  const company = (await db.tx({ tenantId, readOnly: true }, (tx) => tx.one<{ name: string }>(`select name from tenants where id = $1`, [tenantId])))?.name ?? 'Synapse';
  for (const uid of s.recipients as string[]) {
    try {
      const out = await db.tx({ tenantId, userId: uid, readOnly: true }, async (tx) => {
        const ctx = await actAs(env, tx, tenantId, uid, 'digest');
        if (!ctx) return null;
        reachable++;
        const html = await renderDigest(ctx, s as never, origin);
        return { email: ctx.principal.user.email, html };
      });
      if (!out || !out.html) continue;
      const ok = await sendPlatformMail(env, { to: out.email, subject: `${s.name} · ${company}`, html: wrap(company, s.name, out.html, `${origin}/reports#digests`), text: `${s.name}\n\nOpen ${origin} to see the full numbers.` });
      if (ok) sent++;
      else lastError = 'Email could not be sent (is the platform mail key set?)';
    } catch (e) {
      lastError = (e as Error).message.slice(0, 300);
    }
  }
  // nobody on the list can sign in any more: switch the digest off rather than retrying forever
  const orphaned = !reachable && !lastError;
  await db.tx({ tenantId }, (tx) =>
    tx.query(
      `update report_schedules set last_sent_at = case when $3 > 0 then now() else last_sent_at end, last_error = $4, next_run_at = $5, is_enabled = is_enabled and not $6 where tenant_id = $1 and id = $2`,
      [tenantId, id, sent, orphaned ? 'Turned off: none of the recipients can sign in any more' : lastError, nextRun(s as ScheduleSpec), orphaned],
    ),
  );
  return { sent, error: lastError };
}

/** 5-minute cron: a KV timestamp keeps the database asleep until the next digest is due. */
export async function digestSweep(env: Env, db: Db) {
  const now = Date.now();
  if (env.CACHE_KV) {
    const next = await env.CACHE_KV.get(KV_KEY).catch(() => null);
    if (next && Date.parse(next) > now) return;
  }
  const origin = env.APP_HOST ? `https://${env.APP_HOST}` : `https://${env.BASE_DOMAIN}`;
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let earliest = now + 6 * 3600_000;
  for (const t of tenants) {
    // claimed first (pushed 30 minutes ahead), so two overlapping runs never send the same digest twice
    const due = await db.tx({ tenantId: t.tenant_id }, (tx) =>
      tx.query<{ id: string }>(
        `update report_schedules set next_run_at = now() + interval '30 minutes' where id in (
           select id from report_schedules where tenant_id = $1 and is_enabled and next_run_at <= now() order by next_run_at limit 20 for update skip locked)
         returning id`,
        [t.tenant_id],
      ),
    );
    for (const d of due) await sendSchedule(env, db, t.tenant_id, d.id, origin).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'digest', id: d.id, msg: (e as Error).message })));
    const n = await db.tx({ tenantId: t.tenant_id, readOnly: true }, (tx) => tx.one<{ t: Date | null }>(`select min(next_run_at) as t from report_schedules where tenant_id = $1 and is_enabled`, [t.tenant_id]));
    if (n?.t && new Date(n.t).getTime() < earliest) earliest = new Date(n.t).getTime();
  }
  await env.CACHE_KV?.put(KV_KEY, new Date(earliest).toISOString()).catch(() => undefined);
}

/** A new or changed schedule may be due before the cached "next" time. */
export async function wakeDigests(env: Env) {
  await env.CACHE_KV?.delete(KV_KEY).catch(() => undefined);
}

export async function assertTarget(tx: Tx, tenantId: string, userId: string, kind: string, targetId: string | null) {
  if (kind === 'health' || kind === 'books') return;
  const table = kind === 'dashboard' ? 'dashboards' : 'reports';
  const r = await tx.one(`select 1 from ${table} where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [tenantId, targetId, userId]);
  if (!r) throw badRequest(`Choose a ${kind} you can open`);
}
