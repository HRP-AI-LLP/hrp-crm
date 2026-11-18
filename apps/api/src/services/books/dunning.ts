/**
 * Payment reminders to customers. Off until the workspace turns them on (Books → Settings): then each
 * unpaid invoice gets a polite email a few days before it is due, on the due date, and at the chosen
 * days after, to its contact (or the customer's first contact with an email). Each stage goes once;
 * a reminder can also be sent by hand from the invoice.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { sendPlatformMail } from '../mailer';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { assertBooksAdmin } from './ledger';

export const reminderSettingsSchema = z.object({
  enabled: z.boolean(),
  beforeDays: z.number().int().min(0).max(30).default(3),
  onDue: z.boolean().default(true),
  afterDays: z.array(z.number().int().min(1).max(365)).max(8).default([7, 15, 30]),
  skipGovernment: z.boolean().default(true),
  cc: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email())]).default(''),
  note: z.string().trim().max(600).default(''),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;
const DEFAULTS: ReminderSettings = { enabled: false, beforeDays: 3, onDue: true, afterDays: [7, 15, 30], skipGovernment: true, cc: '', note: '' };

export async function reminderSettings(ctx: RecordCtx): Promise<ReminderSettings> {
  const t = await ctx.tx.one<{ r: any }>(`select settings -> 'reminders' as r from tenants where id = $1`, [ctx.tenantId]);
  return { ...DEFAULTS, ...(t?.r ?? {}) };
}

export async function saveReminderSettings(ctx: RecordCtx, input: ReminderSettings) {
  await assertBooksAdmin(ctx);
  await ctx.tx.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{reminders}', $2::jsonb) where id = $1`, [ctx.tenantId, JSON.stringify(input)]);
  return input;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (v: number, cur = 'INR') => (cur === 'INR' ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${cur} ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
const dmy = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

interface Due {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  currency: string;
  grand_total: number;
  balance_due: number;
  party: string;
  email: string | null;
  contact_name: string | null;
  government: boolean;
  link: string | null;
  days: number;
}

const DUE_SQL = `select i.id, i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') as invoice_date, to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.currency,
        i.grand_total::float8 as grand_total, i.balance_due::float8 as balance_due, coalesce(a.name, i.buyer_name, '') as party,
        coalesce(ic.email, fc.email) as email, coalesce(nullif(trim(concat_ws(' ', ic.first_name, ic.last_name)), ''), nullif(trim(concat_ws(' ', fc.first_name, fc.last_name)), '')) as contact_name,
        (a.account_type = 'government') as government,
        (select short_url from payment_links pl where pl.tenant_id = i.tenant_id and pl.invoice_id = i.id and pl.short_url is not null order by pl.created_at desc limit 1) as link,
        (current_date - i.due_date)::int as days
   from invoices i
   left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
   left join contacts ic on ic.tenant_id = i.tenant_id and ic.id = i.contact_id and ic.deleted_at is null
   left join lateral (select email, first_name, last_name from contacts c where c.tenant_id = i.tenant_id and c.account_id = i.account_id and c.deleted_at is null and c.email is not null order by c.created_at limit 1) fc on true
  where i.tenant_id = $1 and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid') and i.deleted_at is null and i.balance_due > 0 and i.due_date is not null`;

/** Which reminder stage an invoice is in today, if any. */
export function stageFor(days: number, s: ReminderSettings): string | null {
  if (s.beforeDays > 0 && days === -s.beforeDays) return `before_${s.beforeDays}`;
  if (s.onDue && days === 0) return 'due';
  const after = [...s.afterDays].sort((a, b) => b - a).find((d) => days >= d && days < d + 3);
  return after ? `after_${after}` : null;
}

function render(company: { name: string; email: string | null; phone: string | null }, d: Due, s: ReminderSettings) {
  const late = d.days > 0;
  const when = d.days < 0 ? `is due on ${dmy(d.due_date)}` : d.days === 0 ? 'is due today' : `was due on ${dmy(d.due_date)} (${d.days} day${d.days === 1 ? '' : 's'} ago)`;
  const subject = late ? `Payment overdue: invoice ${d.invoice_number} from ${company.name}` : `Payment reminder: invoice ${d.invoice_number} from ${company.name}`;
  const hello = d.contact_name ? `Dear ${d.contact_name},` : `Dear ${d.party || 'Sir / Madam'},`;
  const lead = late
    ? `This is a gentle reminder that the payment for invoice <b>${esc(d.invoice_number)}</b> ${when}. We would be grateful if you could arrange it at the earliest.`
    : `This is a friendly reminder that invoice <b>${esc(d.invoice_number)}</b> ${when}.`;
  const rows: [string, string][] = [
    ['Invoice', d.invoice_number],
    ['Invoice date', dmy(d.invoice_date)],
    ['Due date', dmy(d.due_date)],
    ['Invoice total', money(d.grand_total, d.currency)],
    ['Amount due', money(d.balance_due, d.currency)],
  ];
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="background:#062f59;border-radius:12px 12px 0 0;padding:16px 24px;color:#fff;font-weight:700">${esc(company.name)}</td></tr>
<tr><td style="padding:22px 24px;line-height:1.55;font-size:14.5px">
<p style="margin:0 0 12px">${esc(hello)}</p>
<p style="margin:0 0 16px">${lead}</p>
<table role="presentation" width="100%" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:0 0 18px">${rows
    .map(([a, b], i) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eef2f6;color:#64748b">${esc(a)}</td><td style="padding:7px 0;border-bottom:1px solid #eef2f6;text-align:right;font-weight:${i === 4 ? 700 : 500};color:${i === 4 && late ? '#b91c1c' : '#0f172a'}">${esc(b)}</td></tr>`)
    .join('')}</table>
${d.link ? `<p style="margin:0 0 18px"><a href="${esc(d.link)}" style="display:inline-block;background:#075492;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Pay ${esc(money(d.balance_due, d.currency))} online</a></p>` : ''}
${s.note ? `<p style="margin:0 0 14px;white-space:pre-line">${esc(s.note)}</p>` : ''}
<p style="margin:0 0 4px">If you have already paid, thank you, and please ignore this note. For any question, simply reply to this email${company.phone ? ` or call ${esc(company.phone)}` : ''}.</p>
<p style="margin:14px 0 0">Regards,<br>${esc(company.name)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${hello}\n\nInvoice ${d.invoice_number} ${when}. Amount due: ${money(d.balance_due, d.currency)}.${d.link ? `\nPay online: ${d.link}` : ''}\n\n${s.note ? `${s.note}\n\n` : ''}If you have already paid, please ignore this note.\n\nRegards,\n${company.name}`;
  return { subject, html, text };
}

async function companyOf(ctx: RecordCtx) {
  const t = await ctx.tx.one<{ name: string; c: any }>(`select name, settings -> 'company' as c from tenants where id = $1`, [ctx.tenantId]);
  return { name: String(t?.c?.tradeName || t?.c?.legalName || t?.name || 'Our company'), email: (t?.c?.email as string) || null, phone: (t?.c?.phone as string) || null };
}

async function send(ctx: RecordCtx, env: Env, d: Due, stage: string, s: ReminderSettings, by: string | null) {
  if (!d.email) return { ok: false, error: 'No email address for this customer: add one to the invoice contact or the customer' };
  const company = await companyOf(ctx);
  const m = render(company, d, s);
  const ok = await sendPlatformMail(env, { to: d.email, cc: s.cc ? [s.cc] : undefined, replyTo: s.cc || company.email, fromName: company.name, ...m });
  if (!ok) return { ok: false, error: 'The email could not be sent (is the mail key set up?)' };
  await ctx.tx.query(`insert into invoice_reminders (tenant_id, invoice_id, stage, sent_to, sent_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, invoice_id, stage) do nothing`, [ctx.tenantId, d.id, stage, d.email, by]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id) values ($1,'system',$2,$3,'invoice',$4)`, [
    ctx.tenantId, `Payment reminder sent to ${d.email}`, `${m.subject} · amount due ${money(d.balance_due, d.currency)}`, d.id,
  ]);
  return { ok: true, to: d.email };
}

/** "Send a reminder now" on an invoice. */
export async function remindNow(ctx: RecordCtx, env: Env, invoiceId: string) {
  await assertBooksAdmin(ctx);
  const d = await ctx.tx.one<Due>(`${DUE_SQL} and i.id = $2`, [ctx.tenantId, invoiceId]);
  if (!d) throw notFound('This invoice has nothing due');
  const r = await send(ctx, env, d, `manual_${new Date().toISOString().slice(0, 10)}`, await reminderSettings(ctx), ctx.principal.user.id);
  if (!r.ok) throw badRequest(r.error!);
  return r;
}

export async function remindersOf(ctx: RecordCtx, invoiceId: string) {
  return ctx.tx.query(`select stage, sent_to, sent_at from invoice_reminders where tenant_id = $1 and invoice_id = $2 order by sent_at desc`, [ctx.tenantId, invoiceId]);
}

/** Daily: the reminders due today, for workspaces that turned them on. */
export async function reminderDailySweep(env: Env, db: Db, tenantId: string) {
  return db.tx({ tenantId }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    if (!ctx) return { sent: 0 };
    const s = await reminderSettings(ctx);
    if (!s.enabled) return { sent: 0 };
    const list = await tx.query<Due>(DUE_SQL, [tenantId]);
    let sent = 0;
    for (const d of list) {
      if (s.skipGovernment && d.government) continue;
      const stage = stageFor(d.days, s);
      if (!stage) continue;
      if (await tx.one(`select 1 from invoice_reminders where tenant_id = $1 and invoice_id = $2 and stage = $3`, [tenantId, d.id, stage])) continue;
      const r = await send(ctx, env, d, stage, s, null).catch(() => ({ ok: false }));
      if (r.ok) sent++;
    }
    return { sent };
  });
}
