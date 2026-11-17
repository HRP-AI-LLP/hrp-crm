/**
 * Online collection through Razorpay Payment Links (UPI, cards, net banking, wallets).
 *
 *   create   a link for an invoice's balance or an order milestone; Razorpay can SMS / email it,
 *            and staff can share it on WhatsApp
 *   webhook  payment_link.paid (signed with the workspace's webhook secret) records the receipt,
 *            allocated to the invoice or milestone — once, however often Razorpay retries
 *   UPI QR   printed invoices carry a UPI QR for the balance when a UPI ID is set (no gateway)
 */
import { hasAdmin } from '@synapse/shared';
import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Tx } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { enabledApps } from './apps';
import { milestoneReceipt, recordPayment } from './billing';
import { sys } from './books/ledger';
import { repost } from './books/posting';
import { activeOf, claimRef, type Integration, markOk, ProviderError, providerFetch, readSecret } from './integrations';
import { recordMilestonePayment } from './orders';
import { loadRow, type RecordCtx, type RecordEvent } from './records';
import { systemPrincipal } from './system';

const RZP = 'https://api.razorpay.com/v1';
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface RazorpaySecret {
  keySecret: string;
  webhookSecret: string;
}

export async function razorpayAuth(env: Env, i: Integration) {
  const s = await readSecret<RazorpaySecret>(env, i);
  return `Basic ${btoa(`${i.account_ref}:${s.keySecret}`)}`;
}

/** Checks a key pair against Razorpay before it is saved. */
export async function verifyRazorpayKeys(keyId: string, keySecret: string) {
  try {
    await providerFetch(`${RZP}/payment_links?count=1`, { headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` } });
  } catch (e) {
    if (e instanceof ProviderError && e.status === 401) throw badRequest('Razorpay rejected these keys — copy the Key ID and Key Secret again from Razorpay Dashboard → Settings → API Keys');
    throw badRequest(`Could not check the keys with Razorpay: ${(e as Error).message}`);
  }
}

export interface LinkTarget {
  invoiceId?: string | null;
  salesOrderId?: string | null;
  milestoneId?: string | null;
  amount?: number | null;
  notifySms?: boolean;
  notifyEmail?: boolean;
  expireInDays?: number | null;
}

/** Creates a Razorpay payment link for what is still owed. */
export async function createPaymentLink(env: Env, ctx: RecordCtx, t: LinkTarget, origin: string) {
  const i = await activeOf(ctx.tx, ctx.tenantId, 'razorpay');
  if (!i) throw badRequest('Connect Razorpay in Settings → Integrations to collect payments online');
  let due = 0;
  let purpose = '';
  let accountId: string | null = null;
  let reference = '';
  let orderId: string | null = t.salesOrderId ?? null;
  // sending a customer a payment request is a billing action: edit rights on the document, or the billing admin area
  const mode = hasAdmin(ctx.principal.permissions, 'billing') ? 'read' : 'update';
  if (t.invoiceId) {
    const { row } = await loadRow(ctx, 'invoice', t.invoiceId, mode);
    if (row.doc_type !== 'tax_invoice' || !['issued', 'partially_paid'].includes(String(row.status))) throw badRequest('Only issued, unpaid invoices can be paid online');
    due = Number(row.balance_due);
    purpose = `Invoice ${row.invoice_number}`;
    reference = String(row.invoice_number);
    accountId = (row.account_id as string) ?? null;
    orderId = (row.sales_order_id as string | null) ?? null;
  } else if (t.salesOrderId) {
    const { row } = await loadRow(ctx, 'sales_order', t.salesOrderId, mode);
    if (['draft', 'cancelled'].includes(String(row.status))) throw badRequest('Confirm the order before collecting payments');
    accountId = (row.account_id as string) ?? null;
    reference = String(row.order_number);
    if (t.milestoneId) {
      const m = await ctx.tx.one<{ name: string; amount: string; amount_paid: string }>(`select name, amount, amount_paid from order_milestones where tenant_id = $1 and order_id = $2 and id = $3`, [ctx.tenantId, t.salesOrderId, t.milestoneId]);
      if (!m) throw notFound('Milestone not found');
      due = r2(Number(m.amount) - Number(m.amount_paid));
      purpose = `${m.name} — order ${row.order_number}`;
    } else {
      due = Number(row.balance_due);
      purpose = `Order ${row.order_number}`;
    }
  } else throw badRequest('Choose an invoice or an order');
  // one open link per invoice / milestone, so the customer cannot pay the same amount twice
  const open = await ctx.tx.one<{ id: string }>(
    `select id from payment_links where tenant_id = $1 and status = 'created' and (expires_at is null or expires_at > now())
        and (($2::uuid is not null and invoice_id = $2::uuid) or ($2::uuid is null and sales_order_id = $3::uuid and milestone_id is not distinct from $4::uuid))
      limit 1`,
    [ctx.tenantId, t.invoiceId ?? null, orderId, t.milestoneId ?? null],
  );
  if (open) throw badRequest('A payment link for this is already open — cancel it first to send a new one');
  const amount = r2(t.amount ?? due);
  if (!(amount > 0)) throw badRequest('Nothing is due');
  if (amount > due + 0.01) throw badRequest(`That is more than what is due (${due.toFixed(2)})`);
  if (amount < 1) throw badRequest('Razorpay links need at least ₹1');

  const acc = accountId
    ? await ctx.tx.one<{ name: string; phone: string | null; email: string | null }>(
        `select a.name, coalesce(c.phone, a.phone) as phone, c.email from accounts a
           left join lateral (select phone, email from contacts where tenant_id = a.tenant_id and account_id = a.id and deleted_at is null order by created_at limit 1) c on true
          where a.tenant_id = $1 and a.id = $2`,
        [ctx.tenantId, accountId],
      )
    : null;
  const link = await ctx.tx.one<{ id: string }>(
    `insert into payment_links (tenant_id, integration_id, invoice_id, sales_order_id, milestone_id, account_id, amount, purpose, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, i.id, t.invoiceId ?? null, orderId, t.milestoneId ?? null, accountId, amount, purpose, t.expireInDays ? new Date(Date.now() + t.expireInDays * 86400_000).toISOString() : null],
  );
  const phone = (acc?.phone ?? '').replace(/[^\d+]/g, '');
  const body = {
    amount: Math.round(amount * 100),
    currency: 'INR',
    accept_partial: false,
    description: purpose.slice(0, 2048),
    reference_id: `${reference}-${link!.id.slice(-8)}`.slice(0, 40),
    customer: { name: acc?.name ?? undefined, email: acc?.email ?? undefined, contact: phone || undefined },
    notify: { sms: !!(t.notifySms && phone), email: !!(t.notifyEmail && acc?.email) },
    reminder_enable: true,
    notes: { synapse_link: link!.id, synapse_tenant: ctx.tenantId },
    callback_url: `${origin}/paid`,
    callback_method: 'get',
    ...(t.expireInDays ? { expire_by: Math.floor(Date.now() / 1000) + t.expireInDays * 86400 } : {}),
  };
  let r: { id: string; short_url: string; status: string };
  try {
    r = await providerFetch(`${RZP}/payment_links`, { method: 'POST', headers: { authorization: await razorpayAuth(env, i), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw badRequest(`Razorpay: ${(e as Error).message}`);
  }
  await ctx.tx.query(`update payment_links set external_id = $3, short_url = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, link!.id, r.id, r.short_url]);
  const related = t.invoiceId ? { o: 'invoice', id: t.invoiceId } : { o: 'sales_order', id: orderId! };
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1,'system',$2,$3,$4,$5,$6)`, [
    ctx.tenantId, `Payment link created for ₹${amount.toLocaleString('en-IN')}`, r.short_url, related.o, related.id, JSON.stringify({ paymentLinkId: link!.id }),
  ]);
  return { id: link!.id, url: r.short_url, amount, purpose, phone: phone || null };
}

export async function listPaymentLinks(ctx: RecordCtx, q: { invoiceId?: string; salesOrderId?: string }) {
  if (q.invoiceId) await loadRow(ctx, 'invoice', q.invoiceId, 'read');
  if (q.salesOrderId) await loadRow(ctx, 'sales_order', q.salesOrderId, 'read');
  return ctx.tx.query(
    `select l.id, l.invoice_id, l.sales_order_id, l.milestone_id, l.amount::float8 as amount, l.amount_paid::float8 as amount_paid, l.purpose, l.short_url, l.status, l.paid_at, l.expires_at, l.created_at, u.full_name as created_by_name
       from payment_links l left join users u on u.tenant_id = l.tenant_id and u.id = l.created_by
      where l.tenant_id = $1 and (($2::uuid is not null and l.invoice_id = $2::uuid) or ($3::uuid is not null and l.sales_order_id = $3::uuid))
      order by l.created_at desc limit 50`,
    [ctx.tenantId, q.invoiceId ?? null, q.salesOrderId ?? null],
  );
}

export async function cancelPaymentLink(env: Env, ctx: RecordCtx, id: string) {
  const l = await ctx.tx.one<{ id: string; integration_id: string; external_id: string | null; status: string; invoice_id: string | null; sales_order_id: string | null }>(
    `select id, integration_id, external_id, status, invoice_id, sales_order_id from payment_links where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, id],
  );
  if (!l) throw notFound();
  const mode = hasAdmin(ctx.principal.permissions, 'billing') ? 'read' : 'update';
  if (l.invoice_id) await loadRow(ctx, 'invoice', l.invoice_id, mode);
  else if (l.sales_order_id) await loadRow(ctx, 'sales_order', l.sales_order_id, mode);
  if (l.status !== 'created') throw badRequest('Only open links can be cancelled');
  const i = await ctx.tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [ctx.tenantId, l.integration_id]);
  if (i && l.external_id) {
    await providerFetch(`${RZP}/payment_links/${encodeURIComponent(l.external_id)}/cancel`, { method: 'POST', headers: { authorization: await razorpayAuth(env, i) } }).catch((e: Error) => {
      throw badRequest(`Razorpay: ${e.message}`);
    });
  }
  await ctx.tx.query(`update payment_links set status = 'cancelled' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

export async function verifyRazorpayWebhook(env: Env, i: Integration, raw: string, signature: string | null) {
  if (!signature) return false;
  const s = await readSecret<RazorpaySecret>(env, i);
  if (!s.webhookSecret) return false;
  return timingSafeEqual(signature, await hmacSha256Hex(s.webhookSecret, raw));
}

const MODE: Record<string, string> = { upi: 'upi', card: 'card', netbanking: 'bank_transfer', emi: 'card', wallet: 'other', bank_transfer: 'bank_transfer' };

/** Applies a verified Razorpay event. Returns record events for automations. */
export async function applyRazorpayEvent(ctx: RecordCtx, i: Integration, event: any): Promise<RecordEvent[]> {
  const kind = String(event?.event ?? '');
  const plink = event?.payload?.payment_link?.entity;
  if (!plink?.id) return [];
  const link = await ctx.tx.one<{ id: string; invoice_id: string | null; sales_order_id: string | null; milestone_id: string | null; account_id: string | null; status: string; amount: string; created_by: string | null }>(
    `select id, invoice_id, sales_order_id, milestone_id, account_id, status, amount, created_by from payment_links where tenant_id = $1 and external_id = $2 and integration_id = $3 for update`,
    [ctx.tenantId, plink.id, i.id],
  );
  if (!link) return [];
  await markOk(ctx.tx, i, { event: true });
  if (kind === 'payment_link.cancelled' || kind === 'payment_link.expired') {
    if (link.status === 'created') await ctx.tx.query(`update payment_links set status = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, link.id, kind.endsWith('cancelled') ? 'cancelled' : 'expired']);
    return [];
  }
  if (kind !== 'payment_link.paid' && kind !== 'payment_link.partially_paid') return [];
  const pay = event?.payload?.payment?.entity;
  if (!pay?.id) return [];
  // one receipt per Razorpay payment id, however often the webhook is delivered
  if (!(await claimRef(ctx.tx, ctx.tenantId, 'razorpay_payment', String(pay.id), 'payment_link', link.id))) return [];
  // the receipt is owned by whoever sent the link (else the workspace owner)
  const actor = link.created_by ?? (await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [ctx.tenantId]))?.id ?? null;
  ctx = { ...ctx, principal: systemPrincipal(actor, ctx.meta.objects.map((o) => o.key)) };
  const amount = r2(Number(pay.amount) / 100);
  const mode = MODE[String(pay.method)] ?? 'other';
  const reference = `Razorpay ${pay.id}${pay.vpa ? ` · ${pay.vpa}` : ''}`;
  const billing = enabledApps(ctx.meta).has('billing');
  let events: RecordEvent[] = [];
  let paymentId: string | null = null;
  if (link.invoice_id) {
    const inv = await ctx.tx.one<{ balance_due: string; status: string }>(`select balance_due, status from invoices where tenant_id = $1 and id = $2`, [ctx.tenantId, link.invoice_id]);
    const alloc = inv && ['issued', 'partially_paid'].includes(inv.status) ? Math.min(amount, Number(inv.balance_due)) : 0;
    const p = await recordPayment(ctx, { accountId: link.account_id, amount, mode, reference, notes: 'Paid online (Razorpay payment link)', allocations: alloc > 0 ? [{ invoiceId: link.invoice_id, amount: r2(alloc) }] : null });
    paymentId = p.id;
    events = p.events;
  } else if (link.sales_order_id && link.milestone_id) {
    if (billing) {
      const p = await milestoneReceipt(ctx, link.sales_order_id, link.milestone_id, amount, reference);
      paymentId = p.id;
      events = p.events;
      await ctx.tx.query(`update payments set mode = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, p.id, mode]);
    } else events = await recordMilestonePayment(ctx, link.sales_order_id, link.milestone_id, amount, reference);
  } else if (link.sales_order_id) {
    if (billing) {
      const p = await recordPayment(ctx, { salesOrderId: link.sales_order_id, amount, mode, reference, notes: 'Paid online (Razorpay payment link)', allocations: 'auto' });
      paymentId = p.id;
      events = p.events;
    } else {
      await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'sales_order',$3)`, [ctx.tenantId, `Paid online: ₹${amount.toLocaleString('en-IN')} (${reference}) — record it against a milestone`, link.sales_order_id]);
    }
  }
  // with books on, money collected online sits in the gateway clearing account until Razorpay settles it
  // (net of its fee and GST) into the bank; the accounts desk books the settlement against it
  if (paymentId && enabledApps(ctx.meta).has('books')) {
    const cfg = await ctx.tx.one<{ enabled: boolean }>(`select enabled from books_config where tenant_id = $1`, [ctx.tenantId]).catch(() => null);
    if (cfg?.enabled) {
      const clearing = await sys(ctx.tx, ctx.tenantId, 'gateway_clearing');
      await ctx.tx.query(`update payments set deposit_account_id = $3 where tenant_id = $1 and id = $2 and deposit_account_id is null`, [ctx.tenantId, paymentId, clearing]);
      await repost(ctx.tx, ctx.tenantId, 'payment', paymentId);
    }
  }
  await ctx.tx.query(`update payment_links set amount_paid = amount_paid + $3, payment_id = coalesce($4, payment_id), paid_at = now(),
      status = case when amount_paid + $3 >= amount - 0.01 then 'paid' else 'partially_paid' end where tenant_id = $1 and id = $2`, [ctx.tenantId, link.id, amount, paymentId]);
  // whoever created the link hears about it
  await ctx.tx.query(
    `insert into notifications (tenant_id, user_id, kind, title, body, link)
     select tenant_id, created_by, 'payment', $3, $4, $5 from payment_links where tenant_id = $1 and id = $2 and created_by is not null`,
    [ctx.tenantId, link.id, `₹${amount.toLocaleString('en-IN')} received online`, reference, link.invoice_id ? `/o/invoice/${link.invoice_id}` : `/o/sales_order/${link.sales_order_id}`],
  );
  return events;
}

export async function routeIntegration(tx: Tx, tenantId: string, id: string, provider: Integration['provider']) {
  const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = $3 and status <> 'disabled'`, [tenantId, id, provider]);
  if (!i) throw notFound();
  return i;
}

/** UPI deep link for a printed QR (any UPI app can pay it; reconcile from the bank statement). */
export function upiLink(vpa: string, payee: string, amount: number, note: string) {
  const q = new URLSearchParams({ pa: vpa, pn: payee.slice(0, 50), am: amount.toFixed(2), cu: 'INR', tn: note.slice(0, 50) });
  return `upi://pay?${q.toString()}`;
}
