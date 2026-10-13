/**
 * Sales forecast by rep for a month or quarter: quota, closed won, commit, best case, pipeline
 * and probability-weighted amount. Deals land in a category by stage (won → closed) or by the
 * deal's own forecast_category, falling back to stage probability (≥70 commit, ≥40 best case).
 * Uses the same visibility rules as deal lists, so reps see only what they may read.
 */
import { fieldAccess } from '@synapse/shared';
import { forbidden } from '../lib/errors';
import { Params, type RecordCtx, visibilityWhere } from './records';

export type Period = 'month' | 'quarter';

export function periodRange(period: Period, start: string): { from: string; to: string; months: string[] } {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const firstMonth = period === 'quarter' ? Math.floor((m - 1) / 3) * 3 + 1 : m;
  const n = period === 'quarter' ? 3 : 1;
  const months = Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, firstMonth - 1 + i, 1)).toISOString().slice(0, 10));
  const to = new Date(Date.UTC(y, firstMonth - 1 + n, 1)).toISOString().slice(0, 10);
  return { from: months[0]!, to, months };
}

export const CATEGORY_SQL = `case
  when s.category = 'won' then 'closed'
  when s.category = 'lost' then 'lost'
  when r.forecast_category is not null then r.forecast_category
  when coalesce(r.probability, s.probability) >= 70 then 'commit'
  when coalesce(r.probability, s.probability) >= 40 then 'best_case'
  else 'pipeline' end`;

export async function forecast(ctx: RecordCtx, period: Period, start: string) {
  if (fieldAccess(ctx.principal.permissions, 'deal', 'amount') === 'hidden') throw forbidden('You cannot see deal amounts');
  const { from, to, months } = periodRange(period, start);
  const p = new Params();
  const where = visibilityWhere(ctx, 'deal', p);
  const f = p.add(from);
  const t = p.add(to);
  const rows = await ctx.tx.query<{ owner_id: string | null; category: string; amount: number; weighted: number; n: number }>(
    `select r.owner_id, ${CATEGORY_SQL} as category,
            coalesce(sum(r.amount), 0)::float8 as amount,
            coalesce(sum(r.amount * coalesce(r.probability, s.probability) / 100.0), 0)::float8 as weighted,
            count(*)::int as n
       from deals r
       join pipeline_stages s on s.tenant_id = r.tenant_id and s.id = r.stage_id
      where ${where.join(' and ')} and r.close_date >= ${f}::date and r.close_date < ${t}::date
      group by 1, 2`,
    p.values,
  );
  const quotas = await ctx.tx.query<{ user_id: string; amount: number }>(
    `select user_id, sum(amount)::float8 as amount from quotas where tenant_id = $1 and period_start = any($2::date[]) group by user_id`,
    [ctx.tenantId, months],
  );
  const users = await ctx.tx.query<{ id: string; full_name: string }>(`select id, full_name from users where tenant_id = $1 and status = 'active' order by full_name`, [ctx.tenantId]);

  type Row = { userId: string | null; name: string; quota: number; closed: number; commit: number; best_case: number; pipeline: number; lost: number; omitted: number; weighted: number; deals: number };
  const byUser = new Map<string, Row>();
  const row = (id: string | null): Row => {
    const k = id ?? 'none';
    if (!byUser.has(k)) byUser.set(k, { userId: id, name: users.find((u) => u.id === id)?.full_name ?? 'Unassigned', quota: 0, closed: 0, commit: 0, best_case: 0, pipeline: 0, lost: 0, omitted: 0, weighted: 0, deals: 0 });
    return byUser.get(k)!;
  };
  for (const q of quotas) row(q.user_id).quota = q.amount;
  for (const r of rows) {
    const x = row(r.owner_id);
    const cat = r.category as keyof Row;
    if (cat in x && typeof x[cat] === 'number') (x[cat] as number) += r.amount;
    if (r.category !== 'lost' && r.category !== 'omitted') {
      x.weighted += r.category === 'closed' ? r.amount : r.weighted;
      x.deals += r.n;
    }
  }
  const reps = [...byUser.values()].sort((a, b) => b.closed + b.commit - (a.closed + a.commit) || a.name.localeCompare(b.name));
  const total = reps.reduce<Omit<Row, 'userId' | 'name'>>(
    (a, r) => ({ quota: a.quota + r.quota, closed: a.closed + r.closed, commit: a.commit + r.commit, best_case: a.best_case + r.best_case, pipeline: a.pipeline + r.pipeline, lost: a.lost + r.lost, omitted: a.omitted + r.omitted, weighted: a.weighted + r.weighted, deals: a.deals + r.deals }),
    { quota: 0, closed: 0, commit: 0, best_case: 0, pipeline: 0, lost: 0, omitted: 0, weighted: 0, deals: 0 },
  );
  return { period, from, to, months, reps, total };
}

/** Deals behind one forecast cell (for drill-down). */
export async function forecastDeals(ctx: RecordCtx, period: Period, start: string, category: string, ownerId: string | null) {
  const { from, to } = periodRange(period, start);
  const p = new Params();
  const where = visibilityWhere(ctx, 'deal', p);
  where.push(`r.close_date >= ${p.add(from)}::date and r.close_date < ${p.add(to)}::date`);
  where.push(`${CATEGORY_SQL} = ${p.add(category)}`);
  if (ownerId) where.push(`r.owner_id = ${p.add(ownerId)}::uuid`);
  return ctx.tx.query<{ id: string; name: string; amount: number | null; close_date: string; probability: number; stage: string }>(
    `select r.id, r.name, r.amount::float8 as amount, to_char(r.close_date, 'YYYY-MM-DD') as close_date, coalesce(r.probability, s.probability) as probability, s.label as stage
       from deals r join pipeline_stages s on s.tenant_id = r.tenant_id and s.id = r.stage_id
      where ${where.join(' and ')} order by r.amount desc nulls last limit 200`,
    p.values,
  );
}
