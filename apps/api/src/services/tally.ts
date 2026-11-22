/**
 * Two-way Tally sync through a connector on the accountant's PC (connectors/tally).
 *
 *  SanchalanOS → Tally: customer ledgers, sales invoices, credit notes and receipts, each pushed
 *  once and again only if it changed (content hash). Invoices cancelled after they reached Tally
 *  are flagged for the accountant instead of being cancelled silently.
 *  Tally → SanchalanOS: receipts entered in Tally are recorded as payments and settle the invoices
 *  named in their bill references. Each Tally voucher is applied once (its GUID).
 *
 * The connector authenticates with a long random token shown once when connecting; SanchalanOS keeps
 * only its SHA-256.
 */
import type { Env } from '../env';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Tx } from '../lib/db';
import { badRequest, notFound, unauthorized } from '../lib/errors';
import { billingSettings, recordPayment } from './billing';
import { ledgerXml, receiptVoucherXml, salesVoucherXml, tallyEnvelope } from './gst-exports';
import { claimRef, type Integration, markOk, readSecret, sealSecret } from './integrations';
import { letterhead } from './quotes';
import type { RecordCtx, RecordEvent } from './records';

export interface TallyConfig {
  syncFrom: string;
  pushReceipts: boolean;
  importReceipts: boolean;
  ledgerParent: string;
  companyName?: string | null;
}
export const defaultTallyConfig = (): TallyConfig => {
  // the current financial year by default
  const now = new Date(Date.now() + 330 * 60_000);
  const fy = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { syncFrom: `${fy}-04-01`, pushReceipts: true, importReceipts: true, ledgerParent: 'Sundry Debtors', companyName: null };
};
const cfgOf = (i: Integration): TallyConfig => ({ ...defaultTallyConfig(), ...(i.config as Partial<TallyConfig>) });

export async function tallyIntegration(tx: Tx, tenantId: string) {
  return tx.one<Integration>(`select * from integrations where tenant_id = $1 and provider = 'tally'`, [tenantId]);
}

/** Creates the Tally connection (or a fresh token for it). The token is returned once. */
export async function connectTally(env: Env, tx: Tx, tenantId: string) {
  const token = `tly_${randomToken(32)}`;
  const secret = await sealSecret(env, tenantId, { tokenHash: await sha256Hex(token) });
  const existing = await tallyIntegration(tx, tenantId);
  if (existing) {
    await tx.query(`update integrations set secret_ciphertext = $3, status = 'active' where tenant_id = $1 and id = $2`, [tenantId, existing.id, secret]);
    await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'rotate_key', 'integration', $2, '{"provider":"tally"}')`, [tenantId, existing.id]);
    return { id: existing.id, routeKey: existing.route_key, token };
  }
  const r = await tx.one<{ id: string; route_key: string }>(
    `insert into integrations (tenant_id, provider, label, account_ref, config, secret_ciphertext) values ($1, 'tally', 'Tally', 'tally', $2, $3) returning id, route_key`,
    [tenantId, JSON.stringify(defaultTallyConfig()), secret],
  );
  return { id: r!.id, routeKey: r!.route_key, token };
}

export async function verifyConnector(env: Env, i: Integration, header: string | undefined | null) {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !/^tly_[A-Za-z0-9_-]{30,80}$/.test(token)) throw unauthorized('Missing connector token');
  const s = await readSecret<{ tokenHash?: string }>(env, i);
  if (!s.tokenHash || !timingSafeEqual(s.tokenHash, await sha256Hex(token))) throw unauthorized('Invalid connector token');
}

const hashOf = (o: unknown) => sha256Hex(JSON.stringify(o));

export interface PendingItem {
  kind: 'ledger' | 'sales' | 'credit_note' | 'receipt';
  id: string;
  name: string;
  /** a ledger that may already exist in Tally: the connector retries it as "Alter" */
  alterXml?: string;
  xml: string;
}

/**
 * The next batch for Tally: ledgers first (vouchers need their party), then invoices and credit
 * notes, then receipts. Items stay "sent" until the connector acknowledges them; anything sent
 * more than 30 minutes ago without an answer is offered again.
 */
export async function pendingForTally(ctx: RecordCtx, i: Integration, limit = 50) {
  const cfg = cfgOf(i);
  const { tx, tenantId } = ctx;
  const L = (await billingSettings(ctx)).ledgers;
  const company = cfg.companyName || (await letterhead(ctx)).name;
  const state = new Map(
    (await tx.query<{ kind: string; record_id: string; status: string; hash: string | null; sent_at: Date | null }>(`select kind, record_id, status, hash, sent_at from tally_sync where tenant_id = $1`, [tenantId])).map((r) => [`${r.kind}:${r.record_id}`, r]),
  );
  const due = (kind: string, id: string, hash: string) => {
    const s = state.get(`${kind}:${id}`);
    if (!s) return true;
    if (s.status === 'needs_attention') return false;
    if (s.status === 'synced' && s.hash === hash) return false;
    if (s.status === 'sent' && s.hash === hash && s.sent_at && Date.now() - new Date(s.sent_at).getTime() < 30 * 60_000) return false;
    // failed items are retried by the admin ("Retry failed"), not on every pull
    if (s.status === 'failed' && s.hash === hash) return false;
    return true;
  };
  const items: (PendingItem & { hash: string })[] = [];
  // a voucher Tally already has must not vanish quietly when cancelled here
  await tx.query(
    `update tally_sync s set status = 'needs_attention', error = 'Cancelled in SanchalanOS: cancel voucher ' || i.invoice_number || ' in Tally'
       from invoices i
      where s.tenant_id = $1 and i.tenant_id = s.tenant_id and i.id = s.record_id and s.kind in ('sales', 'credit_note')
        and s.status in ('synced', 'sent') and i.status = 'cancelled'`,
    [tenantId],
  );
  // only what is new or changed since it last went to Tally, so old synced invoices never crowd
  // out new ones (the hash check below still catches edits that did not change the voucher)
  const invoices = await tx.query<Record<string, any>>(
    `select i.*, o.invoice_number as original_invoice_number, a.name as account_name, a.address as account_address, a.state as account_state, a.pincode as account_pincode
       from invoices i left join invoices o on o.tenant_id = i.tenant_id and o.id = i.original_invoice_id
       left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and i.doc_type in ('tax_invoice', 'credit_note') and i.status not in ('draft', 'cancelled') and i.deleted_at is null and i.invoice_date >= $2::date
        and not exists (select 1 from tally_sync s where s.tenant_id = i.tenant_id and s.record_id = i.id
                          and s.kind = case when i.doc_type = 'credit_note' then 'credit_note' else 'sales' end
                          and s.updated_at >= i.updated_at
                          and (s.status in ('synced', 'failed', 'needs_attention') or (s.status = 'sent' and s.sent_at > now() - interval '30 minutes')))
      order by i.invoice_date, i.invoice_number limit 500`,
    [tenantId, cfg.syncFrom],
  );
  const live = invoices.filter((v) => v.status !== 'cancelled');
  const ledgersSeen = new Set<string>();
  for (const inv of live) {
    const name = String(inv.buyer_name ?? inv.account_name ?? '').trim();
    if (!name) continue;
    const ledgerId = (inv.account_id as string | null) ?? inv.id;
    if (ledgersSeen.has(ledgerId)) continue;
    ledgersSeen.add(ledgerId);
    const l = { name, gstin: inv.buyer_gstin, state: inv.buyer_state ?? inv.account_state, address: inv.buyer_address ?? inv.account_address, pincode: inv.buyer_pincode ?? inv.account_pincode, parent: cfg.ledgerParent };
    const hash = await hashOf(l);
    if (due('ledger', ledgerId, hash)) items.push({ kind: 'ledger', id: ledgerId, name, xml: tallyEnvelope(company, [ledgerXml(l, 'Create')]), alterXml: tallyEnvelope(company, [ledgerXml(l, 'Alter')]), hash });
  }
  for (const inv of live) {
    const kind = inv.doc_type === 'credit_note' ? 'credit_note' : 'sales';
    const hash = await hashOf([inv.invoice_number, inv.invoice_date, inv.grand_total, inv.buyer_name, inv.buyer_gstin, inv.taxable_total, inv.cgst_total, inv.sgst_total, inv.igst_total]);
    if (!due(kind, inv.id, hash)) continue;
    // a voucher waits until its party ledger is in Tally
    const ledgerId = (inv.account_id as string | null) ?? inv.id;
    const ls = state.get(`ledger:${ledgerId}`);
    const ledgerReady = ls?.status === 'synced' || items.some((x) => x.kind === 'ledger' && x.id === ledgerId);
    if (!ledgerReady) continue;
    // already in Tally (an edit): alter the voucher with the same REMOTEID instead of creating a twin
    const action = state.get(`${kind}:${inv.id}`)?.status === 'synced' ? 'Alter' : 'Create';
    items.push({ kind, id: inv.id, name: String(inv.invoice_number), xml: tallyEnvelope(company, [salesVoucherXml(L, inv, { remoteId: `synapse-${inv.id}`, billWise: true, action })]), hash });
  }
  if (cfg.pushReceipts) {
    const pays = await tx.query<Record<string, any>>(
      `select p.*, a.name as account_name,
              (select json_agg(json_build_object('name', i.invoice_number, 'amount', pa.amount::float8)) from payment_allocations pa join invoices i on i.tenant_id = pa.tenant_id and i.id = pa.invoice_id where pa.tenant_id = p.tenant_id and pa.payment_id = p.id) as bills
         from payments p left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
        where p.tenant_id = $1 and p.status = 'received' and p.deleted_at is null and p.payment_date >= $2::date
          and not exists (select 1 from external_refs e where e.tenant_id = p.tenant_id and e.provider = 'tally-receipt' and e.object_key = 'payment' and e.record_id = p.id)
          and not exists (select 1 from tally_sync s where s.tenant_id = p.tenant_id and s.kind = 'receipt' and s.record_id = p.id and s.updated_at >= p.updated_at
                            and (s.status in ('synced', 'failed', 'needs_attention') or (s.status = 'sent' and s.sent_at > now() - interval '30 minutes')))
        order by p.payment_date limit 500`,
      [tenantId, cfg.syncFrom],
    );
    for (const p of pays) {
      const bills = ((p.bills as { name: string; amount: number }[] | null) ?? []).filter((b) => b.name);
      // deductions join the hash only when there are any, so receipts already in Tally are not re-sent
      const ded = [p.tds_amount, p.gst_tds_amount, p.ld_amount, p.retention_amount, p.bank_charges].map(Number);
      const hash = await hashOf(ded.some((v) => v > 0) ? [p.payment_number, p.payment_date, p.amount, bills, ded] : [p.payment_number, p.payment_date, p.amount, bills]);
      if (!due('receipt', p.id, hash)) continue;
      // the party is the ledger of the invoices it settles (or the customer's name)
      const party = String(p.account_name ?? '').trim();
      if (!party) continue;
      const lid = p.account_id as string | null;
      if (lid && !(state.get(`ledger:${lid}`)?.status === 'synced' || items.some((x) => x.kind === 'ledger' && x.id === lid))) continue;
      const action = state.get(`receipt:${p.id}`)?.status === 'synced' ? 'Alter' : 'Create';
      items.push({ kind: 'receipt', id: p.id, name: String(p.payment_number), xml: tallyEnvelope(company, [receiptVoucherXml(L, p, party, bills, `synapse-${p.id}`, action)]), hash });
    }
  }
  const batch = items.slice(0, limit);
  for (const it of batch) {
    await tx.query(
      `insert into tally_sync (tenant_id, kind, record_id, name, status, hash, sent_at, attempts) values ($1,$2,$3,$4,'sent',$5, now(), 1)
       on conflict (tenant_id, kind, record_id) do update set status = 'sent', hash = excluded.hash, name = excluded.name, sent_at = now(), attempts = tally_sync.attempts + 1, error = null`,
      [tenantId, it.kind, it.id, it.name, it.hash],
    );
  }
  await tx.query(`update integrations set last_sync_at = now() where tenant_id = $1 and id = $2`, [tenantId, i.id]);
  return { company, items: batch.map(({ hash: _h, ...rest }) => rest), more: items.length > limit };
}

export async function ackFromTally(tx: Tx, tenantId: string, i: Integration, results: { kind: string; id: string; ok: boolean; error?: string | null }[]) {
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    const u = await tx.query(
      `update tally_sync set status = $4, error = $5, synced_at = case when $4 = 'synced' then now() else synced_at end where tenant_id = $1 and kind = $2 and record_id = $3 and status = 'sent' returning 1`,
      [tenantId, r.kind, r.id, r.ok ? 'synced' : 'failed', r.ok ? null : String(r.error ?? 'Tally rejected it').slice(0, 1000)],
    );
    if (u.length) r.ok ? ok++ : failed++;
  }
  await markOk(tx, i, { event: true });
  return { ok, failed };
}

export interface TallyReceipt {
  guid: string;
  remoteId?: string | null;
  date: string;
  number?: string | null;
  party: string;
  amount: number;
  narration?: string | null;
  bills?: { name: string; amount: number }[];
}

/** Receipts entered in Tally become payments here, allocated to the invoices they name. */
export async function receiptsFromTally(ctx: RecordCtx, i: Integration, list: TallyReceipt[]) {
  const cfg = cfgOf(i);
  if (!cfg.importReceipts) return { imported: 0, skipped: list.length, unmatched: [] as string[], events: [] as RecordEvent[] };
  const { tx, tenantId } = ctx;
  let imported = 0;
  let skipped = 0;
  const unmatched: string[] = [];
  const events: RecordEvent[] = [];
  for (const v of list.slice(0, 200)) {
    // our own receipts come back from Tally too: they are already here
    if (v.remoteId?.startsWith('synapse-')) {
      skipped++;
      continue;
    }
    if (!(v.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || v.date < cfg.syncFrom) {
      skipped++;
      continue;
    }
    if (typeof v.guid !== 'string' || !v.guid || v.guid.length > 200) {
      skipped++;
      continue;
    }
    // two connector runs posting the same voucher: the second waits here, then sees it applied
    await tx.query(`select pg_advisory_xact_lock(hashtext('tally-receipt:' || $1 || ':' || $2))`, [tenantId, v.guid]);
    if (await tx.one(`select 1 from external_refs where tenant_id = $1 and provider = 'tally-receipt' and external_id = $2`, [tenantId, v.guid])) {
      skipped++;
      continue;
    }
    // one bad receipt must not undo the others: each is applied under its own savepoint
    await tx.query('savepoint tally_receipt');
    try {
      const invs = v.bills?.length
        ? await tx.query<{ id: string; account_id: string | null; balance_due: string; invoice_number: string }>(
            `select id, account_id, balance_due, invoice_number from invoices where tenant_id = $1 and doc_type = 'tax_invoice' and status in ('issued','partially_paid','paid') and invoice_number = any($2::text[])`,
            [tenantId, v.bills.map((b) => b.name)],
          )
        : [];
      let accountId = invs.find((x) => x.account_id)?.account_id ?? null;
      if (!accountId) {
        const a = await tx.query<{ id: string }>(`select id from accounts where tenant_id = $1 and lower(name) = lower($2) and deleted_at is null limit 2`, [tenantId, String(v.party ?? '').trim()]);
        if (a.length === 1) accountId = a[0]!.id;
      }
      if (!accountId) {
        await tx.query('release savepoint tally_receipt');
        unmatched.push(`${v.number ?? v.guid}: ${v.party}`);
        continue;
      }
      const allocations = invs
        .map((inv) => ({ invoiceId: inv.id, amount: Math.min(Number(inv.balance_due), v.bills!.find((b) => b.name === inv.invoice_number)?.amount ?? 0) }))
        .filter((a) => a.amount > 0);
      const r = await recordPayment(ctx, {
        accountId,
        amount: Math.round(v.amount * 100) / 100,
        date: v.date,
        mode: 'bank_transfer',
        reference: `Tally ${v.number ?? ''}`.trim().slice(0, 100),
        notes: v.narration?.slice(0, 500) ?? null,
        allocations: allocations.length ? allocations : undefined,
      });
      await claimRef(tx, tenantId, 'tally-receipt', v.guid, 'payment', r.id);
      await tx.query(`insert into tally_sync (tenant_id, kind, record_id, name, status, synced_at) values ($1, 'receipt', $2, $3, 'synced', now()) on conflict do nothing`, [tenantId, r.id, r.number]);
      await tx.query('release savepoint tally_receipt');
      events.push(...r.events);
      imported++;
    } catch (e) {
      await tx.query('rollback to savepoint tally_receipt');
      unmatched.push(`${v.number ?? v.guid}: ${v.party} (${(e as Error).message.slice(0, 160)})`);
    }
  }
  await tx.query(`update integrations set sync_state = sync_state || $3, last_event_at = now() where tenant_id = $1 and id = $2`, [tenantId, i.id, JSON.stringify({ lastImport: { at: new Date().toISOString(), imported, skipped, unmatched: unmatched.slice(0, 20) } })]);
  return { imported, skipped, unmatched, events };
}

export async function tallyStatus(tx: Tx, tenantId: string) {
  const i = await tallyIntegration(tx, tenantId);
  if (!i) return null;
  const counts = await tx.query<{ kind: string; status: string; n: number }>(`select kind, status, count(*)::int as n from tally_sync where tenant_id = $1 group by 1, 2`, [tenantId]);
  const problems = await tx.query(`select kind, record_id, name, status, error, updated_at from tally_sync where tenant_id = $1 and status in ('failed', 'needs_attention') order by updated_at desc limit 50`, [tenantId]);
  return { id: i.id, routeKey: i.route_key, status: i.status, config: cfgOf(i), lastPullAt: i.last_sync_at, lastAckAt: i.last_event_at, lastImport: (i.sync_state as Record<string, unknown>)?.lastImport ?? null, counts, problems };
}

export async function updateTallyConfig(tx: Tx, tenantId: string, patch: Partial<TallyConfig>) {
  const i = await tallyIntegration(tx, tenantId);
  if (!i) throw notFound('Connect Tally first');
  if (patch.syncFrom && !/^\d{4}-\d{2}-\d{2}$/.test(patch.syncFrom)) throw badRequest('Sync-from must be a date');
  await tx.query(`update integrations set config = config || $3 where tenant_id = $1 and id = $2`, [tenantId, i.id, JSON.stringify(patch)]);
}
