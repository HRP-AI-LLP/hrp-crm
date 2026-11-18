/**
 * What a deal is worth, charge by charge, in the deal's currency: one-time charges (a website build, a
 * domain), hourly ones (rate per hour × estimated hours, billed from timesheets) and recurring ones
 * (monthly maintenance). The deal shows the one-time total, the recurring amount per month and an
 * amount of one-time + the first year of recurring. Once won, "Set up billing" creates in one go:
 *
 *  - a fixed-price project for the work (when the projects app is on),
 *  - a draft invoice for the one-time charges,
 *  - a recurring invoice for each recurring schedule, created (and issued, if chosen) on its own dates;
 *    each invoice it creates carries the deal, the project and the recurring profile.
 */
import { z } from 'zod';
import { badRequest, conflict } from '../lib/errors';
import { enabledApps } from './apps';
import { saveInvoiceLines } from './billing';
import { saveRecurring } from './books/setup';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, updateRecord } from './records';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const chargeSchema = z.object({
  kind: z.enum(['one_time', 'recurring', 'hourly']),
  productId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  hsnSac: z.string().trim().max(20).nullish(),
  quantity: z.coerce.number().positive().max(1e6).default(1),
  unitPrice: z.coerce.number().min(0).max(1e12),
  taxRate: z.coerce.number().min(0).max(100).default(18),
  taxInclusive: z.boolean().default(false),
  frequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']).nullish(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** how many times it is billed; empty = until stopped */
  periods: z.coerce.number().int().min(1).max(600).nullish(),
});
export type ChargeInput = z.infer<typeof chargeSchema>;

const MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 } as const;

/** Taxable value (before GST) of one charge, per billing. */
const taxable = (c: { quantity: number; unitPrice: number; taxRate: number; taxInclusive: boolean }) => {
  const amt = c.quantity * c.unitPrice;
  return r2(c.taxInclusive ? amt / (1 + c.taxRate / 100) : amt);
};

interface ChargeRow {
  id: string;
  position: number;
  kind: 'one_time' | 'recurring' | 'hourly';
  product_id: string | null;
  name: string;
  description: string | null;
  hsn_sac: string | null;
  quantity: string;
  unit_price: string;
  tax_rate: string;
  tax_inclusive: boolean;
  frequency: keyof typeof MONTHS | null;
  start_date: Date | string | null;
  periods: number | null;
}
const d10 = (v: Date | string | null) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const dto = (r: ChargeRow) => ({
  id: r.id,
  kind: r.kind,
  productId: r.product_id,
  name: r.name,
  description: r.description,
  hsnSac: r.hsn_sac,
  quantity: Number(r.quantity),
  unitPrice: Number(r.unit_price),
  taxRate: Number(r.tax_rate),
  taxInclusive: r.tax_inclusive,
  frequency: r.frequency,
  startDate: d10(r.start_date),
  periods: r.periods,
});
type Charge = ReturnType<typeof dto>;

export async function dealCharges(ctx: RecordCtx, dealId: string) {
  const { row } = await loadRow(ctx, 'deal', dealId, 'read');
  const rows = await ctx.tx.query<ChargeRow>(`select * from deal_charges where tenant_id = $1 and deal_id = $2 order by position`, [ctx.tenantId, dealId]);
  const charges = rows.map(dto);
  const setup = row.billing_setup_at
    ? {
        at: row.billing_setup_at,
        projects: await ctx.tx.query(`select id, name, project_code from projects where tenant_id = $1 and deal_id = $2 and deleted_at is null`, [ctx.tenantId, dealId]),
        profiles: await ctx.tx.query(
          `select p.id, p.name, p.frequency, p.next_date, p.status, p.runs, p.auto_issue, p.template,
                  (select json_agg(json_build_object('from', c.effective_from, 'lines', c.lines, 'taxInclusive', c.tax_inclusive, 'note', c.note) order by c.effective_from) from recurring_price_changes c where c.tenant_id = p.tenant_id and c.profile_id = p.id) as changes
             from recurring_profiles p where p.tenant_id = $1 and p.deal_id = $2 order by p.created_at`,
          [ctx.tenantId, dealId],
        ),
      }
    : null;
  const invoices = await ctx.tx.query(
    `select id, invoice_number, name, invoice_date, status, grand_total::float8 as grand_total, balance_due::float8 as balance_due, recurring_profile_id from invoices
      where tenant_id = $1 and deal_id = $2 and deleted_at is null order by invoice_date nulls last, created_at`,
    [ctx.tenantId, dealId],
  );
  return { charges, currency: String(row.currency ?? 'INR'), totals: totalsOf(charges), setup, invoices, won: await isWon(ctx, row) };
}

function totalsOf(charges: Pick<Charge, 'kind' | 'quantity' | 'unitPrice' | 'taxRate' | 'taxInclusive' | 'frequency' | 'periods'>[]) {
  const oneTime = r2(charges.filter((c) => c.kind === 'one_time').reduce((a, c) => a + taxable(c), 0));
  const rec = charges.filter((c) => c.kind === 'recurring');
  const monthly = r2(rec.reduce((a, c) => a + taxable(c) / MONTHS[c.frequency ?? 'monthly'], 0));
  // the first year of recurring, or the whole term when it is shorter
  const firstYear = r2(rec.reduce((a, c) => a + taxable(c) * Math.min(c.periods ?? Infinity, 12 / MONTHS[c.frequency ?? 'monthly']), 0));
  // hourly work: rate × the hours estimated (billed later from approved time)
  const hours = charges.filter((c) => c.kind === 'hourly');
  const hourly = r2(hours.reduce((a, c) => a + taxable(c), 0));
  return { oneTime, hourly, hoursEstimated: r2(hours.reduce((a, c) => a + c.quantity, 0)), recurringMonthly: monthly, firstYearRecurring: firstYear, amount: r2(oneTime + hourly + firstYear) };
}

async function isWon(ctx: RecordCtx, row: Record<string, unknown>) {
  const st = await ctx.tx.one<{ category: string }>(`select category from pipeline_stages where tenant_id = $1 and id = $2`, [ctx.tenantId, row.stage_id]);
  return st?.category === 'won';
}

export async function saveDealCharges(ctx: RecordCtx, dealId: string, input: ChargeInput[], currency?: string | null): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'deal', dealId, 'update', true);
  if (currency && currency !== row.currency) {
    if (row.billing_setup_at) throw badRequest('Billing is set up: the currency can no longer change');
    await updateRecord(ctx, 'deal', dealId, { currency });
  }
  if (input.length > 100) throw badRequest('A deal can have at most 100 charges');
  for (const c of input) if (c.kind === 'recurring' && !c.frequency) throw badRequest(`Choose how often “${c.name}” is billed`);
  await ctx.tx.query(`delete from deal_charges where tenant_id = $1 and deal_id = $2`, [ctx.tenantId, dealId]);
  let pos = 1;
  for (const c of input)
    await ctx.tx.query(
      `insert into deal_charges (tenant_id, deal_id, position, kind, product_id, name, description, hsn_sac, quantity, unit_price, tax_rate, tax_inclusive, frequency, start_date, periods)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ctx.tenantId, dealId, pos++, c.kind, c.productId ?? null, c.name, c.description ?? null, c.hsnSac ?? null, c.quantity, c.unitPrice, c.taxRate, c.taxInclusive, c.kind === 'recurring' ? c.frequency : null, c.startDate ?? null, c.kind === 'recurring' ? (c.periods ?? null) : null],
    );
  const t = totalsOf(input.map((c) => ({ ...c, frequency: c.frequency ?? null, periods: c.periods ?? null })));
  await ctx.tx.query(`update deals set one_time_total = $3, recurring_monthly = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, dealId, input.length ? r2(t.oneTime + t.hourly) : null, input.length ? t.recurringMonthly : null]);
  if (!input.length) return [];
  // the deal amount follows its charges (one-time + the first year of recurring)
  const r = await updateRecord(ctx, 'deal', dealId, { amount: t.amount });
  return r.events;
}

const nextMonthStart = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return t.toISOString().slice(0, 10);
};

export const setupSchema = z.object({
  project: z.boolean().default(true),
  /** the invoice for one-time charges: a draft to check, or none */
  oneTimeInvoice: z.boolean().default(true),
  /** recurring invoices are issued (numbered, posted) when created; otherwise left as drafts */
  autoIssue: z.boolean().default(true),
  /** every recurring charge starts on this date unless the charge has its own */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

/** Turns a won deal's charges into its project, first invoice and recurring invoices. */
export async function setupDealBilling(ctx: RecordCtx, dealId: string, opts: z.infer<typeof setupSchema>) {
  const { row: deal } = await loadRow(ctx, 'deal', dealId, 'update', true);
  if (!(await isWon(ctx, deal))) throw badRequest('Mark the deal as won first');
  if (deal.billing_setup_at) throw conflict('Billing for this deal is already set up');
  if (!deal.account_id) throw badRequest('Choose the deal’s account (the customer) first');
  const charges = (await ctx.tx.query<ChargeRow>(`select * from deal_charges where tenant_id = $1 and deal_id = $2 order by position`, [ctx.tenantId, dealId])).map(dto);
  if (!charges.length) throw badRequest('Add the deal’s charges first');
  const apps = enabledApps(ctx.meta);
  if (!apps.has('billing')) throw badRequest('Switch on GST billing (Settings → Apps) to invoice from a deal');
  const events: RecordEvent[] = [];
  const out: { projectId: string | null; invoiceId: string | null; profileIds: string[] } = { projectId: null, invoiceId: null, profileIds: [] };
  const oneTime = charges.filter((c) => c.kind === 'one_time');
  const recurring = charges.filter((c) => c.kind === 'recurring');
  const hourly = charges.filter((c) => c.kind === 'hourly');
  const t = totalsOf(charges);
  const currency = String(deal.currency ?? 'INR');
  const base = { account_id: deal.account_id, contact_id: deal.contact_id ?? null, deal_id: dealId, currency };

  if (opts.project && apps.has('projects')) {
    const existing = await ctx.tx.one<{ id: string }>(`select id from projects where tenant_id = $1 and deal_id = $2 and deleted_at is null limit 1`, [ctx.tenantId, dealId]);
    if (existing) out.projectId = existing.id;
    else {
      const p = await createRecord(ctx, 'project', {
        name: String(deal.name),
        account_id: deal.account_id,
        deal_id: dealId,
        // hourly charges: billed from approved time at the deal's rate; otherwise a fixed price
        billing_method: hourly.length ? 'time_project_rate' : 'fixed_price',
        project_rate: hourly.length ? (hourly[0]!.taxInclusive ? r2(hourly[0]!.unitPrice / (1 + hourly[0]!.taxRate / 100)) : hourly[0]!.unitPrice) : null,
        ...(hourly.length ? { budget_type: 'hours', budget_hours: t.hoursEstimated } : {}),
        currency,
        fixed_fee: t.oneTime || null,
        start_date: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10),
        tax_rate: oneTime[0]?.taxRate ?? hourly[0]?.taxRate ?? recurring[0]?.taxRate ?? 18,
        hsn_sac: oneTime[0]?.hsnSac ?? hourly[0]?.hsnSac ?? recurring[0]?.hsnSac ?? null,
      });
      events.push(...p.events);
      out.projectId = String(p.record.id);
    }
  }

  const lineOf = (c: Charge, inclusive: boolean) => ({
    productId: c.productId,
    name: c.name,
    description: c.description,
    hsnSac: c.hsnSac,
    unit: null,
    quantity: c.quantity,
    // a charge priced the other way round is converted, so one invoice can carry both
    unitPrice: c.taxInclusive === inclusive ? c.unitPrice : inclusive ? r2(c.unitPrice * (1 + c.taxRate / 100)) : r2(c.unitPrice / (1 + c.taxRate / 100)),
    discountPct: 0,
    taxRate: c.taxRate,
  });

  if (opts.oneTimeInvoice && oneTime.length) {
    const inclusive = oneTime.every((c) => c.taxInclusive);
    const inv = await createRecord(ctx, 'invoice', { ...base, name: String(deal.name), subject: String(deal.name), tax_inclusive: inclusive });
    events.push(...inv.events);
    out.invoiceId = String(inv.record.id);
    if (out.projectId) await ctx.tx.query(`update invoices set project_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, out.invoiceId, out.projectId]);
    events.push(...(await saveInvoiceLines(ctx, out.invoiceId, oneTime.map((c) => lineOf(c, inclusive)))));
  }

  // one recurring invoice per schedule (how often, from when, for how long)
  const groups = new Map<string, Charge[]>();
  for (const c of recurring) {
    const start = c.startDate ?? opts.startDate ?? nextMonthStart();
    const key = `${c.frequency}|${start}|${c.periods ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...c, startDate: start }]);
  }
  for (const [, cs] of groups) {
    const first = cs[0]!;
    const inclusive = cs.every((c) => c.taxInclusive);
    const months = MONTHS[first.frequency ?? 'monthly'];
    const endDate = first.periods ? addMonths(first.startDate!, months * (first.periods - 1)) : null;
    const name = cs.length === 1 ? `${deal.name} — ${first.name}` : `${deal.name} — recurring charges`;
    const p = await saveRecurring(ctx, null, {
      name: name.slice(0, 150),
      kind: 'invoice',
      template: { values: { ...base, name: cs.length === 1 ? first.name : String(deal.name), subject: cs.length === 1 ? first.name : `${deal.name}: recurring charges`, tax_inclusive: inclusive }, lines: cs.map((c) => lineOf(c, inclusive)) },
      frequency: first.frequency ?? 'monthly',
      every: 1,
      startDate: first.startDate!,
      endDate,
      autoIssue: opts.autoIssue,
    });
    await ctx.tx.query(`update recurring_profiles set deal_id = $3, project_id = $4, account_id = $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, p!.id, dealId, out.projectId, deal.account_id]);
    out.profileIds.push(p!.id);
  }
  await ctx.tx.query(`update deals set billing_setup_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, dealId]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'deal',$3)`, [
    ctx.tenantId,
    `Billing set up: ${[out.projectId && 'project', out.invoiceId && 'invoice for the one-time charges', out.profileIds.length && `${out.profileIds.length} recurring invoice${out.profileIds.length > 1 ? 's' : ''}`].filter(Boolean).join(', ')}`,
    dealId,
  ]);
  return { ...out, events };
}
