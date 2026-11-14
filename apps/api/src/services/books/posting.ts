/**
 * Automatic posting: each business document becomes one journal.
 *
 *  invoice        Dr Receivable · Cr Sales / Service income · Cr Output GST · (Dr COGS · Cr Inventory)
 *  credit note    the reverse of an invoice
 *  payment in     Dr Bank / Cash · Dr TDS receivable · Dr Bank charges · Cr Receivable (± exchange difference)
 *  write-off      Dr Bad debts · Cr Receivable
 *  bill           Dr Expense / Inventory · Dr Input GST · Cr Payable · Cr TDS payable (reverse charge: Cr RCM payable)
 *  vendor credit  the reverse of a bill
 *  payment out    Dr Payable · Cr Bank / Cash (± exchange difference)
 *  expense        Dr Expense · Dr Input GST · Cr Paid through (claims: Cr Employee reimbursements)
 *  reimbursement  Dr Employee reimbursements · Cr Bank
 *
 * `repost` voids a document's journal and writes a new one from its current state; a document
 * that is draft, cancelled or void simply ends up with no live journal.
 */
import type { Tx } from '../../lib/db';
import { badRequest } from '../../lib/errors';
import { type JLine, type JournalInput, postingOn, postJournal, r2, sys, voidSource, d10 } from './ledger';

export type Source = 'invoice' | 'credit_note' | 'payment' | 'write_off' | 'bill' | 'vendor_credit' | 'vendor_payment' | 'expense' | 'reimbursement';


async function cashAccount(tx: Tx, t: string, mode: string, explicit: string | null) {
  if (explicit) return explicit;
  return sys(tx, t, mode === 'cash' ? 'cash' : 'bank');
}

async function salesLines(tx: Tx, t: string, docId: string, rate: number, sign: 1 | -1, party: string | null, projectId: string | null) {
  const rows = await tx.query<{ line_subtotal: string; is_service: boolean; sales_account_id: string | null; product_type: string | null; name: string }>(
    `select l.line_subtotal, l.is_service, p.sales_account_id, p.product_type, l.name from invoice_lines l left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.order_id = $2`,
    [t, docId],
  );
  const sales = await sys(tx, t, 'sales');
  const service = await sys(tx, t, 'service_income');
  const out: JLine[] = [];
  for (const r of rows) {
    const acc = r.sales_account_id ?? (r.is_service || r.product_type === 'service' ? service : sales);
    const amt = r2(Number(r.line_subtotal) * rate);
    out.push(sign > 0 ? { accountId: acc, credit: amt, projectId, description: r.name } : { accountId: acc, debit: amt, projectId, description: r.name });
  }
  void party;
  return out;
}

async function cogsLines(tx: Tx, t: string, docId: string, inventoryOn: string, projectId: string | null): Promise<JLine[]> {
  if (inventoryOn !== 'bill') return [];
  const rows = await tx.query<{ qty: string; cost: string | null; name: string }>(
    `select l.quantity as qty, p.avg_cost as cost, l.name from invoice_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = $1 and l.order_id = $2 and p.track_inventory and p.product_type = 'goods' and p.avg_cost > 0`,
    [t, docId],
  );
  if (!rows.length) return [];
  const cogs = await sys(tx, t, 'cogs');
  const inv = await sys(tx, t, 'inventory');
  const out: JLine[] = [];
  for (const r of rows) {
    const amt = r2(Number(r.qty) * Number(r.cost));
    out.push({ accountId: cogs, debit: amt, projectId, description: `Cost of ${r.name}` }, { accountId: inv, credit: amt, description: `Cost of ${r.name}` });
  }
  return out;
}

async function taxLines(tx: Tx, t: string, totals: { cgst: number; sgst: number; igst: number }, side: 'debit' | 'credit', prefix: 'input' | 'output') {
  const out: JLine[] = [];
  for (const k of ['cgst', 'sgst', 'igst'] as const) {
    const v = r2(totals[k]);
    if (!v) continue;
    const acc = await sys(tx, t, `${prefix}_${k}`);
    out.push(side === 'debit' ? { accountId: acc, debit: v, taxKind: k } : { accountId: acc, credit: v, taxKind: k });
  }
  return out;
}

async function buildInvoice(tx: Tx, t: string, id: string, inventoryOn: string) {
  const r = await tx.one<Record<string, any>>(`select * from invoices where tenant_id = $1 and id = $2`, [t, id]);
  if (!r || r.deleted_at || r.doc_type === 'proforma' || ['draft', 'cancelled'].includes(r.status)) return null;
  const rate = Number(r.exchange_rate ?? 1);
  const credit = r.doc_type === 'credit_note';
  const sign: 1 | -1 = credit ? -1 : 1;
  const ar = await sys(tx, t, 'ar');
  const total = r2(Number(r.grand_total) * rate);
  const lines: JLine[] = [credit ? { accountId: ar, credit: total, partyType: 'customer', partyId: r.account_id } : { accountId: ar, debit: total, partyType: 'customer', partyId: r.account_id }];
  lines.push(...(await salesLines(tx, t, id, rate, sign, r.account_id, null)));
  lines.push(...(await taxLines(tx, t, { cgst: Number(r.cgst_total) * rate, sgst: Number(r.sgst_total) * rate, igst: Number(r.igst_total) * rate }, credit ? 'debit' : 'credit', 'output')));
  const ro = r2(Number(r.round_off) * rate);
  if (ro) {
    const acc = await sys(tx, t, 'round_off');
    lines.push((ro > 0) !== credit ? { accountId: acc, credit: Math.abs(ro) } : { accountId: acc, debit: Math.abs(ro) });
  }
  if (!credit) lines.push(...(await cogsLines(tx, t, id, inventoryOn, null)));
  return { date: d10(r.invoice_date), sourceType: credit ? 'credit_note' : 'invoice', sourceId: id, reference: r.invoice_number, narration: `${credit ? 'Credit note' : 'Invoice'} ${r.invoice_number ?? ''} · ${r.buyer_name ?? ''}`.trim(), currency: r.currency, exchangeRate: rate, lines };
}

async function buildPayment(tx: Tx, t: string, id: string) {
  const p = await tx.one<Record<string, any>>(`select * from payments where tenant_id = $1 and id = $2`, [t, id]);
  if (!p || p.status !== 'received' || p.deleted_at) return null;
  const rate = Number(p.exchange_rate ?? 1);
  const ar = await sys(tx, t, 'ar');
  const amount = Number(p.amount);
  const tds = Number(p.tds_amount ?? 0);
  const charges = Number(p.bank_charges ?? 0);
  // receivable cleared at each invoice's own rate; the rest at the payment's rate
  const allocs = await tx.query<{ amount: string; rate: string }>(
    `select a.amount, i.exchange_rate as rate from payment_allocations a join invoices i on i.tenant_id = a.tenant_id and i.id = a.invoice_id where a.tenant_id = $1 and a.payment_id = $2`,
    [t, id],
  );
  const allocated = allocs.reduce((s, a) => s + Number(a.amount), 0);
  const arCredit = r2(allocs.reduce((s, a) => s + Number(a.amount) * Number(a.rate), 0) + (amount - allocated) * rate);
  const bank = await cashAccount(tx, t, p.mode, p.deposit_account_id);
  const lines: JLine[] = [
    { accountId: bank, debit: r2((amount - tds - charges) * rate) },
    { accountId: ar, credit: arCredit, partyType: 'customer', partyId: p.account_id },
  ];
  if (tds) lines.push({ accountId: await sys(tx, t, 'tds_receivable'), debit: r2(tds * rate), taxKind: 'tds' });
  if (charges) lines.push({ accountId: await sys(tx, t, 'bank_charges'), debit: r2(charges * rate) });
  const fx = r2(arCredit - amount * rate);
  if (fx) {
    const acc = await sys(tx, t, 'fx_gain_loss');
    lines.push(fx > 0 ? { accountId: acc, debit: fx, description: 'Exchange loss' } : { accountId: acc, credit: -fx, description: 'Exchange gain' });
  }
  return { date: d10(p.payment_date), sourceType: 'payment', sourceId: id, reference: p.payment_number, narration: `Receipt ${p.payment_number ?? ''}${p.reference ? ` · ${p.reference}` : ''}`, currency: p.currency, exchangeRate: rate, lines };
}

async function buildWriteOff(tx: Tx, t: string, id: string) {
  const r = await tx.one<Record<string, any>>(`select invoice_number, account_id, amount_written_off, written_off_on, exchange_rate, status, deleted_at from invoices where tenant_id = $1 and id = $2`, [t, id]);
  if (!r || r.deleted_at || r.status === 'cancelled' || !Number(r.amount_written_off)) return null;
  const amt = r2(Number(r.amount_written_off) * Number(r.exchange_rate ?? 1));
  return {
    date: d10(r.written_off_on ?? new Date()),
    sourceType: 'write_off',
    sourceId: id,
    reference: r.invoice_number,
    narration: `Bad debt written off · ${r.invoice_number}`,
    lines: [
      { accountId: await sys(tx, t, 'bad_debts'), debit: amt },
      { accountId: await sys(tx, t, 'ar'), credit: amt, partyType: 'customer' as const, partyId: r.account_id },
    ],
  };
}

async function buildBill(tx: Tx, t: string, id: string, inventoryOn: string) {
  const b = await tx.one<Record<string, any>>(`select * from bills where tenant_id = $1 and id = $2`, [t, id]);
  if (!b || b.deleted_at || ['draft', 'void'].includes(b.status)) return null;
  const rate = Number(b.exchange_rate ?? 1);
  const credit = b.doc_type === 'vendor_credit';
  const dr = (accountId: string, v: number, extra: Partial<JLine> = {}): JLine => (credit ? { accountId, credit: v, ...extra } : { accountId, debit: v, ...extra });
  const cr = (accountId: string, v: number, extra: Partial<JLine> = {}): JLine => (credit ? { accountId, debit: v, ...extra } : { accountId, credit: v, ...extra });
  const rows = await tx.query<{ line_subtotal: string; line_tax: string; account_id: string | null; purchase_account_id: string | null; track_inventory: boolean | null; product_type: string | null; name: string; project_id: string | null }>(
    `select l.line_subtotal, l.line_tax, l.account_id, p.purchase_account_id, p.track_inventory, p.product_type, l.name, l.project_id
       from bill_lines l left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.order_id = $2`,
    [t, id],
  );
  const inventory = await sys(tx, t, 'inventory');
  const purchases = await sys(tx, t, 'purchases');
  const itc = b.itc_eligible !== false;
  const lines: JLine[] = [];
  for (const r of rows) {
    const acc = r.account_id ?? r.purchase_account_id ?? (r.track_inventory && r.product_type === 'goods' && inventoryOn === 'bill' ? inventory : purchases);
    // tax that cannot be claimed becomes part of the cost
    const cost = Number(r.line_subtotal) + (itc ? 0 : Number(r.line_tax));
    lines.push(dr(acc, r2(cost * rate), { projectId: r.project_id ?? b.project_id ?? null, description: r.name }));
  }
  const tax = { cgst: Number(b.cgst_total) * rate, sgst: Number(b.sgst_total) * rate, igst: Number(b.igst_total) * rate };
  if (itc) for (const l of await taxLines(tx, t, tax, 'debit', 'input')) lines.push(credit ? { ...l, credit: l.debit, debit: 0 } : l);
  if (b.reverse_charge) {
    const rcm = r2(tax.cgst + tax.sgst + tax.igst);
    if (rcm) lines.push(cr(await sys(tx, t, 'rcm_payable'), rcm, { description: 'GST on reverse charge' }));
  }
  const ro = r2(Number(b.round_off) * rate);
  if (ro) lines.push(ro > 0 ? dr(await sys(tx, t, 'round_off'), ro) : cr(await sys(tx, t, 'round_off'), -ro));
  const tds = r2(Number(b.tds_amount) * rate);
  if (tds) lines.push(cr(await sys(tx, t, 'tds_payable'), tds, { taxKind: 'tds', description: `TDS ${b.tds_section ?? ''}`.trim(), partyType: 'vendor', partyId: b.vendor_id }));
  lines.push(cr(await sys(tx, t, 'ap'), r2(Number(b.grand_total) * rate - tds), { partyType: 'vendor', partyId: b.vendor_id }));
  return { date: d10(b.bill_date), sourceType: credit ? 'vendor_credit' : 'bill', sourceId: id, reference: b.vendor_ref ?? b.bill_number, narration: `${credit ? 'Vendor credit' : 'Bill'} ${b.bill_number ?? ''}${b.vendor_ref ? ` (${b.vendor_ref})` : ''}`, currency: b.currency, exchangeRate: rate, lines };
}

async function buildVendorPayment(tx: Tx, t: string, id: string) {
  const p = await tx.one<Record<string, any>>(`select * from vendor_payments where tenant_id = $1 and id = $2`, [t, id]);
  if (!p || p.status !== 'paid' || p.deleted_at) return null;
  const rate = Number(p.exchange_rate ?? 1);
  const amount = Number(p.amount);
  const allocs = await tx.query<{ amount: string; rate: string }>(
    `select a.amount, b.exchange_rate as rate from vendor_payment_allocations a join bills b on b.tenant_id = a.tenant_id and b.id = a.bill_id where a.tenant_id = $1 and a.payment_id = $2`,
    [t, id],
  );
  const allocated = allocs.reduce((s, a) => s + Number(a.amount), 0);
  const apDebit = r2(allocs.reduce((s, a) => s + Number(a.amount) * Number(a.rate), 0) + (amount - allocated) * rate);
  const lines: JLine[] = [
    { accountId: await sys(tx, t, 'ap'), debit: apDebit, partyType: 'vendor', partyId: p.vendor_id },
    { accountId: await cashAccount(tx, t, p.mode, p.paid_through_id), credit: r2(amount * rate) },
  ];
  const fx = r2(amount * rate - apDebit);
  if (fx) {
    const acc = await sys(tx, t, 'fx_gain_loss');
    lines.push(fx > 0 ? { accountId: acc, debit: fx, description: 'Exchange loss' } : { accountId: acc, credit: -fx, description: 'Exchange gain' });
  }
  return { date: d10(p.payment_date), sourceType: 'vendor_payment', sourceId: id, reference: p.payment_number, narration: `Payment ${p.payment_number ?? ''}${p.reference ? ` · ${p.reference}` : ''}`, currency: p.currency, exchangeRate: rate, lines };
}

async function buildExpense(tx: Tx, t: string, id: string) {
  const e = await tx.one<Record<string, any>>(`select * from expenses where tenant_id = $1 and id = $2`, [t, id]);
  if (!e || e.deleted_at || !['approved', 'recorded', 'reimbursed'].includes(e.status)) return null;
  const rate = Number(e.exchange_rate ?? 1);
  const itc = e.itc_eligible !== false && !!Number(e.tax_amount);
  const expenseAcc = e.account_id ?? (await sys(tx, t, 'uncategorised'));
  const lines: JLine[] = [{ accountId: expenseAcc, debit: r2((Number(e.taxable_amount) + (itc ? 0 : Number(e.tax_amount))) * rate), projectId: e.project_id, description: e.name }];
  if (itc) {
    const tax = Number(e.tax_amount) * rate;
    const split = e.supply_type === 'inter' ? { cgst: 0, sgst: 0, igst: tax } : { cgst: r2(tax / 2), sgst: r2(tax - r2(tax / 2)), igst: 0 };
    lines.push(...(await taxLines(tx, t, split, 'debit', 'input')));
  }
  const through = e.is_claim ? await sys(tx, t, 'employee_payable') : e.paid_through_id ?? (await sys(tx, t, 'cash'));
  lines.push({ accountId: through, credit: r2(Number(e.total) * rate), ...(e.is_claim ? { partyType: 'employee' as const, partyId: e.owner_id } : {}) });
  return { date: d10(e.expense_date), sourceType: 'expense', sourceId: id, reference: e.expense_number ?? e.reference, narration: `Expense ${e.expense_number ?? ''} · ${e.name}`, currency: e.currency, exchangeRate: rate, lines };
}

async function buildReimbursement(tx: Tx, t: string, id: string) {
  const e = await tx.one<Record<string, any>>(`select * from expenses where tenant_id = $1 and id = $2`, [t, id]);
  if (!e || e.deleted_at || e.status !== 'reimbursed' || !e.is_claim) return null;
  const amt = r2(Number(e.total) * Number(e.exchange_rate ?? 1));
  return {
    date: d10(e.reimbursed_at ?? new Date()),
    sourceType: 'reimbursement',
    sourceId: id,
    reference: e.expense_number,
    narration: `Reimbursed ${e.expense_number ?? ''} · ${e.name}`,
    lines: [
      { accountId: await sys(tx, t, 'employee_payable'), debit: amt, partyType: 'employee' as const, partyId: e.owner_id },
      { accountId: e.reimbursed_through_id ?? (await sys(tx, t, 'bank')), credit: amt },
    ],
  };
}

/**
 * Brings a document's journal in line with the document. No-op unless Synapse keeps the books.
 * Documents dated before the books start date are covered by opening balances instead.
 */
export async function repost(tx: Tx, tenantId: string, source: Source, id: string) {
  const cfg = await postingOn(tx, tenantId);
  if (!cfg) return null;
  const j =
    source === 'invoice' || source === 'credit_note'
      ? await buildInvoice(tx, tenantId, id, cfg.inventory_on)
      : source === 'payment'
        ? await buildPayment(tx, tenantId, id)
        : source === 'write_off'
          ? await buildWriteOff(tx, tenantId, id)
          : source === 'bill' || source === 'vendor_credit'
            ? await buildBill(tx, tenantId, id, cfg.inventory_on)
            : source === 'vendor_payment'
              ? await buildVendorPayment(tx, tenantId, id)
              : source === 'expense'
                ? await buildExpense(tx, tenantId, id)
                : await buildReimbursement(tx, tenantId, id);
  // the live journal may be under the invoice/credit-note or bill/vendor-credit type
  const types = source === 'invoice' || source === 'credit_note' ? ['invoice', 'credit_note'] : source === 'bill' || source === 'vendor_credit' ? ['bill', 'vendor_credit'] : [source];
  const want = j && j.date >= cfg.start_date ? j : null;
  const live = await tx.query<{ id: string; source_type: string; entry_date: string }>(
    `select id, source_type, entry_date::text as entry_date from journals where tenant_id = $1 and source_id = $2 and source_type = any($3::text[]) and status = 'posted'`,
    [tenantId, id, types],
  );
  // nothing changed: keep the posted entry (no void-and-repost churn in the day book)
  if (want && live.length === 1 && live[0]!.source_type === want.sourceType && live[0]!.entry_date === want.date) {
    const have = await tx.query<{ account_id: string; debit: string; credit: string; party_id: string | null }>(`select account_id, debit, credit, party_id from journal_lines where tenant_id = $1 and journal_id = $2`, [tenantId, live[0]!.id]);
    const sig = (xs: { a: string; d: number; c: number; p: string }[]) => xs.map((l) => `${l.a}:${l.d.toFixed(2)}:${l.c.toFixed(2)}:${l.p}`).sort().join('|');
    if (sig(have.map((l) => ({ a: l.account_id, d: Number(l.debit), c: Number(l.credit), p: l.party_id ?? '' }))) === sig(await normalised(tx, tenantId, want))) return live[0]!.id;
  }
  if (live.length) {
    const ids = live.map((l) => l.id);
    const rec = await tx.one(`select 1 from journal_lines where tenant_id = $1 and journal_id = any($2::uuid[]) and reconciliation_id is not null limit 1`, [tenantId, ids]);
    if (rec) throw badRequest('This entry is reconciled with a bank statement; undo that reconciliation first');
    // statement lines matched to the old entry go back to "to match"
    await tx.query(
      `update bank_transactions set status = 'unmatched', journal_id = null where tenant_id = $1 and (journal_id = any($2::uuid[]) or id in (select bank_txn_id from journal_lines where tenant_id = $1 and journal_id = any($2::uuid[]) and bank_txn_id is not null))`,
      [tenantId, ids],
    );
  }
  for (const t of types) await voidSource(tx, tenantId, t, id, 'Document changed');
  if (!want) return null;
  return postJournal(tx, tenantId, want);
}

/** The lines postJournal would write (same rounding and zero-line dropping), to compare with a posted entry. */
async function normalised(tx: Tx, tenantId: string, j: JournalInput) {
  const lines = j.lines
    .map((l) => {
      const net = r2((l.debit ?? 0) - (l.credit ?? 0));
      return { a: l.accountId, d: net > 0 ? net : 0, c: net < 0 ? -net : 0, p: l.partyId ?? '' };
    })
    .filter((l) => l.d > 0 || l.c > 0);
  const diff = r2(lines.reduce((s, l) => s + l.d - l.c, 0));
  if (diff) lines.push({ a: await sys(tx, tenantId, 'round_off'), d: diff < 0 ? -diff : 0, c: diff > 0 ? diff : 0, p: '' });
  return lines;
}

/** Posts every document from the books start date (used when books are switched on). */
export async function postHistory(tx: Tx, tenantId: string) {
  const cfg = await postingOn(tx, tenantId);
  if (!cfg) return { posted: 0 };
  let posted = 0;
  const run = async (source: Source, sql: string) => {
    for (const r of await tx.query<{ id: string }>(sql, [tenantId, cfg.start_date])) if (await repost(tx, tenantId, source, r.id)) posted++;
  };
  await run('invoice', `select id from invoices where tenant_id = $1 and invoice_date >= $2 and status not in ('draft','cancelled') and doc_type <> 'proforma' and deleted_at is null order by invoice_date`);
  await run('write_off', `select id from invoices where tenant_id = $1 and invoice_date >= $2 and amount_written_off > 0 and deleted_at is null`);
  await run('payment', `select id from payments where tenant_id = $1 and payment_date >= $2 and status = 'received' and deleted_at is null order by payment_date`);
  await run('bill', `select id from bills where tenant_id = $1 and bill_date >= $2 and status not in ('draft','void') and deleted_at is null order by bill_date`);
  await run('vendor_payment', `select id from vendor_payments where tenant_id = $1 and payment_date >= $2 and status = 'paid' and deleted_at is null`);
  await run('expense', `select id from expenses where tenant_id = $1 and expense_date >= $2 and status in ('approved','recorded','reimbursed') and deleted_at is null`);
  await run('reimbursement', `select id from expenses where tenant_id = $1 and expense_date >= $2 and status = 'reimbursed' and is_claim and deleted_at is null`);
  return { posted };
}
