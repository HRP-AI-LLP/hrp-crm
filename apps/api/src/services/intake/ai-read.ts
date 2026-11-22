/**
 * The second pair of eyes on a mailed bill or receipt: when the rule-based reading leaves the
 * supplier, number, amounts or lines empty (layouts it has not seen, like GitHub's or AWS's
 * receipts), the workspace's AI model reads the same text and fills only what is missing.
 * It runs once per file (outside the database transaction), and nothing it says overrides a value
 * the rules did read.
 */
import { z } from 'zod';
import { jsonSafe } from '../../lib/json-safe';
import { type AiCtx, guardedChat } from '../ai/features';
import { AiUnavailableError, extractJson } from '../ai/router';

const num = z.union([z.number(), z.string()]).nullish().transform((v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
});
const aiSchema = z.object({
  supplier: z.string().nullish(),
  supplierCountry: z.string().nullish(),
  supplierTaxId: z.string().nullish(),
  invoiceNumber: z.string().nullish(),
  date: z.string().nullish(),
  currency: z.string().nullish(),
  lines: z.array(z.object({ description: z.string().nullish(), hsnSac: z.string().nullish(), qty: num, unitPrice: num, amount: num, taxPct: num })).nullish(),
  subtotal: num,
  tax: num,
  total: num,
  paid: z.boolean().nullish(),
  paidOn: z.string().nullish(),
  amountPaid: num,
});
export type AiBillRead = z.infer<typeof aiSchema>;

const PROMPT = `You read the text of a bill, invoice or payment receipt that a supplier sent to the company named below, and return JSON only:
{"supplier": the seller's name (never the company below, never "Account billed …"), "supplierCountry", "supplierTaxId" (GSTIN / VAT / EIN if printed),
"invoiceNumber" (invoice, receipt or transaction number), "date" (YYYY-MM-DD), "currency" (ISO code, e.g. USD, INR),
"lines": [{"description", "hsnSac", "qty", "unitPrice", "amount", "taxPct"}], "subtotal", "tax", "total",
"paid" (true when it says paid / charged to a card), "paidOn" (YYYY-MM-DD), "amountPaid"}
Numbers without currency symbols. null for anything not printed. Never invent values.`;

const isoDate = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);

export async function aiReadBill(ai: AiCtx, text: string, ownNames: string[], hint: { from?: string | null; subject?: string | null }) {
  const res = await guardedChat(ai, {
    task: 'document',
    containsPii: true,
    json: true,
    maxTokens: 2000,
    temperature: 0,
    timeoutMs: 60_000,
    messages: [
      { role: 'system', content: `${PROMPT}\nThe company (the buyer): ${ownNames.join(' / ') || 'unknown'}.` },
      { role: 'user', content: `Mail from: ${hint.from ?? ''}\nSubject: ${hint.subject ?? ''}\n<document>\n${text.slice(0, 24000)}\n</document>` },
    ],
  });
  const p = aiSchema.safeParse(extractJson(res.text));
  return p.success ? p.data : null;
}

/** Fills the gaps of one stored reading with what the AI read; returns the reading. */
export function mergeAiRead(read: Record<string, any>, a: AiBillRead, ownNames: string[]) {
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const own = ownNames.map(squash).filter((o) => o.length >= 3);
  const d = (read.data ??= {}) as Record<string, any>;
  const rc = read.receipt as Record<string, any> | null;
  const supplier = a.supplier?.trim() && !own.some((o) => squash(a.supplier!).includes(o)) ? a.supplier.trim().slice(0, 200) : null;
  const currency = a.currency && /^[A-Z]{3}$/i.test(a.currency.trim()) ? a.currency.trim().toUpperCase() : null;
  const lines = (a.lines ?? [])
    .filter((l) => l.description?.trim() && (l.amount != null || l.unitPrice != null))
    .slice(0, 100)
    .map((l) => {
      const qty = l.qty && l.qty > 0 ? l.qty : 1;
      const amount = l.amount ?? (l.unitPrice ?? 0) * qty;
      return { description: l.description!.trim().slice(0, 200), hsn: l.hsnSac?.replace(/\D/g, '') || null, qty, rate: l.unitPrice ?? amount / qty, amount, taxRate: l.taxPct ?? 0 };
    });
  d.number ??= a.invoiceNumber?.trim().slice(0, 60) || null;
  d.date ??= isoDate(a.date);
  if (!d.lines?.length && lines.length) d.lines = lines;
  if (d.total == null && a.total != null) d.total = a.total;
  if (d.taxable == null && a.subtotal != null) d.taxable = a.subtotal;
  if (rc) {
    rc.supplier ??= {};
    if (supplier && !rc.supplier.name) rc.supplier.name = supplier;
    rc.supplier.country ??= a.supplierCountry ?? null;
    rc.supplier.taxId ??= a.supplierTaxId ?? null;
    rc.number ??= d.number;
    rc.date ??= d.date;
    if (currency && (!rc.currency || (rc.currency === 'INR' && currency !== 'INR' && rc.total == null))) rc.currency = currency;
    rc.supplier.foreign = rc.currency !== 'INR' || (!!rc.supplier.country && !/india/i.test(rc.supplier.country));
    rc.total ??= a.total;
    rc.subtotal ??= a.subtotal;
    rc.tax ??= a.tax;
    if (rc.currency !== 'INR') {
      d.currency = rc.currency;
      if (!Number(d.igst) && a.tax) d.igst = a.tax;
    }
    if (a.paid) {
      rc.paid = true;
      rc.paidOn ??= isoDate(a.paidOn);
      rc.amountPaid ??= a.amountPaid ?? a.total;
    }
    if ((!rc.lines || !rc.lines.length) && lines.length) rc.lines = lines.map((l) => ({ description: l.description, period: null, qty: l.qty, unitPrice: l.rate, taxPct: l.taxRate, amount: l.amount, hsn: l.hsn }));
  }
  if (supplier) read.party = { ...(read.party ?? {}), name: read.party?.name && !own.some((o) => squash(read.party.name).includes(o)) ? read.party.name : supplier };
  const got = [d.number, d.date, rc?.supplier?.name ?? read.party?.name, d.lines?.length, d.total ?? d.taxable].filter(Boolean).length;
  read.confidence = Math.max(read.confidence ?? 0, got / 5);
  read.ai = { at: new Date().toISOString() };
  return read;
}

/** A reading worth a second look: something the approval form needs is missing. */
export function weakRead(read: Record<string, any> | undefined) {
  if (!read || read.scanned || read.ai || read.whose === 'ours' || !read.text) return false;
  const d = read.data ?? {};
  const rc = read.receipt ?? {};
  return !(d.number || rc.number) || !d.lines?.length || (d.total ?? rc.total ?? d.taxable) == null || !rc.supplier?.name;
}

/**
 * For each weak reading on a mail: ask the AI (outside any transaction), then store the merge.
 * Quietly does nothing when no AI model is set up.
 */
export async function aiFillMail(ai: AiCtx, id: string) {
  const it = await ai.db.tx({ tenantId: ai.tenantId, readOnly: true }, (tx) =>
    tx.one<{ data: Record<string, any>; from_name: string | null; from_address: string | null; subject: string; n: string | null; l: string | null }>(
      `select i.data, i.from_name, i.from_address, i.subject, t.name as n, t.settings -> 'company' ->> 'legalName' as l from intake_items i join tenants t on t.id = i.tenant_id where i.tenant_id = $1 and i.id = $2`,
      [ai.tenantId, id],
    ),
  );
  if (!it) return;
  const names = [it.n, it.l].filter((x): x is string => !!x);
  for (const [fileId, read] of Object.entries((it.data.reads ?? {}) as Record<string, Record<string, any>>).slice(0, 4)) {
    if (!weakRead(read)) continue;
    let a: AiBillRead | null;
    try {
      a = await aiReadBill(ai, String(read.text), names, { from: it.from_name ? `${it.from_name} <${it.from_address}>` : it.from_address, subject: it.subject });
    } catch (e) {
      if (e instanceof AiUnavailableError) return; // no model: try again once one is set up
      a = null;
    }
    await ai.db.tx({ tenantId: ai.tenantId }, async (tx) => {
      const cur = await tx.one<{ data: Record<string, any> }>(`select data from intake_items where tenant_id = $1 and id = $2 for update`, [ai.tenantId, id]);
      const r = cur?.data.reads?.[fileId];
      if (!cur || !r || r.ai) return;
      const merged = a ? mergeAiRead(r, a, names) : { ...r, ai: { at: new Date().toISOString(), failed: true } };
      await tx.query(`update intake_items set data = $3 where tenant_id = $1 and id = $2`, [ai.tenantId, id, jsonSafe({ ...cur.data, reads: { ...cur.data.reads, [fileId]: merged } })]);
    });
  }
}
