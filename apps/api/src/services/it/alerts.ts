/**
 * Email (and chat) alerts for work: every in-app work notification may also go by email, at once or
 * in a daily digest, as each person chooses for: assigned to me, @mentioned, items I watch, due soon.
 * Automation rules can post to a Teams / Slack / Google Chat connection. Messages wait in pm_outbox
 * and the 5-minute sweep sends them (a KV flag keeps idle workspaces asleep).
 */
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import { badRequest } from '../../lib/errors';
import type { Integration } from '../integrations';
import { mailerConfigured, sendPlatformMail } from '../mailer';
import type { RecordCtx } from '../records';

export type AlertCategory = 'assigned' | 'mentioned' | 'watching' | 'due' | 'rule';
export interface Prefs {
  assigned: 'off' | 'instant' | 'digest';
  mentioned: 'off' | 'instant' | 'digest';
  watching: 'off' | 'instant' | 'digest';
  due: 'off' | 'digest';
  digestHour: number;
}
const DEFAULTS: Prefs = { assigned: 'instant', mentioned: 'instant', watching: 'digest', due: 'digest', digestHour: 9 };
const KV_FLAG = 'pmmail:any';

export async function getPrefs(ctx: RecordCtx): Promise<Prefs & { emailOn: boolean }> {
  const r = await ctx.tx.one<{ assigned: Prefs['assigned']; mentioned: Prefs['mentioned']; watching: Prefs['watching']; due: Prefs['due']; digest_hour: number }>(
    `select assigned, mentioned, watching, due, digest_hour from pm_notify_prefs where tenant_id = $1 and user_id = $2`,
    [ctx.tenantId, ctx.principal.user.id],
  );
  return { ...(r ? { assigned: r.assigned, mentioned: r.mentioned, watching: r.watching, due: r.due, digestHour: r.digest_hour } : DEFAULTS), emailOn: true };
}

export async function savePrefs(ctx: RecordCtx, p: Partial<Prefs>) {
  const cur = await getPrefs(ctx);
  const n = { ...cur, ...p };
  if (n.digestHour < 0 || n.digestHour > 23) throw badRequest('Digest hour is 0–23');
  await ctx.tx.query(
    `insert into pm_notify_prefs (tenant_id, user_id, assigned, mentioned, watching, due, digest_hour) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, user_id) do update set assigned = excluded.assigned, mentioned = excluded.mentioned, watching = excluded.watching, due = excluded.due, digest_hour = excluded.digest_hour`,
    [ctx.tenantId, ctx.principal.user.id, n.assigned, n.mentioned, n.watching, n.due, n.digestHour],
  );
  return { ok: true };
}

/** Queues the email side of a work notification, following the person's preference. */
export async function queueMail(tx: Tx, tenantId: string, userId: string, category: AlertCategory, msg: { title: string; body?: string | null; link?: string | null }) {
  let mode: 'instant' | 'digest' | 'off' = category === 'rule' ? 'instant' : DEFAULTS[category as keyof Omit<Prefs, 'digestHour'>];
  if (category !== 'rule') {
    const p = await tx.one<Record<string, string>>(`select assigned, mentioned, watching, due from pm_notify_prefs where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    if (p) mode = p[category] as typeof mode;
  }
  if (mode === 'off') return;
  await tx.query(`insert into pm_outbox (tenant_id, user_id, category, mode, title, body, link) values ($1,$2,$3,$4,$5,$6,$7)`, [
    tenantId, userId, category, mode, msg.title.slice(0, 300), msg.body?.slice(0, 2000) ?? null, msg.link?.slice(0, 500) ?? null,
  ]);
}

/** In-app notification plus its email (as preferred). */
export async function workNotify(ctx: RecordCtx, userIds: (string | null | undefined)[], category: AlertCategory, msg: { title: string; body?: string | null; link: string }, opts: { includeSelf?: boolean } = {}) {
  const me = ctx.principal.user.id;
  for (const u of new Set(userIds.filter((x): x is string => !!x && (opts.includeSelf || x !== me)))) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'project',$3,$4,$5)`, [ctx.tenantId, u, msg.title.slice(0, 200), msg.body?.slice(0, 300) ?? null, msg.link]);
    await queueMail(ctx.tx, ctx.tenantId, u, category, msg);
  }
}

export async function queueChat(tx: Tx, tenantId: string, integrationId: string, msg: { title: string; body?: string | null; link?: string | null }) {
  await tx.query(`insert into pm_outbox (tenant_id, integration_id, category, mode, title, body, link) values ($1,$2,'rule','instant',$3,$4,$5)`, [
    tenantId, integrationId, msg.title.slice(0, 300), msg.body?.slice(0, 2000) ?? null, msg.link?.slice(0, 500) ?? null,
  ]);
}

let lastMark = 0;
/** After a change that may have queued alerts (throttled per isolate). */
export async function markAlertsPending(env: Env) {
  if (Date.now() - lastMark < 60_000) return;
  lastMark = Date.now();
  await env.CACHE_KV?.put(KV_FLAG, '1', { expirationTtl: 26 * 3600 }).catch(() => undefined);
}

/* ───────────────────────── sending ───────────────────────── */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const LABEL: Record<string, string> = { assigned: 'Assigned to you', mentioned: 'You were mentioned', watching: 'Items you watch', due: 'Due soon', rule: 'Automation' };

function mailOf(origin: string, heading: string, rows: { category: string; title: string; body: string | null; link: string | null }[]) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:620px;color:#0f172a">
<h2 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h2>
${[...groups.entries()]
  .map(
    ([c, list]) => `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:18px 0 6px">${esc(LABEL[c] ?? c)}</h3>
${list.map((r) => `<div style="padding:8px 0;border-bottom:1px solid #e2e8f0"><a href="${esc(r.link ? new URL(r.link, origin).toString() : origin)}" style="color:#0b5cad;text-decoration:none;font-weight:600">${esc(r.title)}</a>${r.body ? `<div style="color:#475569;font-size:13px;margin-top:2px">${esc(r.body)}</div>` : ''}</div>`).join('\n')}`,
  )
  .join('\n')}
<p style="color:#94a3b8;font-size:12px;margin-top:18px">Change what you get by email in SanchalanOS → My account → Work alerts.</p></div>`;
  const text = [heading, '', ...rows.map((r) => `- ${r.title}${r.body ? ` — ${r.body}` : ''}${r.link ? `\n  ${new URL(r.link, origin).toString()}` : ''}`)].join('\n');
  return { html, text };
}

/** Sends instant mail now and each person's digest at their hour. */
export async function workMailSweep(env: Env, db: Db) {
  // queued alerts set the flag; the top of each hour runs anyway (digests, missed flags)
  if (env.CACHE_KV && new Date().getUTCMinutes() >= 5 && (await env.CACHE_KV.get(KV_FLAG).catch(() => null)) === null) return;
  const origin = env.APP_HOST ? `https://${env.APP_HOST}` : env.BASE_DOMAIN ? `https://${env.BASE_DOMAIN}` : 'http://localhost:5173';
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let left = 0;
  // the hour in India (digests are set as a local hour)
  const istHour = new Date(Date.now() + 5.5 * 3_600_000).getUTCHours();
  for (const t of tenants) {
    const batch = await db.tx({ tenantId: t.tenant_id }, async (tx) => {
      // claimed first so overlapping runs never send twice
      const rows = await tx.query<{ id: string; user_id: string | null; integration_id: string | null; category: string; mode: string; title: string; body: string | null; link: string | null; email: string | null; full_name: string | null; digest_hour: number | null; last_digest_at: Date | null }>(
        `with c as (
           select o.id from pm_outbox o left join pm_notify_prefs p on p.tenant_id = o.tenant_id and p.user_id = o.user_id
            where o.tenant_id = $1 and o.sent_at is null and (o.mode = 'instant' or (coalesce(p.digest_hour, 9) = $2 and (p.last_digest_at is null or p.last_digest_at < now() - interval '20 hours')))
            order by o.created_at limit 300 for update of o skip locked)
         update pm_outbox o set sent_at = now() from c where o.id = c.id
         returning o.id, o.user_id, o.integration_id, o.category, o.mode, o.title, o.body, o.link,
                   (select email from users u where u.tenant_id = o.tenant_id and u.id = o.user_id and u.status = 'active') as email,
                   (select full_name from users u where u.tenant_id = o.tenant_id and u.id = o.user_id) as full_name,
                   (select digest_hour from pm_notify_prefs p where p.tenant_id = o.tenant_id and p.user_id = o.user_id) as digest_hour, null::timestamptz as last_digest_at`,
        [t.tenant_id, istHour],
      );
      const digestUsers = [...new Set(rows.filter((r) => r.mode === 'digest' && r.user_id).map((r) => r.user_id!))];
      for (const u of digestUsers)
        await tx.query(`insert into pm_notify_prefs (tenant_id, user_id, last_digest_at) values ($1,$2,now()) on conflict (tenant_id, user_id) do update set last_digest_at = now()`, [t.tenant_id, u]);
      const chats = rows.filter((r) => r.integration_id);
      const ints = chats.length ? await tx.query<Integration>(`select * from integrations where tenant_id = $1 and id = any($2::uuid[]) and status = 'active'`, [t.tenant_id, [...new Set(chats.map((c) => c.integration_id!))]]) : [];
      const pending = (await tx.one<{ n: number }>(`select count(*)::int as n from pm_outbox where tenant_id = $1 and sent_at is null`, [t.tenant_id]))?.n ?? 0;
      return { rows, ints, pending };
    });
    left += batch.pending;
    // email: one message per person per kind of run
    const byUser = new Map<string, typeof batch.rows>();
    for (const r of batch.rows) if (r.user_id && r.email) byUser.set(`${r.user_id}|${r.mode}`, [...(byUser.get(`${r.user_id}|${r.mode}`) ?? []), r]);
    if (mailerConfigured(env))
      for (const [k, list] of byUser) {
        const digest = k.endsWith('|digest');
        const heading = digest ? `Your work digest — ${list.length} update${list.length > 1 ? 's' : ''}` : list.length === 1 ? list[0]!.title : `${list.length} work updates`;
        const m = mailOf(origin, heading, list);
        await sendPlatformMail(env, { to: list[0]!.email!, subject: digest ? `SanchalanOS digest: ${list.length} work update${list.length > 1 ? 's' : ''}` : list.length === 1 ? list[0]!.title : `SanchalanOS: ${list.length} work updates`, html: m.html, text: m.text }).catch(() => false);
      }
    if (batch.rows.some((r) => r.integration_id)) {
      const { postChat } = await import('../industry/connectors');
      for (const r of batch.rows.filter((x) => x.integration_id)) {
        const i = batch.ints.find((x) => x.id === r.integration_id);
        if (i) await postChat(env, i, { title: r.title, text: r.body ?? '', link: r.link ? new URL(r.link, origin).toString() : null }).catch(() => undefined);
      }
    }
  }
  if (env.CACHE_KV && !left) await env.CACHE_KV.delete(KV_FLAG).catch(() => undefined);
}

/** Once a day: items due tomorrow or overdue, for their assignees (digest). */
export async function queueDueSoon(db: Db, tenantId: string) {
  await db.tx({ tenantId }, async (tx) => {
    const rows = await tx.query<{ id: string; project_id: string; task_number: number; name: string; due_date: string; work_key: string | null; assignees: string[] }>(
      `select t.id, t.project_id, t.task_number, t.name, t.due_date::text, p.work_key, t.assignees from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
        where t.tenant_id = $1 and t.status not in ('done','cancelled') and t.due_date <= current_date + 1 and t.due_date >= current_date - 7 and cardinality(t.assignees) > 0 and p.deleted_at is null limit 2000`,
      [tenantId],
    );
    for (const r of rows)
      for (const u of r.assignees)
        await queueMail(tx, tenantId, u, 'due', { title: `${r.work_key ?? 'ITEM'}-${r.task_number} ${r.name}`, body: r.due_date < new Date().toISOString().slice(0, 10) ? `Overdue since ${r.due_date}` : `Due ${r.due_date}`, link: `/projects/${r.project_id}?item=${r.id}` });
  });
}
