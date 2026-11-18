/**
 * A mailed bill, invoice or receipt, checked and approved: every PDF on the mail is read on the server
 * (invoice and receipt together), and on approval the bill is made and posted in its own currency at
 * the day's rate (import of services under reverse charge when the supplier is abroad), the payment is
 * recorded through the card or bank that paid (found by its last four digits), and the files go with
 * the bill. The books, GST (RCM in GSTR-3B, ITC), the supplier's ledger, the project and the card's
 * reconciliation all follow from the posted bill and payment.
 */
import { jsonSafe } from '../../lib/json-safe';
import { z } from 'zod';
import type { Env } from '../../env';
import { badRequest, notFound } from '../../lib/errors';
import { fxRate, rateForDoc } from '../../lib/fx';
import { pdfLines } from '../../lib/pdf-lines';
import { cardByLast4 } from '../books/banking';
import { approveMany, createBatch, stageFile } from '../books/doc-import';
import { assertBooksAdmin } from '../books/ledger';
import { postBill, recordVendorPayment, saveBillLines } from '../books/bills';
import { saveFile } from '../files';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';
import { assertIntake, READ_VERSION, readAttachment } from './intake';
import type { ReceiptRead } from './receipt';

type Read = {
  whose?: 'ours' | 'theirs' | null;
  data: Record<string, any> | null;
  confidence?: number;
  receipt?: ReceiptRead | null;
  party?: { gstin: string | null; name: string | null };
  ours?: boolean;
  scanned?: boolean;
};
type Item = {
  data: Record<string, any>;
  attachments: { fileId: string; name: string; contentType: string }[];
  from_name: string | null;
  from_address: string | null;
  subject: string;
  status: string;
  link_object: string | null;
  link_id: string | null;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function loadItem(ctx: RecordCtx, id: string, lock = false) {
  const it = await ctx.tx.one<Item>(
    `select data, attachments, from_name, from_address, subject, status, link_object, link_id from intake_items where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [ctx.tenantId, id],
  );
  if (!it) throw notFound('Mail not found');
  return it;
}

/** Reads every PDF on the mail that has not been read yet (on the server). */
export async function readAll(ctx: RecordCtx, env: Env, id: string) {
  assertIntake(ctx);
  const it = await loadItem(ctx, id);
  if (!env.FILES) return;
  for (const a of it.attachments) {
    // read again when it was read before the receipt reading existed
    const prev = it.data.reads?.[a.fileId];
    if (a.contentType !== 'application/pdf' || prev?.v === READ_VERSION) continue;
    const f = await ctx.tx.one<{ storage_key: string }>(`select storage_key from files where tenant_id = $1 and id = $2`, [ctx.tenantId, a.fileId]);
    const obj = f && (await env.FILES.get(f.storage_key));
    if (!obj) continue;
    const pages = (await pdfLines(new Uint8Array(await obj.arrayBuffer()))) ?? [];
    await readAttachment(ctx, id, a.fileId, pages);
  }
}

/** What the mail says, put together from all its files, with the choices to approve it. */
export async function proposal(ctx: RecordCtx, env: Env, id: string, f: typeof fetch = fetch) {
  assertIntake(ctx);
  await readAll(ctx, env, id);
  const it = await loadItem(ctx, id);
  const reads = Object.entries((it.data.reads ?? {}) as Record<string, Read>).filter(([, r]) => r.data || r.receipt);
  // our own invoice to a customer (e.g. sent from Zoho): imported as a sales invoice, not a bill
  if (reads.some(([, r]) => r.whose === 'ours') && !reads.some(([, r]) => r.whose === 'theirs')) return ourInvoice(ctx, env, id, it);
  const nameOf = (fid: string) => it.attachments.find((a) => a.fileId === fid)?.name ?? '';
  // the invoice: a file not named a receipt, with the most read off it; the receipt: one that says paid
  const score = ([fid, r]: [string, Read]) => (/receipt/i.test(nameOf(fid)) ? -5 : 0) + (r.data?.lines?.length ? 3 : 0) + (r.data?.number ? 2 : 0) + (r.confidence ?? 0);
  const inv = [...reads].sort((a, b) => score(b) - score(a))[0];
  const paidRead = reads.map(([, r]) => r.receipt).find((x) => x?.paid && (x.amountPaid != null || x.card));
  const rc = inv?.[1].receipt ?? null;
  const d = inv?.[1].data ?? {};
  const currency = reads.map(([, r]) => r.receipt?.currency).find((c) => c && c !== 'INR') ?? (d.currency as string | undefined) ?? 'INR';
  const foreign = reads.some(([, r]) => r.receipt?.supplier.foreign);
  const supplierName = rc?.supplier.name ?? reads.map(([, r]) => r.receipt?.supplier.name).find(Boolean) ?? inv?.[1].party?.name ?? it.from_name ?? null;
  const gstin = foreign ? null : (inv?.[1].party?.gstin ?? null);
  const taxId = reads.map(([, r]) => r.receipt?.supplier.taxId).find(Boolean) ?? null;
  const number = rc?.number ?? (d.number as string | undefined) ?? paidRead?.number ?? null;
  const date = rc?.date ?? (d.date as string | undefined) ?? paidRead?.paidOn ?? null;
  const hsn = reads.map(([, r]) => r.receipt?.hsnSac).find(Boolean) ?? null;
  const tax = foreign ? (rc?.tax ?? 0) : Number(d.cgst ?? 0) + Number(d.sgst ?? 0) + Number(d.igst ?? 0);
  const taxable = foreign ? (rc?.subtotal ?? d.taxable ?? null) : (d.taxable ?? null);
  // a foreign supplier charging no GST: import of services, GST paid by us under reverse charge
  const reverseCharge = (foreign && !tax) || (!foreign && d.reverseCharge === true);
  const rateGuess = (t: number | null) => (t ? [0, 5, 12, 18, 28, 40].reduce((best, r) => (Math.abs((t * r) / 100 - tax) < Math.abs((t * best) / 100 - tax) ? r : best), 18) : 18);
  const lineRate = reverseCharge ? 18 : rateGuess(taxable);
  const lines =
    Array.isArray(d.lines) && d.lines.length
      ? (d.lines as any[]).slice(0, 300).map((l) => ({
          description: String(l.description ?? 'Item').slice(0, 200),
          hsnSac: l.hsn ?? hsn ?? null,
          quantity: Number(l.qty) || 1,
          unitPrice: Number(l.qty ? l.rate : l.amount) || 0,
          taxRate: reverseCharge ? 18 : (l.taxRate ?? lineRate),
        }))
      : taxable != null
        ? [{ description: `As per invoice ${number ?? ''}`.trim(), hsnSac: hsn, quantity: 1, unitPrice: Number(taxable), taxRate: lineRate }]
        : [];
  const paid = paidRead ?? (rc?.paid ? rc : null);
  const card = paid?.card ?? reads.map(([, r]) => r.receipt?.card).find(Boolean) ?? null;
  const through = await cardByLast4(ctx, card?.last4);
  const rate = currency === 'INR' ? { rate: 1, date: date ?? '' } : date ? await rateForDoc(ctx.tx, ctx.tenantId, currency, date, f) : await fxRate(currency, null, f);
  // the vendor already on file: by GSTIN, else by name
  let vendor: { id: string; name: string } | null = null;
  if (gstin) vendor = await ctx.tx.one(`select id, name from vendors where tenant_id = $1 and upper(gstin) = $2 and deleted_at is null`, [ctx.tenantId, gstin]);
  if (!vendor && supplierName) vendor = await ctx.tx.one(`select id, name from vendors where tenant_id = $1 and lower(name) = lower($2) and deleted_at is null`, [ctx.tenantId, supplierName]);
  // the expense account: as this supplier's last bills, else from the SAC / HSN and the words on it
  const suggestion = await suggestAccount(ctx, vendor?.id ?? null, hsn ?? lines.find((l) => l.hsnSac)?.hsnSac ?? null, [supplierName, ...lines.map((l) => l.description)].filter(Boolean).join(' '));
  const accounts = await ctx.tx.query(
    `select id, code, name, type, subtype from gl_accounts where tenant_id = $1 and is_active and (type = 'expense' or subtype in ('bank','cash','credit_card','fixed_asset')) order by type, code nulls last, name`,
    [ctx.tenantId],
  );
  const payFrom = await ctx.tx.query(
    `select b.id, b.gl_account_id, a.name, b.kind, b.account_last4, b.holder, (select p.name from acct_persons p where p.tenant_id = b.tenant_id and p.id = b.person_id) as person_name
       from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where b.tenant_id = $1 and b.is_active order by (b.kind = 'credit_card') desc, a.name`,
    [ctx.tenantId],
  );
  const projects = await ctx.tx.query(`select id, name from projects where tenant_id = $1 and deleted_at is null and status not in ('completed','cancelled') order by name limit 300`, [ctx.tenantId]);
  const total = r2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
  return {
    status: it.status,
    link: it.link_id ? { object: it.link_object, id: it.link_id } : null,
    files: it.attachments.map((a) => ({ fileId: a.fileId, name: a.name, read: !!it.data.reads?.[a.fileId], role: a.fileId === inv?.[0] ? 'invoice' : paidRead && it.data.reads?.[a.fileId]?.receipt === paidRead ? 'receipt' : null })),
    supplier: { name: vendor?.name ?? supplierName, vendorId: vendor?.id ?? null, gstin, taxId, foreign, country: reads.map(([, r]) => r.receipt?.supplier.country).find(Boolean) ?? null },
    number,
    receiptNumber: paid?.receiptNumber ?? null,
    date,
    currency,
    exchangeRate: rate?.rate ?? null,
    rateDate: rate?.date ?? null,
    reverseCharge,
    supplyType: foreign ? 'import' : null,
    lines,
    subtotal: taxable ?? total,
    tax,
    total: rc?.total ?? (d.total as number | undefined) ?? total,
    paid: paid
      ? {
          on: paid.paidOn ?? date,
          amount: paid.amountPaid ?? rc?.total ?? total,
          appliedBalance: paid.appliedBalance ?? null,
          card,
          through: through ? { glId: through.gl_account_id, name: through.name, holder: through.holder, person: through.person_name } : null,
          reference: paid.receiptNumber ?? number,
        }
      : null,
    confidence: inv?.[1].confidence ?? 0,
    suggest: suggestion,
    choices: { accounts, payFrom, projects },
  };
}

/**
 * Our own invoice that came by mail (sent from Zoho while moving over, say): read by the invoice
 * importer (customer, contact, deal, recurring invoice, project, how it was paid) and kept as an import
 * to check and approve; approving creates the invoice under its original number, in the books.
 */
async function ourInvoice(ctx: RecordCtx, env: Env, id: string, it: Item) {
  await assertBooksAdmin(ctx);
  let ids = (it.data.importItemIds as string[] | undefined) ?? [];
  if (!ids.length || !(await ctx.tx.one(`select 1 from doc_import_items where tenant_id = $1 and id = $2`, [ctx.tenantId, ids[0]]))) {
    const batch = await createBatch(ctx, `Mail: ${it.subject}`.slice(0, 200));
    ids = [];
    for (const a of it.attachments) {
      if (a.contentType !== 'application/pdf' || !env.FILES) continue;
      const f = await ctx.tx.one<{ storage_key: string }>(`select storage_key from files where tenant_id = $1 and id = $2`, [ctx.tenantId, a.fileId]);
      const obj = f && (await env.FILES.get(f.storage_key));
      if (!obj) continue;
      const pages = (await pdfLines(new Uint8Array(await obj.arrayBuffer()))) ?? [];
      const r = await stageFile({ run: (fn) => fn(ctx), ai: null }, batch.id, { fileName: a.name, pages });
      ids.push(...r.ids);
    }
    await ctx.tx.query(`update intake_items set kind = 'invoice', data = data || $3::jsonb where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe({ importId: batch.id, importItemIds: ids })]);
  }
  const items = await ctx.tx.query(
    `select id, status, confidence::float8 as confidence, data, plan, warnings, error, result from doc_import_items where tenant_id = $1 and id = any($2::uuid[]) order by created_at`,
    [ctx.tenantId, ids],
  );
  const choices = {
    accounts: await ctx.tx.query(`select id, name from accounts where tenant_id = $1 and deleted_at is null order by name limit 500`, [ctx.tenantId]),
    deals: await ctx.tx.query(`select id, name, account_id from deals where tenant_id = $1 and deleted_at is null order by updated_at desc limit 300`, [ctx.tenantId]),
    projects: await ctx.tx.query(`select id, name, account_id from projects where tenant_id = $1 and deleted_at is null order by name limit 300`, [ctx.tenantId]),
  };
  return { ours: true as const, status: it.status, link: it.link_id ? { object: it.link_object, id: it.link_id } : null, items, choices };
}

/** Approves the mail's own invoices (all, or the ones given) and links the mail to the first invoice. */
export async function importOurInvoices(ctx: RecordCtx, id: string, env?: Env) {
  await assertBooksAdmin(ctx);
  const it = await loadItem(ctx, id, true);
  const ids = (it.data.importItemIds as string[] | undefined) ?? [];
  if (!ids.length) throw badRequest('Open the mail first so its invoice is read');
  const r = await approveMany(ctx, ids);
  // the mail's PDFs go with the invoices made from them
  if (env?.FILES)
    for (const x of r.results) {
      const inv = (x.created?.invoice as { id?: string } | undefined)?.id;
      if (!x.ok || !inv) continue;
      for (const a of it.attachments.filter((a) => a.contentType === 'application/pdf')) {
        const obj = await ctx.tx.one<{ storage_key: string; name: string }>(`select storage_key, name from files where tenant_id = $1 and id = $2`, [ctx.tenantId, a.fileId]);
        const body = obj && (await env.FILES.get(obj.storage_key));
        if (body) await saveFile(ctx, env, { objectKey: 'invoice', recordId: inv, name: obj!.name, bytes: new Uint8Array(await body.arrayBuffer()), kind: 'document' }, { system: true }).catch(() => null);
      }
    }
  const firstInvoice = r.results.map((x) => (x.created?.invoice as { id?: string } | undefined)?.id).find(Boolean) ?? null;
  if (r.results.every((x) => x.ok) && firstInvoice)
    await ctx.tx.query(`update intake_items set status = 'done', link_object = 'invoice', link_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, firstInvoice]);
  return { ...r, invoiceId: firstInvoice };
}

/** SAC (services) and HSN chapters → the expense account they usually belong to. */
const SAC_KEYS: [RegExp, string][] = [
  [/^99831[12]/, 'professional_fees'], // management and business consulting
  [/^99831[3-9]|^99843[1-4]|^99841/, 'software'], // IT consulting, design, hosting, infrastructure; online content and software
  [/^9983[6]/, 'marketing'], // advertising
  [/^998[23]|^9985[0-49]/, 'professional_fees'], // legal, accounting, architecture, other professional and support services
  [/^9984[1-2]/, 'telephone'],
  [/^99713/, 'insurance'],
  [/^9971/, 'bank_charges'],
  [/^997[23]/, 'rent'],
  [/^996[4-6]|^99855/, 'travel'],
  [/^9963/, 'meals'],
  [/^9987/, 'repairs'],
  [/^4802|^4817|^4820|^9608/, 'stationery'],
  [/^8471|^8473|^8517|^8528/, 'office'],
];
const WORDS: [RegExp, string][] = [
  [/\b(software|subscription|saas|cloud|hosting|domain|api|credits?|licen[cs]e|server|gstin\s+lookup|plan)\b/i, 'software'],
  [/\b(consult\w*|professional|legal|audit|accounting|ca\s+fees?)\b/i, 'professional_fees'],
  [/\b(internet|broadband|mobile|telephone|recharge|airtel|jio)\b/i, 'telephone'],
  [/\b(advertis\w*|marketing|ads|promotion|campaign)\b/i, 'marketing'],
  [/\b(travel|flight|train|cab|taxi|hotel|stay)\b/i, 'travel'],
  [/\b(food|meal|restaurant|catering)\b/i, 'meals'],
  [/\b(rent|lease)\b/i, 'rent'],
  [/\b(repair|maintenance|amc)\b/i, 'repairs'],
  [/\b(insurance|premium)\b/i, 'insurance'],
];

async function suggestAccount(ctx: RecordCtx, vendorId: string | null, sac: string | null, words: string) {
  if (vendorId) {
    const last = await ctx.tx.one<{ id: string; name: string }>(
      `select a.id, a.name from bill_lines l join bills b on b.tenant_id = l.tenant_id and b.id = l.order_id join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
        where l.tenant_id = $1 and b.vendor_id = $2 and b.status not in ('draft','void') and b.deleted_at is null order by b.bill_date desc limit 1`,
      [ctx.tenantId, vendorId],
    );
    if (last) return { accountId: last.id, name: last.name, why: 'as this supplier’s last bill' };
  }
  const key = (sac && SAC_KEYS.find(([re]) => re.test(sac))?.[1]) ?? WORDS.find(([re]) => re.test(words))?.[1] ?? null;
  if (!key) return null;
  const a = await ctx.tx.one<{ id: string; name: string }>(`select id, name from gl_accounts where tenant_id = $1 and system_key = $2 and is_active`, [ctx.tenantId, key]);
  return a ? { accountId: a.id, name: a.name, why: sac && SAC_KEYS.some(([re]) => re.test(sac)) ? `from SAC/HSN ${sac}` : 'from what was bought' } : null;
}

export const approveSchema = z.object({
  vendorId: z.string().uuid().nullish(),
  vendorName: z.string().trim().min(2).max(200),
  gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/).nullish(),
  number: z.string().trim().max(60).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  exchangeRate: z.number().positive().max(100000).default(1),
  reverseCharge: z.boolean().default(false),
  importOfServices: z.boolean().default(false),
  itcEligible: z.boolean().default(true),
  accountId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  lines: z
    .array(z.object({ description: z.string().trim().min(1).max(200), hsnSac: z.string().max(20).nullish(), quantity: z.number().positive().max(1e9), unitPrice: z.number().min(0).max(1e12), taxRate: z.number().min(0).max(40) }))
    .min(1)
    .max(300),
  post: z.boolean().default(true),
  payment: z
    .object({
      paidThroughId: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amount: z.number().positive().max(1e12),
      /** rupees actually charged (from the card or bank statement): sets the payment's rate exactly */
      inrAmount: z.number().positive().max(1e12).nullish(),
      exchangeRate: z.number().positive().max(100000).nullish(),
      reference: z.string().trim().max(120).nullish(),
    })
    .nullish(),
  note: z.string().max(1000).nullish(),
});

/** Makes (and posts) the bill, records the payment, keeps the files, closes the mail. */
export async function approveMail(ctx: RecordCtx, env: Env, id: string, input: z.infer<typeof approveSchema>) {
  assertIntake(ctx);
  const it = await loadItem(ctx, id, true);
  if (it.link_id) throw badRequest('This mail was already approved');
  if (input.payment && !input.post) throw badRequest('Post the bill to record its payment');
  const events: RecordEvent[] = [];
  // the vendor: chosen, by GSTIN, by name, or added
  let vendorId = input.vendorId ?? null;
  if (!vendorId && input.gstin) vendorId = (await ctx.tx.one<{ id: string }>(`select id from vendors where tenant_id = $1 and upper(gstin) = $2 and deleted_at is null`, [ctx.tenantId, input.gstin]))?.id ?? null;
  if (!vendorId) vendorId = (await ctx.tx.one<{ id: string }>(`select id from vendors where tenant_id = $1 and lower(name) = lower($2) and deleted_at is null`, [ctx.tenantId, input.vendorName]))?.id ?? null;
  if (!vendorId) {
    const v = await createRecord(ctx, 'vendor', { name: input.vendorName, gstin: input.gstin ?? null, email: it.from_address, notes: input.importOfServices ? 'Supplier abroad (import of services) — added from a mailed invoice' : 'Added from a mailed invoice' });
    vendorId = String(v.record.id);
    events.push(...v.events);
  }
  if (input.number && (await ctx.tx.one(`select 1 from bills where tenant_id = $1 and vendor_id = $2 and vendor_ref = $3 and deleted_at is null and status <> 'void'`, [ctx.tenantId, vendorId, input.number])))
    throw badRequest(`Bill ${input.number} of this supplier is already in the books`);
  const foreignCur = input.currency !== 'INR';
  const b = await createRecord(ctx, 'bill', {
    name: `${input.vendorName}${input.number ? ` — ${input.number}` : ''}`.slice(0, 200),
    vendor_id: vendorId,
    vendor_ref: input.number ?? null,
    bill_date: input.date,
    currency: input.currency,
    exchange_rate: foreignCur ? input.exchangeRate : 1,
    reverse_charge: input.reverseCharge,
    itc_eligible: input.itcEligible,
  });
  const billId = String(b.record.id);
  events.push(...b.events);
  await ctx.tx.query(`update bills set supply_type = $3, project_id = coalesce($4, project_id), notes = coalesce($5, notes) where tenant_id = $1 and id = $2`, [
    ctx.tenantId, billId, input.importOfServices ? 'import' : null, input.projectId ?? null, input.note ?? null,
  ]);
  events.push(
    ...(await saveBillLines(
      ctx,
      billId,
      input.lines.map((l) => ({ name: l.description, hsnSac: l.hsnSac ?? null, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, discountPct: 0, accountId: input.accountId ?? null, projectId: input.projectId ?? null })) as never,
    )),
  );
  // the mail's files go with the bill
  if (env.FILES)
    for (const a of it.attachments) {
      const obj = await ctx.tx.one<{ storage_key: string; name: string }>(`select storage_key, name from files where tenant_id = $1 and id = $2`, [ctx.tenantId, a.fileId]);
      const body = obj && (await env.FILES.get(obj.storage_key));
      if (body) await saveFile(ctx, env, { objectKey: 'bill', recordId: billId, name: obj!.name, bytes: new Uint8Array(await body.arrayBuffer()), kind: 'document' }, { system: true });
    }
  let paymentId: string | null = null;
  let left: number | null = null;
  if (input.post) {
    events.push(...(await postBill(ctx, billId)));
    if (input.payment) {
      const bill = await ctx.tx.one<{ balance_due: string; exchange_rate: string }>(`select balance_due, exchange_rate from bills where tenant_id = $1 and id = $2`, [ctx.tenantId, billId]);
      const amount = r2(Math.min(input.payment.amount, Number(bill!.balance_due)));
      const rate = input.payment.inrAmount ? input.payment.inrAmount / input.payment.amount : (input.payment.exchangeRate ?? Number(bill!.exchange_rate));
      const card = await ctx.tx.one<{ subtype: string }>(`select subtype from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.payment.paidThroughId]);
      const p = await recordVendorPayment(ctx, {
        vendorId,
        amount,
        date: input.payment.date,
        mode: card?.subtype === 'credit_card' ? 'card' : card?.subtype === 'cash' ? 'cash' : 'bank_transfer',
        paidThroughId: input.payment.paidThroughId,
        reference: input.payment.reference ?? input.number ?? null,
        currency: input.currency,
        exchangeRate: foreignCur ? Math.round(rate * 1e6) / 1e6 : 1,
        allocations: [{ billId, amount }],
      });
      paymentId = p.id;
      events.push(...p.events);
      left = r2(Number(bill!.balance_due) - amount);
    }
  }
  await ctx.tx.query(`update intake_items set status = 'done', link_object = 'bill', link_id = $3, data = data || $4::jsonb where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, billId, jsonSafe({ approved: { billId, paymentId, at: new Date().toISOString() } }),
  ]);
  return { billId, vendorId, paymentId, balanceLeft: left, events };
}
