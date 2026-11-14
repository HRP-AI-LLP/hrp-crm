/**
 * The hourly intelligence sweep (from the 5-minute cron, KV-gated so the database sleeps between
 * runs): links stray emails, refreshes deal-risk and account-health scores, finds risks and
 * opportunities for the insights feed, notifies owners once, prepares briefs for tomorrow's
 * meetings when that agent may run on its own, and adds new conversations to the search index.
 * Everything except auto meeting prep is rule-based SQL: no AI quota is spent.
 */
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import type { RecordCtx } from '../records';
import { actAs, systemCtxFor } from '../system';
import { enqueue } from '../jobs';
import { growthOpportunities, runAgent, settingsOf, stalledDays } from './agents';
import { resolveUnlinked } from './context';
import { indexInteractions } from './ask';
import { accountHealth, accountSignals, dealRisk, dealSignals, saveScores } from './scores';

const KV_KEY = 'intel:next';
const EVERY = 60 * 60_000;

interface Found {
  kind: string;
  severity: 'info' | 'warn' | 'risk' | 'opportunity';
  title: string;
  body?: string;
  object: string | null;
  id: string | null;
  ownerId: string | null;
  dedupe: string;
  score?: number | null;
}

/** Runs the rule-based detectors for one workspace and syncs the insights table with them. */
export async function detectInsights(ctx: RecordCtx) {
  const tx = ctx.tx;
  const t = ctx.tenantId;
  const found: Found[] = [];
  // a standing risk comes back once a week after a dismissal (the key changes weekly)
  const week = `${new Date().getUTCFullYear()}w${Math.floor((Date.now() / 86_400_000 + 4) / 7)}`;
  // insight text is shown to anyone who can open the record: only deal-level and conversation factors
  const safe = (fs: { label: string; object: string; field?: string; impact: number }[], sign: 1 | -1) => fs.filter((f) => (f.object === 'activity' || f.object === 'deal') && !f.field && f.impact * sign > 0).slice(0, 3).map((f) => f.label).join(' · ');
  const evaluated = new Map<string, Set<string>>();
  const mark = (kind: string, id: string | null) => {
    if (!id) return;
    const s = evaluated.get(kind) ?? new Set<string>();
    s.add(id);
    evaluated.set(kind, s);
  };

  // scores
  const sd = stalledDays(await settingsOf(tx, t, 'deal_risk'));
  const deals = (await dealSignals(tx, t)).map((s) => dealRisk(s, Date.now(), sd));
  const accounts = (await accountSignals(tx, t)).map((s) => accountHealth(s));
  await saveScores(tx, t, [...deals, ...accounts]);
  for (const d of deals) {
    mark('deal_risk', d.recordId);
    if (d.band === 'bad') found.push({ kind: 'deal_risk', severity: 'risk', title: `${d.title} is at risk (${d.score}/100)`, body: safe(d.factors, 1) || 'Open the deal to see what drives the score.', object: 'deal', id: d.recordId, ownerId: d.ownerId, dedupe: `deal_risk:${d.recordId}:${week}`, score: d.score });
  }
  for (const a of accounts) {
    mark('account_health', a.recordId);
    if (a.band === 'bad') found.push({ kind: 'account_health', severity: 'risk', title: `${a.title} needs attention (health ${a.score}/100)`, body: safe(a.factors, -1) || 'Open the account to see what drives the score.', object: 'account', id: a.recordId, ownerId: a.ownerId, dedupe: `account_health:${a.recordId}:${week}`, score: a.score });
  }

  // slipped close dates
  const slipped = await tx.query<{ id: string; name: string; owner_id: string | null; close_date: string }>(
    `select d.id, d.name, d.owner_id, d.close_date::text from deals d join pipeline_stages st on st.tenant_id = d.tenant_id and st.id = d.stage_id
      where d.tenant_id = $1 and d.deleted_at is null and st.category = 'open' and d.close_date < current_date order by d.close_date desc limit 300`,
    [t],
  );
  for (const d of deals) mark('deal_slipped', d.recordId);
  for (const d of slipped) found.push({ kind: 'deal_slipped', severity: 'warn', title: `${d.name}: the expected close date has passed`, body: 'Update the close date or the stage so the forecast stays honest.', object: 'deal', id: d.id, ownerId: d.owner_id, dedupe: `deal_slipped:${d.id}:${d.close_date}` });

  // new leads nobody has answered
  const waitHours = Math.min(72, Math.max(1, Number((await settingsOf(tx, t, 'rep_focus')).settings?.leadWaitHours ?? 4) || 4));
  const leads = await tx.query<{ id: string; full_name: string; owner_id: string | null; created_at: Date; source: string | null }>(
    `select l.id, l.full_name, l.owner_id, l.created_at, l.source from leads l
      where l.tenant_id = $1 and l.deleted_at is null and l.converted_at is null and l.created_at between now() - interval '7 days' and now() - make_interval(hours => $2::int)
        and not exists (select 1 from activities a where a.tenant_id = l.tenant_id and a.related_object = 'lead' and a.related_id = l.id and a.kind in ('call','email','whatsapp','sms','meeting') and (a.direction = 'out' or a.direction is null))
        and not exists (select 1 from messages m where m.tenant_id = l.tenant_id and m.related_object = 'lead' and m.related_id = l.id and m.direction = 'out')
      order by l.created_at limit 200`,
    [t, waitHours],
  );
  const recentLeads = await tx.query<{ id: string }>(`select id from leads where tenant_id = $1 and created_at > now() - interval '8 days'`, [t]);
  for (const l of recentLeads) mark('lead_waiting', l.id);
  for (const l of leads) {
    const hrs = Math.round((Date.now() - new Date(l.created_at).getTime()) / 3_600_000);
    found.push({ kind: 'lead_waiting', severity: 'warn', title: `${l.full_name} has waited ${hrs < 48 ? `${hrs} hours` : `${Math.round(hrs / 24)} days`} for a reply`, body: `New ${l.source ? `${l.source.replace(/_/g, ' ')} ` : ''}lead with no call or message yet. Leads answered within the hour convert far more often.`, object: 'lead', id: l.id, ownerId: l.owner_id, dedupe: `lead_waiting:${l.id}` });
  }

  // meetings in the next day without a brief
  const meets = await tx.query<{ id: string; title: string; owner_id: string | null; starts_at: Date; related_object: string; related_id: string }>(
    `select e.id, e.title, e.owner_id, e.starts_at, e.related_object, e.related_id from events e
      where e.tenant_id = $1 and e.status = 'scheduled' and e.starts_at between now() and now() + interval '24 hours' and e.related_object in ('lead','contact','account','deal')
        and not exists (select 1 from meeting_notes n where n.tenant_id = e.tenant_id and n.event_id = e.id and n.prep_run_id is not null) limit 200`,
    [t],
  );
  const upcoming = await tx.query<{ id: string }>(`select id from events where tenant_id = $1 and starts_at between now() - interval '1 day' and now() + interval '2 days'`, [t]);
  for (const e of upcoming) mark('meeting_prep', e.id);
  for (const e of meets) found.push({ kind: 'meeting_prep', severity: 'info', title: `Prepare for "${e.title}"`, body: `Starts ${new Date(e.starts_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}. A brief takes a few seconds.`, object: 'event', id: e.id, ownerId: e.owner_id, dedupe: `meeting_prep:${e.id}` });

  // quotes about to expire
  const quotes = await tx.query<{ id: string; name: string; owner_id: string | null; valid_until: string }>(
    `select id, name, owner_id, valid_until::text from quotes where tenant_id = $1 and status = 'sent' and deleted_at is null and valid_until between current_date and current_date + 3 limit 200`,
    [t],
  );
  const sentQuotes = await tx.query<{ id: string }>(`select id from quotes where tenant_id = $1 and deleted_at is null and valid_until > current_date - 30`, [t]);
  for (const q of sentQuotes) mark('quote_expiring', q.id);
  for (const q of quotes) found.push({ kind: 'quote_expiring', severity: 'warn', title: `Quote ${q.name} expires on ${q.valid_until}`, body: 'Follow up now, or extend it if the customer needs more time.', object: 'quote', id: q.id, ownerId: q.owner_id, dedupe: `quote_expiring:${q.id}:${q.valid_until}` });

  // late-stage deals with a competitor in play
  const comp = await tx.query<{ id: string; name: string; owner_id: string | null; competitors: string }>(
    `select d.id, d.name, d.owner_id, string_agg(c.name, ', ' order by c.name) as competitors from deals d
       join pipeline_stages st on st.tenant_id = d.tenant_id and st.id = d.stage_id
       join deal_competitors dc on dc.tenant_id = d.tenant_id and dc.deal_id = d.id and dc.status = 'active'
       join competitors c on c.tenant_id = dc.tenant_id and c.id = dc.competitor_id
      where d.tenant_id = $1 and d.deleted_at is null and st.category = 'open' and coalesce(d.probability, st.probability) >= 50
      group by d.id, d.name, d.owner_id limit 200`,
    [t],
  );
  for (const d of deals) mark('competitor', d.recordId);
  for (const d of comp) found.push({ kind: 'competitor', severity: 'warn', title: `${d.name}: up against ${d.competitors} at a late stage`, body: 'Run the competitive coach for positioning and answers to likely objections.', object: 'deal', id: d.id, ownerId: d.owner_id, dedupe: `competitor:${d.id}:${week}` });

  // repeat business
  const growthAccounts = accounts.filter((a) => a.band !== 'bad').slice(0, 120);
  for (const a of growthAccounts) {
    mark('growth', a.recordId);
    for (const o of await growthOpportunities(ctx, a.recordId)) found.push({ kind: 'growth', severity: 'opportunity', title: `${o.title}: ${a.title}`, body: `${o.why}. ${o.pitch}`, object: 'account', id: a.recordId, ownerId: a.ownerId, dedupe: `growth:${a.recordId}:${o.key}` });
  }

  // overdue follow-ups, one line per person
  const overdue = await tx.query<{ owner_id: string; n: number }>(
    `select owner_id, count(*)::int as n from action_items where tenant_id = $1 and owner_id is not null and status in ('open','in_progress') and due_at < now() - interval '1 hour' group by owner_id`,
    [t],
  );
  const people = await tx.query<{ id: string }>(`select id from users where tenant_id = $1`, [t]);
  for (const u of people) mark('actions_overdue', u.id);
  for (const o of overdue) found.push({ kind: 'actions_overdue', severity: 'warn', title: `${o.n} overdue action item${o.n > 1 ? 's' : ''}`, body: 'Close them, move the due date, or hand them over.', object: null, id: null, ownerId: o.owner_id, dedupe: `actions_overdue:${o.owner_id}` });

  for (let i = 0; i < found.length; i += 500) {
    const b = found.slice(i, i + 500);
    await tx.query(
      `insert into insights (tenant_id, kind, severity, title, body, related_object, related_id, owner_id, score, dedupe_key)
       select $1, k, sv, ti, bo, ro, ri, ow, sc, dk from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::uuid[], $8::uuid[], $9::numeric[], $10::text[]) as x(k, sv, ti, bo, ro, ri, ow, sc, dk)
       on conflict (tenant_id, dedupe_key) do update set title = excluded.title, body = excluded.body, severity = excluded.severity, score = excluded.score, owner_id = excluded.owner_id`,
      [t, b.map((f) => f.kind), b.map((f) => f.severity), b.map((f) => f.title.slice(0, 300)), b.map((f) => f.body?.slice(0, 2000) ?? null), b.map((f) => f.object), b.map((f) => f.id), b.map((f) => f.ownerId), b.map((f) => f.score ?? null), b.map((f) => f.dedupe)],
    );
  }

  // anything no longer true disappears (unless someone already acted on it or dismissed it).
  // Detectors that look at the whole workspace (not a capped sample) clear every stale insight of
  // their kind, including ones about deals that have since closed or been deleted.
  const keys = found.map((f) => f.dedupe);
  const WHOLE = ['deal_slipped', 'lead_waiting', 'meeting_prep', 'quote_expiring', 'competitor', 'actions_overdue'];
  await tx.query(`delete from insights where tenant_id = $1 and kind = any($2::text[]) and status in ('new','seen') and not (dedupe_key = any($3::text[]))`, [t, WHOLE, keys]);
  // risk insights: the sweep scores up to 400 open deals / accounts; closed or deleted ones lose theirs
  await tx.query(
    `delete from insights i where i.tenant_id = $1 and i.kind = 'deal_risk' and i.status in ('new','seen') and not exists (
       select 1 from deals d join pipeline_stages st on st.tenant_id = d.tenant_id and st.id = d.stage_id where d.tenant_id = i.tenant_id and d.id = i.related_id and d.deleted_at is null and st.category = 'open')`,
    [t],
  );
  await tx.query(`delete from insights i where i.tenant_id = $1 and i.kind in ('account_health','growth') and i.status in ('new','seen') and not exists (select 1 from accounts a where a.tenant_id = i.tenant_id and a.id = i.related_id and a.deleted_at is null)`, [t]);
  for (const [kind, ids] of evaluated) {
    const col = kind === 'actions_overdue' ? 'owner_id' : 'related_id';
    await tx.query(`delete from insights where tenant_id = $1 and kind = $2 and status in ('new','seen') and ${col} = any($3::uuid[]) and not (dedupe_key = any($4::text[]))`, [t, kind, [...ids], keys]);
  }

  // tell owners about new risks and opportunities, once each
  const fresh = await tx.query<{ id: string; owner_id: string; title: string; body: string | null; related_object: string | null; related_id: string | null; kind: string }>(
    `update insights set notified_at = now() where id in (
       select id from insights where tenant_id = $1 and notified_at is null and owner_id is not null and status = 'new' and severity in ('risk','opportunity','warn') order by created_at limit 40)
     returning id, owner_id, title, body, related_object, related_id, kind`,
    [t],
  );
  for (const f of fresh) {
    const link = f.related_object === 'event' ? `/copilot?meeting=${f.related_id}` : f.related_object && f.related_id ? `/o/${f.related_object}/${f.related_id}` : '/copilot';
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'insight',$3,$4,$5)`, [t, f.owner_id, f.title.slice(0, 200), f.body?.slice(0, 500) ?? null, link]);
  }
  return { insights: found.length, scores: deals.length + accounts.length, notified: fresh.length };
}

async function autoPrep(env: Env, db: Db, tenantId: string) {
  const plan = await db.tx({ tenantId, readOnly: true }, async (tx: Tx) => {
    const st = await settingsOf(tx, tenantId, 'meeting_prep');
    if (!st.enabled || !st.auto_run) return [];
    const used = await tx.one<{ n: number }>(`select count(*)::int as n from agent_runs where tenant_id = $1 and trigger = 'schedule' and started_at > now() - interval '1 day'`, [tenantId]);
    const left = Math.max(0, st.daily_budget - (used?.n ?? 0));
    if (!left) return [];
    return tx.query<{ id: string; owner_id: string }>(
      `select e.id, e.owner_id from events e where e.tenant_id = $1 and e.status = 'scheduled' and e.owner_id is not null and e.starts_at between now() and now() + interval '18 hours'
          and e.related_object in ('lead','contact','account','deal')
          and not exists (select 1 from meeting_notes n where n.tenant_id = e.tenant_id and n.event_id = e.id and n.prep_run_id is not null)
        order by e.starts_at limit $2`,
      [tenantId, Math.min(left, 10)],
    );
  });
  let done = 0;
  for (const e of plan) {
    try {
      const who = await db.tx({ tenantId, userId: e.owner_id, readOnly: true }, (tx) => actAs(env, tx, tenantId, e.owner_id, 'agent'));
      if (!who) continue;
      await runAgent({ env, db, tenantId, principal: who.principal, meta: who.meta }, 'meeting_prep', { object: 'event', id: e.id }, {}, { trigger: 'schedule' });
      done++;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', job: 'intel.autoprep', event: e.id, msg: (err as Error).message }));
    }
  }
  return done;
}

/** One part of a workspace's sweep (each part is its own job, so none can starve the others). */
export async function intelSweepPart(env: Env, db: Db, tenantId: string, part: 'detect' | 'prep' | 'index') {
  if (part === 'detect')
    return db.tx({ tenantId }, async (tx) => {
      const ctx = await systemCtxFor(env, tx, tenantId);
      if (!ctx) return null;
      await resolveUnlinked(tx, tenantId, 100);
      return detectInsights(ctx);
    });
  if (part === 'prep') return autoPrep(env, db, tenantId);
  return indexInteractions(env, db, tenantId);
}

/** All parts in order (tests and manual runs). */
export async function intelSweepTenant(env: Env, db: Db, tenantId: string) {
  const res = await intelSweepPart(env, db, tenantId, 'detect');
  const prepped = await intelSweepPart(env, db, tenantId, 'prep');
  const indexed = await intelSweepPart(env, db, tenantId, 'index').catch((e) => {
    console.error(JSON.stringify({ level: 'error', job: 'intel.index', tenantId, msg: (e as Error).message }));
    return 0;
  });
  return { ...((res as object) ?? {}), prepped, indexed } as { insights?: number; scores?: number; notified?: number; prepped: unknown; indexed: unknown };
}

/** 5-minute cron entry: at most hourly; queues one job per workspace and part. */
export async function intelSweep(env: Env, db: Db) {
  const now = Date.now();
  if (env.CACHE_KV) {
    const next = await env.CACHE_KV.get(KV_KEY).catch(() => null);
    if (next && Date.parse(next) > now) return;
  }
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  // the gate moves only once the work is queued, so a failed run is retried by the next cron tick
  await enqueue(env, null, tenants.flatMap((t) => (['detect', 'prep', 'index'] as const).map((part) => ({ type: 'intel.sweep' as const, tenantId: t.tenant_id, part }))));
  await env.CACHE_KV?.put(KV_KEY, new Date(now + EVERY).toISOString()).catch(() => undefined);
}
