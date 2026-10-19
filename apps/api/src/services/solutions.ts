/**
 * Installing an industry solution: its module (fields, pipeline, objects, automations, AI
 * context), the apps it runs on, and the operating defaults (payment plan, installation
 * checklist, KPI targets). Existing customisations are kept unless the admin asks to overwrite.
 */
import { APPS, SOLUTIONS } from '@synapse/shared';
import { notFound } from '../lib/errors';
import { enableApp, enabledApps } from './apps';
import { installModule } from './metadata-admin';
import type { RecordCtx } from './records';

export function listSolutions(ctx: RecordCtx) {
  const installed = new Set(ctx.meta.modules.filter((m) => m.enabled).map((m) => m.key));
  return Object.values(SOLUTIONS).map((s) => ({
    key: s.key,
    name: s.name,
    tagline: s.tagline,
    forWho: s.forWho,
    highlights: s.highlights,
    apps: s.apps.map((a) => APPS[a]?.name ?? a),
    milestonePlan: s.milestonePlan,
    pipeline: s.module.pipelines[0]?.stages.map((st) => st.label) ?? [],
    leadFields: s.module.fields.find((f) => f.object === 'lead')?.fields.map((f) => f.label) ?? [],
    installed: installed.has(s.module.key),
  }));
}

export async function installSolution(ctx: RecordCtx, key: string, opts: { overwrite: boolean }) {
  const s = SOLUTIONS[key];
  if (!s) throw notFound('Unknown industry solution');
  await installModule(ctx.tx, ctx.tenantId, s.module.key);
  // apps switch on in dependency order (orders before delivery)
  const on = enabledApps(ctx.meta);
  const order = [...s.apps].sort((a, b) => (APPS[b]?.requires.includes(a) ? -1 : APPS[a]?.requires.includes(b) ? 1 : 0));
  const switched: string[] = [];
  for (const a of order) {
    if (on.has(a)) continue;
    await enableApp(ctx, a);
    ctx.meta.modules.push({ key: `app.${a}`, version: '1', enabled: true });
    on.add(a);
    switched.push(a);
  }
  const cur = await ctx.tx.one<{ settings: Record<string, any> }>(`select settings from tenants where id = $1`, [ctx.tenantId]);
  const st = cur?.settings ?? {};
  const setPlan = opts.overwrite || !st.orders?.milestonePlan?.length;
  const setChecklist = opts.overwrite || !st.installation?.checklist?.length;
  await ctx.tx.query(
    `update tenants set settings = coalesce(settings, '{}'::jsonb)
        || jsonb_build_object('industry', $2::text)
        || case when $3 then jsonb_build_object('orders', coalesce(settings -> 'orders', '{}'::jsonb) || jsonb_build_object('milestonePlan', $4::jsonb)) else '{}'::jsonb end
        || case when $5 then jsonb_build_object('installation', coalesce(settings -> 'installation', '{}'::jsonb) || jsonb_build_object('checklist', $6::jsonb)) else '{}'::jsonb end
      where id = $1`,
    [ctx.tenantId, s.key, setPlan, JSON.stringify(s.milestonePlan), setChecklist, JSON.stringify(s.installChecklist)],
  );
  let targets = 0;
  for (const [k, v] of Object.entries(s.kpiTargets)) {
    const r = await ctx.tx.query(
      opts.overwrite
        ? `insert into kpi_targets (tenant_id, kpi, target) values ($1,$2,$3) on conflict (tenant_id, kpi) do update set target = excluded.target returning 1`
        : `insert into kpi_targets (tenant_id, kpi, target) values ($1,$2,$3) on conflict do nothing returning 1`,
      [ctx.tenantId, k, v],
    );
    targets += r.length;
  }
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'install', 'industry_solution', $2)`, [ctx.tenantId, JSON.stringify({ key, switched, milestonePlan: setPlan, checklist: setChecklist, targets })]);
  return { solution: s.key, appsSwitchedOn: switched, milestonePlan: setPlan, checklist: setChecklist, targets };
}

/** The workspace's usual payment plan (from its industry solution or Settings). */
export async function milestonePlan(ctx: RecordCtx) {
  const r = await ctx.tx.one<{ p: { name: string; percent: number; trigger: string }[] | null }>(`select settings -> 'orders' -> 'milestonePlan' as p from tenants where id = $1`, [ctx.tenantId]);
  return Array.isArray(r?.p) ? r!.p : null;
}
