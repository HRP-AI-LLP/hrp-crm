// GSTR-2B lines that are not in the books: match them again, link them to a bill by hand, or enter
// them as bills (creating the supplier when it is new). Everything here reads and writes our own
// database only; nothing calls the GST provider.

import { validGstin } from '@synapse/shared';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';
import { postBill, saveBillLines } from './bills';
import { assertBooksAdmin, r2 } from './ledger';
import { matchGstr2b, normDoc } from './setup';

type Line = {
  id: string;
  import_id: string;
  period: string;
  supplier_gstin: string;
  supplier_name: string | null;
  doc_number: string;
  doc_date: string | null;
  doc_type: string | null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  itc_available: boolean;
  bill_id: string | null;
  match_status: string;
};

async function loadLine(ctx: RecordCtx, id: string): Promise<Line> {
  const l = await ctx.tx.one<Line>(
    `select l.id, l.import_id, i.period, l.supplier_gstin, l.supplier_name, l.doc_number, to_char(l.doc_date, 'YYYY-MM-DD') as doc_date, l.doc_type,
            l.taxable::float8 as taxable, l.igst::float8 as igst, l.cgst::float8 as cgst, l.sgst::float8 as sgst, l.itc_available, l.bill_id, l.match_status
       from gstr2b_lines l join gstr2b_imports i on i.tenant_id = l.tenant_id and i.id = l.import_id where l.tenant_id = $1 and l.id = $2`,
    [ctx.tenantId, id],
  );
  if (!l) throw notFound('That GSTR-2B line no longer exists (the month may have been fetched again)');
  return l;
}

/** Matches a month's GSTR-2B against the bills again (picks up bills entered or corrected since). */
export async function rematchGstr2b(ctx: RecordCtx, period: string) {
  await assertBooksAdmin(ctx);
  const imp = await ctx.tx.one<{ id: string }>(`select id from gstr2b_imports where tenant_id = $1 and period = $2`, [ctx.tenantId, period]);
  if (!imp) throw notFound('No GSTR-2B kept for that month yet');
  return { period, ...(await matchGstr2b(ctx, imp.id)) };
}

/** Bills that could be this GSTR-2B document: same supplier GSTIN, posted, not already matched to another line, near the date. */
export async function gstr2bCandidates(ctx: RecordCtx, lineId: string) {
  await assertBooksAdmin(ctx);
  const l = await loadLine(ctx, lineId);
  const tax = r2(l.igst + l.cgst + l.sgst);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select b.id, b.bill_number, b.vendor_ref, to_char(b.bill_date, 'YYYY-MM-DD') as bill_date, v.name as vendor, b.status,
            b.taxable_total::float8 as taxable, (b.igst_total + b.cgst_total + b.sgst_total)::float8 as tax
       from bills b left join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.doc_type = 'bill' and b.status not in ('draft','void') and b.deleted_at is null and b.vendor_gstin = $2
        and b.bill_date between coalesce($3::date, current_date) - interval '6 months' and coalesce($3::date, current_date) + interval '6 months'
        and not exists (select 1 from gstr2b_lines x where x.tenant_id = b.tenant_id and x.import_id = $4 and x.bill_id = b.id and x.id <> $5)
      order by abs(b.taxable_total - $6), abs(b.bill_date - coalesce($3::date, current_date)) limit 25`,
    [ctx.tenantId, l.supplier_gstin, l.doc_date, l.import_id, l.id, l.taxable],
  );
  return {
    line: { ...l, tax },
    bills: rows.map((b) => ({ ...b, sameAmount: Math.abs(b.taxable - l.taxable) <= 1 && Math.abs(b.tax - tax) <= 1 })),
  };
}

/** Links a GSTR-2B document to a bill by hand; the link is kept for later fetches of the month. */
export async function linkGstr2b(ctx: RecordCtx, lineId: string, billId: string) {
  await assertBooksAdmin(ctx);
  const l = await loadLine(ctx, lineId);
  const b = await ctx.tx.one<{ id: string; vendor_gstin: string | null; status: string; doc_type: string }>(
    `select id, vendor_gstin, status, doc_type from bills where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, billId],
  );
  if (!b || b.doc_type !== 'bill') throw notFound('Bill not found');
  if (['draft', 'void'].includes(b.status)) throw badRequest('Post the bill first; drafts and void bills are not matched');
  if (b.vendor_gstin !== l.supplier_gstin) throw badRequest(`That bill is from ${b.vendor_gstin ?? 'a supplier without a GSTIN'}, not ${l.supplier_gstin}`);
  await ctx.tx.query(`delete from gstr2b_links where tenant_id = $1 and (bill_id = $2 or (supplier_gstin = $3 and doc_key = $4))`, [ctx.tenantId, billId, l.supplier_gstin, normDoc(l.doc_number)]);
  await ctx.tx.query(`insert into gstr2b_links (tenant_id, supplier_gstin, doc_key, bill_id) values ($1,$2,$3,$4)`, [ctx.tenantId, l.supplier_gstin, normDoc(l.doc_number), billId]);
  return { period: l.period, ...(await matchGstr2b(ctx, l.import_id)) };
}

/** Removes a hand-made link; the document is matched by its number again. */
export async function unlinkGstr2b(ctx: RecordCtx, lineId: string) {
  await assertBooksAdmin(ctx);
  const l = await loadLine(ctx, lineId);
  await ctx.tx.query(`delete from gstr2b_links where tenant_id = $1 and supplier_gstin = $2 and doc_key = $3`, [ctx.tenantId, l.supplier_gstin, normDoc(l.doc_number)]);
  return { period: l.period, ...(await matchGstr2b(ctx, l.import_id)) };
}

const RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

/**
 * Enters GSTR-2B invoices that are not in the books as bills: the supplier is found by GSTIN (or
 * created from the GSTR-2B name), the bill carries the supplier's invoice number and date, and one line
 * holds the taxable value at the GST rate the invoice implies. Each line is done on its own, so one
 * failure (a duplicate number, an approval rule) leaves the others in place.
 */
export async function addGstr2bToBooks(ctx: RecordCtx, input: { lineIds: string[]; accountId?: string | null; post: boolean }) {
  await assertBooksAdmin(ctx);
  if (!input.lineIds.length) throw badRequest('Choose at least one GSTR-2B document');
  const events: RecordEvent[] = [];
  const results: { lineId: string; ok: boolean; billId?: string; billNumber?: string | null; status?: string; vendorCreated?: boolean; error?: string }[] = [];
  const imports = new Set<string>();
  for (const lineId of input.lineIds) {
    await ctx.tx.query('savepoint gstr2b_add');
    try {
      const l = await loadLine(ctx, lineId);
      imports.add(l.import_id);
      if (l.bill_id && l.match_status !== 'unmatched') throw conflict('Already matched to a bill');
      if (l.doc_type === 'credit_note' || l.doc_type === 'debit_note' || l.taxable < 0)
        throw badRequest('Credit and debit notes go in as a vendor credit against the original bill (open the bill → Vendor credit)');
      if (!validGstin(l.supplier_gstin)) throw badRequest(`${l.supplier_gstin} is not a valid GSTIN`);
      let vendorCreated = false;
      let vendor = await ctx.tx.one<{ id: string }>(`select id from vendors where tenant_id = $1 and gstin = $2 and deleted_at is null order by created_at limit 1`, [ctx.tenantId, l.supplier_gstin]);
      if (!vendor) {
        const pan = l.supplier_gstin.slice(2, 12);
        const v = await createRecord(ctx, 'vendor', {
          name: (l.supplier_name ?? '').trim() || l.supplier_gstin,
          gstin: l.supplier_gstin,
          ...(/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? { pan } : {}),
          notes: 'Added from GSTR-2B',
        });
        events.push(...v.events);
        vendor = { id: String(v.record.id) };
        vendorCreated = true;
      }
      const tax = r2(l.igst + l.cgst + l.sgst);
      const implied = l.taxable > 0 ? (tax / l.taxable) * 100 : 0;
      const rate = RATES.reduce((best, r) => (Math.abs(r - implied) < Math.abs(best - implied) ? r : best), 0);
      const lastDay = new Date(Date.UTC(Number(l.period.slice(2)), Number(l.period.slice(0, 2)), 0)).toISOString().slice(0, 10);
      const bill = await createRecord(ctx, 'bill', {
        name: `${(l.supplier_name ?? l.supplier_gstin).trim()} ${l.doc_number}`.slice(0, 200),
        vendor_id: vendor.id,
        vendor_ref: l.doc_number.slice(0, 60),
        bill_date: l.doc_date ?? lastDay,
        itc_eligible: l.itc_available,
        notes: `Entered from GSTR-2B ${l.period.slice(0, 2)}/${l.period.slice(2)}`,
      });
      events.push(...bill.events);
      const billId = String(bill.record.id);
      events.push(
        ...(await saveBillLines(ctx, billId, [
          {
            name: 'Purchase as per GSTR-2B',
            description: `Supplier invoice ${l.doc_number}${l.doc_date ? ` dated ${l.doc_date}` : ''}`,
            quantity: 1,
            unitPrice: r2(l.taxable),
            discountPct: 0,
            taxRate: rate,
            accountId: input.accountId ?? null,
          } as any,
        ])),
      );
      let status = 'draft';
      if (input.post) {
        // an approval rule or a closed period leaves the bill as a draft rather than failing the line
        await ctx.tx.query('savepoint gstr2b_post');
        try {
          events.push(...(await postBill(ctx, billId)));
          status = 'open';
          await ctx.tx.query('release savepoint gstr2b_post');
        } catch (e) {
          await ctx.tx.query('rollback to savepoint gstr2b_post');
          status = `draft — not posted: ${(e as Error).message}`;
        }
      }
      const bn = await ctx.tx.one<{ bill_number: string | null }>(`select bill_number from bills where tenant_id = $1 and id = $2`, [ctx.tenantId, billId]);
      await ctx.tx.query('release savepoint gstr2b_add');
      results.push({ lineId, ok: true, billId, billNumber: bn?.bill_number ?? null, status, vendorCreated });
    } catch (e) {
      await ctx.tx.query('rollback to savepoint gstr2b_add');
      results.push({ lineId, ok: false, error: (e as Error).message });
    }
  }
  // posted bills match by their number now
  let match: Record<string, number> | null = null;
  for (const id of imports) match = await matchGstr2b(ctx, id);
  // drafts keep their pointer to the new bill (matchGstr2b cleared it) so the screen can link to it
  for (const r of results)
    if (r.ok && r.status !== 'open')
      await ctx.tx.query(`update gstr2b_lines set bill_id = $3, note = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.lineId, r.billId, 'Draft bill entered from GSTR-2B: post it to match']);
  return {
    results,
    added: results.filter((r) => r.ok).length,
    posted: results.filter((r) => r.status === 'open').length,
    vendorsCreated: results.filter((r) => r.vendorCreated).length,
    match,
    events,
  };
}
