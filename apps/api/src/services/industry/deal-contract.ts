/**
 * When a deal is won and it is IT / software work, its contract opens on its own (draft, under the
 * IT suite's contracts) with the customer, value, dates and pricing carried over, so bid documents,
 * award letters, SOWs, NDAs and the rest can be kept on it. The deal's own files show there too.
 * Settings (tenants.settings.autoContract): "it" (default: IT / software deals), "all" or "off".
 */
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import { enabledApps } from '../apps';
import { saveContract } from '../it/contracts';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';

const IT_WORDS = /\b(software|it|app|apps|application|portal|website|web|mobile|erp|crm|saas|cloud|digital|development|developer|implementation|integration|automation|ai|ml|data|analytics|dashboard|devops|cyber|security|network|server|hosting|licen[cs]e|subscription|support|amc|maintenance|consult|consulting|outsourc|it services|managed services)\b/i;
const IT_SAC = /^99(83|84|73)/; // IT & consulting, telecom / online content, software licences
const IT_PRICING = new Set(['hourly', 'daily', 'per_task', 'per_person_month', 'monthly_retainer', 'subscription', 'milestone']);

export async function autoContractMode(tx: Tx, tenantId: string): Promise<'it' | 'all' | 'off'> {
  const r = await tx.one<{ v: string | null }>(`select settings ->> 'autoContract' as v from tenants where id = $1`, [tenantId]);
  return r?.v === 'all' || r?.v === 'off' ? r.v : 'it';
}

/** Does this deal look like IT / software work? (name, pipeline, pricing, charges and quote lines) */
export async function isItDeal(tx: Tx, tenantId: string, dealId: string) {
  const d = await tx.one<{ name: string; pricing_model: string | null; pipeline: string | null; industry: string | null }>(
    `select d.name, d.pricing_model, p.name as pipeline, a.industry from deals d left join pipelines p on p.tenant_id = d.tenant_id and p.id = d.pipeline_id
       left join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id where d.tenant_id = $1 and d.id = $2`,
    [tenantId, dealId],
  );
  if (!d) return false;
  if (IT_WORDS.test(d.name) || IT_WORDS.test(d.pipeline ?? '')) return true;
  if (d.pricing_model && IT_PRICING.has(d.pricing_model)) return true;
  const lines = await tx.query<{ name: string; hsn_sac: string | null }>(
    `select name, hsn_sac from deal_charges where tenant_id = $1 and deal_id = $2
     union all select l.name, l.hsn_sac from quote_lines l join quotes q on q.tenant_id = l.tenant_id and q.id = l.quote_id where q.tenant_id = $1 and q.deal_id = $2 and q.deleted_at is null`,
    [tenantId, dealId],
  );
  return lines.some((l) => IT_SAC.test(l.hsn_sac ?? '') || IT_WORDS.test(l.name));
}

const KIND: Record<string, 'retainer' | 'time_materials' | 'fixed_bid' | 'support' | 'enterprise_licence'> = {
  hourly: 'time_materials', daily: 'time_materials', per_task: 'time_materials', per_person_month: 'time_materials', monthly_retainer: 'retainer', subscription: 'enterprise_licence',
};

export async function contractForWonDeal(ctx: RecordCtx, dealId: string, force = false): Promise<{ id: string; number?: string } | null> {
  const tx = ctx.tx;
  const existing = await tx.one<{ id: string }>(`select id from service_contracts where tenant_id = $1 and deal_id = $2`, [ctx.tenantId, dealId]);
  if (existing) return existing;
  const d = await tx.one<{ name: string; account_id: string | null; amount: string | null; pricing_model: string | null; duration_months: string | null; recurring_monthly: string | null; owner_id: string | null; bid_number: string | null; cat: string; closed: string | null }>(
    `select d.name, d.account_id, d.amount, d.pricing_model, d.duration_months, d.recurring_monthly, d.owner_id, d.bid_number, s.category as cat, coalesce(d.closed_at, now())::date::text as closed
       from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = $1 and d.id = $2 and d.deleted_at is null`,
    [ctx.tenantId, dealId],
  );
  if (!d || !d.account_id || (!force && d.cat !== 'won')) return null;
  if (!force) {
    const mode = await autoContractMode(tx, ctx.tenantId);
    if (mode === 'off') return null;
    if (mode === 'it' && !(await isItDeal(tx, ctx.tenantId, dealId))) return null;
  }
  const project = await tx.one<{ id: string }>(`select id from projects where tenant_id = $1 and deal_id = $2 and deleted_at is null order by created_at limit 1`, [ctx.tenantId, dealId]);
  const months = Number(d.duration_months ?? 0);
  const end = months > 0 ? new Date(Date.parse(`${d.closed}T00:00:00Z`) + Math.round(months * 30.44) * 86_400_000).toISOString().slice(0, 10) : null;
  const recurring = Number(d.recurring_monthly ?? 0);
  const r = await saveContract(ctx, null, {
    name: d.name.slice(0, 200),
    accountId: d.account_id,
    projectId: project?.id ?? null,
    kind: KIND[d.pricing_model ?? ''] ?? (recurring > 0 ? 'support' : 'fixed_bid'),
    startDate: d.closed!,
    endDate: end,
    value: Number(d.amount ?? 0),
    billingFrequency: recurring > 0 ? 'monthly' : d.pricing_model === 'milestone' ? 'milestone' : 'none',
    periodFee: recurring > 0 ? recurring : null,
    ownerId: d.owner_id,
    terms: d.bid_number ? `Bid / tender: ${d.bid_number}` : null,
  });
  await tx.query(`update service_contracts set deal_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.id, dealId]);
  await tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'deal',$3)`, [ctx.tenantId, `Contract ${r.number ?? ''} opened for the won deal`.replace('  ', ' '), dealId]);
  if (d.owner_id) {
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'assignment',$3,$4,$5)`, [
      ctx.tenantId, d.owner_id, `Contract opened: ${r.number ?? d.name}`, 'Upload the bid, award letter, SOW, NDA and other documents to it.', `/it/contracts?contract=${r.id}`,
    ]);
  }
  return r;
}

/** Worker hook: a deal moved to a won stage. */
export async function onDealWon(env: Env, db: Db, tenantId: string, dealId: string) {
  return db.tx({ tenantId }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    if (!ctx || !enabledApps(ctx.meta).has('projects')) return null;
    return contractForWonDeal(ctx, dealId);
  });
}
