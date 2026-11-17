/**
 * Sales productivity API: quotes (+ price books), email templates and sending, calendar events,
 * notifications, forecasting/quotas, and the report + dashboard builder.
 */
import { fieldAccess, hasAdmin, objectPerm, type ObjectMeta, valueType } from '@synapse/shared';
import { Hono } from 'hono';
import { mailboxOf } from '../services/integrations';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { forecast, forecastDeals, projection, type Period } from '../services/forecast';
import { enqueue, eventJobs } from '../services/jobs';
import { getQuote, lineSchema, markSent, quoteFromDeal, saveLines, syncDealAmount } from '../services/quotes';
import { aggregateRecords, getObject, listRecords, loadRow, type RecordCtx } from '../services/records';
import { noteReminder } from '../services/reminders';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filterSchema = z.object({ field: z.string().min(1).max(60), op: z.string().min(1).max(20), value: z.unknown().optional() });

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

// ---------------------------------------------------------------------------------- merge fields
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
function display(obj: ObjectMeta, key: string, raw: unknown, meta: AppEnv['Variables']['meta']): string {
  if (raw === null || raw === undefined || raw === '') return '';
  // pg returns date/timestamp columns as Date objects
  const v = raw instanceof Date ? (obj.fields.find((x) => x.key === key)?.type === 'date' ? new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate())).toISOString().slice(0, 10) : raw.toISOString()) : raw;
  const f = obj.fields.find((x) => x.key === key);
  if (!f) return String(v);
  if (f.key === 'stage_id') for (const p of meta.pipelines) for (const s of p.stages) if (s.id === v) return s.label;
  switch (valueType(f)) {
    case 'currency':
      return inr.format(Number(v));
    case 'date':
      return new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    case 'datetime':
      return new Date(String(v)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    case 'boolean':
      return v ? 'Yes' : 'No';
    case 'picklist':
      return f.options?.choices?.find((c) => c.value === v)?.label ?? String(v);
    case 'multipicklist':
      return (v as string[]).map((x) => f.options?.choices?.find((c) => c.value === x)?.label ?? x).join(', ');
    default:
      return String(v);
  }
}

export async function renderTemplate(c: { var: AppEnv['Variables']; req: { url: string } }, tx: RecordCtx['tx'], tpl: { subject: string; body: string }, objectKey?: string | null, recordId?: string | null) {
  const vars: Record<string, string> = {
    'me.full_name': c.var.principal.user.fullName,
    'me.email': c.var.principal.user.email,
    'company.name': c.var.tenant.name,
    today: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
  };
  if (objectKey && recordId) {
    const ctx = rctx(c, tx);
    const { obj, row } = await loadRow(ctx, objectKey, recordId, 'read');
    const custom = (row.custom ?? {}) as Record<string, unknown>;
    for (const f of obj.fields) {
      if (fieldAccess(c.var.principal.permissions, objectKey, f.key) === 'hidden') continue;
      vars[f.key] = display(obj, f.key, f.standard ? row[f.key] : custom[f.key], c.var.meta);
    }
    vars.title = String(row[obj.key === 'lead' || obj.key === 'contact' ? 'full_name' : 'name'] ?? '');
    if (objectKey === 'quote' && row.share_token) vars.quote_link = `${new URL(c.req.url).origin}/q/${row.share_token}`;
    // first name for greetings on deals/quotes: take it from the linked contact
    if (!vars.first_name && row.contact_id) {
      const ct = await tx.one<{ first_name: string | null; email: string | null }>(`select first_name, email from contacts where tenant_id = $1 and id = $2`, [c.var.tenant.id, row.contact_id]);
      vars.first_name = ct?.first_name ?? '';
      vars['contact.email'] = ct?.email ?? '';
    }
  }
  const fill = (s: string) => s.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_, k: string) => vars[k] ?? '');
  return { subject: fill(tpl.subject), body: fill(tpl.body), to: vars.email || vars['contact.email'] || '' };
}

// ---------------------------------------------------------------------------------- report schema
export const reportDefinitionSchema = z.object({
  type: z.enum(['table', 'summary', 'chart']),
  filters: z.array(filterSchema).max(20).default([]),
  columns: z.array(z.string().max(60)).max(20).default([]),
  sort: z.object({ field: z.string().max(60), dir: z.enum(['asc', 'desc']) }).nullish(),
  groupBy: z.string().max(60).nullish(),
  groupBy2: z.string().max(60).nullish(),
  dateBucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullish(),
  measure: z.object({ agg: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().max(60).nullish() }).default({ agg: 'count' }),
  chart: z.enum(['bar', 'hbar', 'line', 'pie', 'funnel', 'number']).nullish(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export async function runReport(ctx: RecordCtx, objectKey: string, d: ReportDefinition) {
  getObject(ctx.meta, objectKey);
  if (d.type === 'table') {
    const r = await listRecords(ctx, objectKey, { filters: d.filters, sort: d.sort?.field, dir: d.sort?.dir, limit: d.limit, count: true });
    return { kind: 'table' as const, items: r.items, total: r.total };
  }
  const agg = await aggregateRecords(ctx, objectKey, { filters: d.filters, groupBy: d.groupBy, groupBy2: d.type === 'summary' || d.chart === 'bar' || d.chart === 'line' ? d.groupBy2 : null, dateBucket: d.dateBucket, measure: { agg: d.measure.agg, field: d.measure.field } });
  return { kind: 'aggregate' as const, ...agg };
}

const canSeeShared = (c: { var: AppEnv['Variables'] }) => hasAdmin(c.var.principal.permissions, 'reports');

/** Mail goes out through the sender's own Gmail / Outlook when connected, else the workspace channel. */
async function pickSender(tx: RecordCtx['tx'], tenantId: string, userId: string) {
  const mb = await mailboxOf(tx, tenantId, userId);
  if (mb) return { mailboxId: mb.id, channelAccountId: null, from: mb.account_ref };
  const acc = await tx.one<{ id: string }>(`select id from channel_accounts where tenant_id = $1 and channel = 'email' and status = 'active' order by created_at limit 1`, [tenantId]);
  return acc ? { mailboxId: null, channelAccountId: acc.id, from: null } : null;
}

/** Mirrors an event into the owner's connected calendar (background). */
async function mirrorEvent(c: Parameters<typeof safeCtx>[0] & { env: AppEnv['Bindings']; var: AppEnv['Variables'] }, row: Record<string, any> | null | undefined) {
  // only your own events reach your calendar: nobody can drop entries into a colleague's real calendar
  if (!row?.owner_id || row.owner_id !== c.var.principal.user.id) return;
  const has = await c.var.db.tx(scope(c as never, true), (tx) =>
    tx.one(`select 1 from integrations where tenant_id = $1 and user_id = $2 and provider in ('google','microsoft') and status = 'active' and coalesce((config ->> 'calendar')::boolean, true)`, [c.var.tenant.id, row.owner_id]),
  );
  if (has) await enqueue(c.env, safeCtx(c), [{ type: 'calendar.push', tenantId: c.var.tenant.id, eventId: row.id, ownerId: row.owner_id }]);
}

export const salesRoutes = new Hono<AppEnv>()
  // ============================================================================ quotes
  .get('/quotes/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getQuote(rctx(c, tx), c.req.param('id')))))
  .put('/quotes/:id/lines', async (c) => {
    const b = z.object({ lines: z.array(lineSchema).max(200), priceBookId: uuid.nullish(), billTo: z.record(z.string(), z.string().max(500)).nullish(), taxInclusive: z.boolean().optional() }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => saveLines(rctx(c, tx), c.req.param('id'), b.lines, { priceBookId: b.priceBookId === undefined ? undefined : b.priceBookId, billTo: b.billTo === undefined ? undefined : b.billTo, taxInclusive: b.taxInclusive }));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getQuote(rctx(c, tx), c.req.param('id'))));
  })
  .post('/quotes/from-deal/:dealId', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => quoteFromDeal(rctx(c, tx), c.req.param('dealId')));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json(r.record, 201);
  })
  .post('/quotes/:id/send', async (c) => {
    const b = z.object({ to: z.string().email().nullish(), subject: z.string().max(300).nullish(), body: z.string().max(20_000).nullish() }).parse(await c.req.json().catch(() => ({})));
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const s = await markSent(ctx, c.req.param('id'));
      const link = `${new URL(c.req.url).origin}/q/${s.token}`;
      let messageId: string | null = null;
      if (b.to && b.subject && b.body) {
        const sender = await pickSender(tx, c.var.tenant.id, c.var.principal.user.id);
        if (sender) {
          const body = b.body.includes(link) ? b.body : `${b.body}\n\n${link}`;
          const m = await tx.one<{ id: string }>(
            `insert into messages (tenant_id, channel_account_id, mailbox_id, channel, direction, from_addr, to_addr, subject, body, related_object, related_id) values ($1,$2,$3,'email','out',$4,$5,$6,$7,'quote',$8) returning id`,
            [c.var.tenant.id, sender.channelAccountId, sender.mailboxId, sender.from, b.to, b.subject, body, c.req.param('id')],
          );
          messageId = m!.id;
          await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata) values ($1,'email',$2,$3,'out','quote',$4,$5)`, [
            c.var.tenant.id, b.subject, body, c.req.param('id'), JSON.stringify({ to: b.to, messageId: m!.id, from: sender.from }),
          ]);
        }
      }
      return { link, messageId, events: s.events };
    });
    const jobs = eventJobs(c.var.tenant.id, c.var.principal.user.id, out.events);
    if (out.messageId) jobs.push({ type: 'message.send', tenantId: c.var.tenant.id, messageId: out.messageId });
    await enqueue(c.env, safeCtx(c), jobs);
    return c.json({ link: out.link, emailed: !!out.messageId });
  })
  .post('/quotes/:id/sync-deal', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => syncDealAmount(rctx(c, tx), c.req.param('id')));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json(r.record);
  })

  // ============================================================================ price books
  .get('/price-books', async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select pb.*, (select count(*)::int from price_book_entries e where e.tenant_id = pb.tenant_id and e.price_book_id = pb.id) as products from price_books pb where pb.tenant_id = $1 order by pb.is_default desc, pb.name`, [c.var.tenant.id])) }),
  )
  .get('/price-books/:id/entries', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select p.id as product_id, p.name, p.sku, p.unit, p.tax_rate::float8 as tax_rate, p.hsn_sac, p.list_price::float8 as list_price, p.is_active, e.unit_price::float8 as unit_price
             from products p left join price_book_entries e on e.tenant_id = p.tenant_id and e.product_id = p.id and e.price_book_id = $2
            where p.tenant_id = $1 and p.deleted_at is null order by p.name limit 2000`,
          [c.var.tenant.id, uuid.parse(c.req.param('id'))],
        ),
      ),
    }),
  )
  .post('/price-books', async (c) => {
    if (objectPerm(c.var.principal.permissions, 'product').update !== 'all') throw forbidden();
    const b = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).nullish(), currency: z.string().length(3).default('INR'), isDefault: z.boolean().default(false), copyFrom: uuid.nullish() }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.isDefault) await tx.query(`update price_books set is_default = false where tenant_id = $1`, [c.var.tenant.id]);
      const pb = await tx.one<{ id: string }>(`insert into price_books (tenant_id, name, description, currency, is_default) values ($1,$2,$3,$4,$5) returning *`, [c.var.tenant.id, b.name, b.description ?? null, b.currency.toUpperCase(), b.isDefault]);
      if (b.copyFrom) await tx.query(`insert into price_book_entries (tenant_id, price_book_id, product_id, unit_price) select tenant_id, $2, product_id, unit_price from price_book_entries where tenant_id = $1 and price_book_id = $3`, [c.var.tenant.id, pb!.id, b.copyFrom]);
      return pb;
    });
    return c.json(row, 201);
  })
  .patch('/price-books/:id', async (c) => {
    if (objectPerm(c.var.principal.permissions, 'product').update !== 'all') throw forbidden();
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).nullish(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.isDefault) await tx.query(`update price_books set is_default = false where tenant_id = $1 and id <> $2`, [c.var.tenant.id, c.req.param('id')]);
      return tx.one(`update price_books set name = coalesce($3, name), description = coalesce($4, description), is_default = coalesce($5, is_default), is_active = coalesce($6, is_active) where tenant_id = $1 and id = $2 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), b.name ?? null, b.description ?? null, b.isDefault ?? null, b.isActive ?? null,
      ]);
    });
    if (!row) throw notFound();
    return c.json(row);
  })
  .put('/price-books/:id/entries', async (c) => {
    if (objectPerm(c.var.principal.permissions, 'product').update !== 'all') throw forbidden();
    const b = z.object({ entries: z.array(z.object({ productId: uuid, unitPrice: z.number().min(0).max(1e12).nullable() })).max(2000) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      for (const e of b.entries) {
        if (e.unitPrice === null) await tx.query(`delete from price_book_entries where tenant_id = $1 and price_book_id = $2 and product_id = $3`, [c.var.tenant.id, c.req.param('id'), e.productId]);
        else
          await tx.query(
            `insert into price_book_entries (tenant_id, price_book_id, product_id, unit_price) values ($1,$2,$3,$4)
             on conflict (tenant_id, price_book_id, product_id) do update set unit_price = excluded.unit_price`,
            [c.var.tenant.id, uuid.parse(c.req.param('id')), e.productId, e.unitPrice],
          );
      }
    });
    return c.json({ ok: true, updated: b.entries.length });
  })

  // ============================================================================ email templates + sending
  .get('/email-templates', async (c) => {
    const object = c.req.query('object');
    return c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select t.*, u.full_name as owner_name from email_templates t left join users u on u.tenant_id = t.tenant_id and u.id = t.owner_id
            where t.tenant_id = $1 and (t.is_shared or t.owner_id = $2) and ($3::text is null or t.object_key is null or t.object_key = $3)
            order by t.category nulls last, t.name`,
          [c.var.tenant.id, c.var.principal.user.id, object ?? null],
        ),
      ),
    });
  })
  .post('/email-templates', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), objectKey: z.string().max(60).nullish(), category: z.string().max(60).nullish(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20_000), isShared: z.boolean().default(false) }).parse(await c.req.json());
    if (b.isShared && !hasAdmin(c.var.principal.permissions, 'channels') && !hasAdmin(c.var.principal.permissions, 'metadata')) throw forbidden('Only admins can share templates with everyone');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into email_templates (tenant_id, name, object_key, category, subject, body, is_shared, owner_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [
        c.var.tenant.id, b.name, b.objectKey ?? null, b.category ?? null, b.subject, b.body, b.isShared, c.var.principal.user.id,
      ]),
    );
    return c.json(row, 201);
  })
  .put('/email-templates/:id', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), objectKey: z.string().max(60).nullish(), category: z.string().max(60).nullish(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20_000), isShared: z.boolean().default(false) }).parse(await c.req.json());
    const admin = hasAdmin(c.var.principal.permissions, 'channels') || hasAdmin(c.var.principal.permissions, 'metadata');
    if (b.isShared && !admin) throw forbidden('Only admins can share templates with everyone');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update email_templates set name=$4, object_key=$5, category=$6, subject=$7, body=$8, is_shared=$9 where tenant_id=$1 and id=$2 and (owner_id = $3 or $10::boolean) returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, b.name, b.objectKey ?? null, b.category ?? null, b.subject, b.body, b.isShared, admin,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/email-templates/:id', async (c) => {
    const admin = hasAdmin(c.var.principal.permissions, 'channels') || hasAdmin(c.var.principal.permissions, 'metadata');
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from email_templates where tenant_id=$1 and id=$2 and (owner_id = $3 or $4::boolean) returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, admin]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })
  .post('/email-templates/render', async (c) => {
    const b = z.object({ templateId: uuid.nullish(), subject: z.string().max(300).nullish(), body: z.string().max(20_000).nullish(), object: z.string().max(60).nullish(), recordId: uuid.nullish() }).parse(await c.req.json());
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      let tpl = { subject: b.subject ?? '', body: b.body ?? '' };
      if (b.templateId) {
        const t = await tx.one<{ subject: string; body: string }>(`select subject, body from email_templates where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [c.var.tenant.id, b.templateId, c.var.principal.user.id]);
        if (!t) throw notFound();
        tpl = t;
      }
      return renderTemplate(c, tx, tpl, b.object, b.recordId);
    });
    return c.json(out);
  })
  .post('/records/:object/:id/send-email', async (c) => {
    const { object, id } = c.req.param();
    const b = z.object({ to: z.string().trim().email(), cc: z.string().max(500).nullish(), subject: z.string().trim().min(1).max(300), body: z.string().min(1).max(20_000), templateId: uuid.nullish() }).parse(await c.req.json());
    const out = await c.var.db.tx(scope(c), async (tx) => {
      await loadRow(rctx(c, tx), object, id, 'read');
      const sender = await pickSender(tx, c.var.tenant.id, c.var.principal.user.id);
      if (!sender) throw badRequest('Connect your Gmail or Outlook in My account (or ask an admin to add an email channel) to send from Synapse');
      // a reply continues the conversation thread in the person's mailbox
      const thread = sender.mailboxId
        ? await tx.one<{ t: string | null }>(
            `select metadata ->> 'threadId' as t from activities where tenant_id = $1 and related_object = $2 and related_id = $3 and kind = 'email' and metadata ->> 'mailbox' = $4 and lower(metadata ->> 'from') = lower($5) order by occurred_at desc limit 1`,
            [c.var.tenant.id, object, id, sender.mailboxId, b.to],
          )
        : null;
      const m = await tx.one<{ id: string }>(
        `insert into messages (tenant_id, channel_account_id, mailbox_id, channel, direction, from_addr, to_addr, subject, body, related_object, related_id, thread_ref) values ($1,$2,$3,'email','out',$4,$5,$6,$7,$8,$9,$10) returning id`,
        [c.var.tenant.id, sender.channelAccountId, sender.mailboxId, sender.from, b.cc ? `${b.to}, ${b.cc}` : b.to, b.subject, b.body, object, id, thread?.t ?? null],
      );
      await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata) values ($1,'email',$2,$3,'out',$4,$5,$6)`, [
        c.var.tenant.id, b.subject, b.body, object, id, JSON.stringify({ to: b.to, cc: b.cc ?? null, messageId: m!.id, templateId: b.templateId ?? null, from: sender.from }),
      ]);
      if (b.templateId) await tx.query(`update email_templates set use_count = use_count + 1 where tenant_id = $1 and id = $2`, [c.var.tenant.id, b.templateId]);
      return m!.id;
    });
    await enqueue(c.env, safeCtx(c), [{ type: 'message.send', tenantId: c.var.tenant.id, messageId: out }]);
    return c.json({ ok: true, messageId: out }, 201);
  })

  // ============================================================================ calendar
  .get('/events', async (c) => {
    const q = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), user: uuid.optional(), relatedObject: z.string().max(60).optional(), relatedId: uuid.optional() }).parse(c.req.query());
    const me = c.var.principal.user.id;
    const seeAll = objectPerm(c.var.principal.permissions, 'deal').read === 'all';
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(
        `select e.*, u.full_name as owner_name from events e left join users u on u.tenant_id = e.tenant_id and u.id = e.owner_id
          where e.tenant_id = $1 and e.starts_at < $3::timestamptz and e.ends_at >= $2::timestamptz
            and ($4::boolean or e.owner_id = $5 or e.attendees @> jsonb_build_array(jsonb_build_object('userId', $5::text)))
            and ($6::uuid is null or e.owner_id = $6 or e.attendees @> jsonb_build_array(jsonb_build_object('userId', $6::text)))
            and ($7::text is null or (e.related_object = $7 and e.related_id = $8::uuid))
          order by e.starts_at limit 1000`,
        [c.var.tenant.id, q.from, q.to, seeAll, me, q.user ?? null, q.relatedObject ?? null, q.relatedId ?? null],
      ),
    );
    return c.json({ items: rows });
  })
  .post('/events', async (c) => {
    const b = eventSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.relatedObject && b.relatedId) await loadRow(rctx(c, tx), b.relatedObject, b.relatedId, 'read');
      return tx.one<{ remind_at: string | null }>(
        `insert into events (tenant_id, title, kind, starts_at, ends_at, all_day, location, description, related_object, related_id, owner_id, attendees, reminder_minutes, remind_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::uuid,$12::uuid),$13,$14, case when $14::int is null then null else $4::timestamptz - make_interval(mins => $14::int) end) returning *`,
        [c.var.tenant.id, b.title, b.kind, b.startsAt, b.endsAt, b.allDay, b.location ?? null, b.description ?? null, b.relatedObject ?? null, b.relatedId ?? null, b.ownerId ?? null, c.var.principal.user.id, JSON.stringify(b.attendees), b.reminderMinutes ?? null],
      );
    });
    await noteReminder(c.env, row?.remind_at);
    await mirrorEvent(c, row as Record<string, any> | null);
    return c.json(row, 201);
  })
  .patch('/events/:id', async (c) => {
    const b = eventBase.partial().extend({ status: z.enum(['scheduled', 'done', 'cancelled']).optional(), outcome: z.string().max(5000).nullish() }).parse(await c.req.json());
    const admin = objectPerm(c.var.principal.permissions, 'deal').update === 'all';
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const cur = await tx.one<Record<string, any>>(`select * from events where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]);
      if (!cur) throw notFound();
      if (cur.owner_id !== c.var.principal.user.id && !admin) throw forbidden('Only the organiser can change this event');
      const next = {
        title: b.title ?? cur.title,
        kind: b.kind ?? cur.kind,
        starts_at: b.startsAt ?? cur.starts_at,
        ends_at: b.endsAt ?? cur.ends_at,
        all_day: b.allDay ?? cur.all_day,
        location: b.location !== undefined ? b.location : cur.location,
        description: b.description !== undefined ? b.description : cur.description,
        attendees: b.attendees ?? cur.attendees,
        reminder_minutes: b.reminderMinutes !== undefined ? b.reminderMinutes : cur.reminder_minutes,
        status: b.status ?? cur.status,
        outcome: b.outcome !== undefined ? b.outcome : cur.outcome,
        owner_id: b.ownerId ?? cur.owner_id,
      };
      if (new Date(next.ends_at) < new Date(next.starts_at)) throw badRequest('The event must end after it starts');
      const moved = b.startsAt !== undefined || b.reminderMinutes !== undefined;
      const r = await tx.one<Record<string, any>>(
        `update events set title=$3, kind=$4, starts_at=$5, ends_at=$6, all_day=$7, location=$8, description=$9, attendees=$10, reminder_minutes=$11, status=$12, outcome=$13, owner_id=$14,
                remind_at = case when $11::int is null then null else $5::timestamptz - make_interval(mins => $11::int) end,
                reminded_at = case when $15::boolean then null else reminded_at end
          where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, cur.id, next.title, next.kind, next.starts_at, next.ends_at, next.all_day, next.location, next.description, JSON.stringify(next.attendees), next.reminder_minutes, next.status, next.outcome, next.owner_id, moved],
      );
      // handed to someone else: the copy in the previous owner's calendar goes away
      if (cur.owner_id !== next.owner_id && cur.calendar_ref) {
        await tx.query(`update events set calendar_ref = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, cur.id]);
        r!.moved_from_owner = cur.owner_id;
        r!.old_calendar_ref = cur.calendar_ref;
        r!.calendar_ref = null;
      }
      // a completed meeting with an outcome lands on the related record's timeline
      if (b.status === 'done' && cur.status !== 'done' && cur.related_object && cur.related_id) {
        await tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, occurred_at) values ($1,'meeting',$2,$3,$4,$5,$6)`, [
          c.var.tenant.id, next.title, next.outcome ?? null, cur.related_object, cur.related_id, next.starts_at,
        ]);
      }
      return r;
    });
    await noteReminder(c.env, row?.remind_at);
    if (row?.moved_from_owner && row.old_calendar_ref) {
      await enqueue(c.env, safeCtx(c), [{ type: 'calendar.push', tenantId: c.var.tenant.id, eventId: row.id, ownerId: row.moved_from_owner, removeRef: row.old_calendar_ref }]);
    }
    if (row) {
      delete row.moved_from_owner;
      delete row.old_calendar_ref;
    }
    await mirrorEvent(c, row);
    return c.json(row);
  })
  .delete('/events/:id', async (c) => {
    const admin = objectPerm(c.var.principal.permissions, 'deal').update === 'all';
    const rows = await c.var.db.tx(scope(c), (tx) =>
      tx.query<{ id: string; owner_id: string | null; calendar_ref: { integrationId: string; id: string } | null }>(
        `delete from events where tenant_id = $1 and id = $2 and (owner_id = $3 or $4::boolean) returning id, owner_id, calendar_ref`,
        [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, admin],
      ),
    );
    if (!rows.length) throw notFound();
    if (rows[0]!.calendar_ref) {
      await enqueue(c.env, safeCtx(c), [{ type: 'calendar.push', tenantId: c.var.tenant.id, eventId: rows[0]!.id, ownerId: rows[0]!.owner_id, removeRef: rows[0]!.calendar_ref }]);
    }
    return c.json({ ok: true });
  })

  // ============================================================================ notifications
  .get('/notifications', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => ({
      items: await tx.query(`select id, kind, title, body, link, read_at, created_at from notifications where tenant_id = $1 and user_id = $2 order by created_at desc limit 40`, [c.var.tenant.id, c.var.principal.user.id]),
      unread: (await tx.one<{ n: number }>(`select count(*)::int n from notifications where tenant_id = $1 and user_id = $2 and read_at is null`, [c.var.tenant.id, c.var.principal.user.id]))?.n ?? 0,
    }));
    return c.json(out);
  })
  .post('/notifications/read', async (c) => {
    const b = z.object({ ids: z.array(uuid).max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    await c.var.db.tx(scope(c), (tx) =>
      tx.query(`update notifications set read_at = now() where tenant_id = $1 and user_id = $2 and read_at is null and ($3::uuid[] is null or id = any($3::uuid[]))`, [c.var.tenant.id, c.var.principal.user.id, b.ids ?? null]),
    );
    return c.json({ ok: true });
  })

  // ============================================================================ forecast + quotas
  .get('/forecast', async (c) => {
    const q = z.object({ period: z.enum(['month', 'quarter']).default('quarter'), start: dateStr.optional() }).parse(c.req.query());
    const start = q.start ?? new Date().toISOString().slice(0, 10);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => forecast(rctx(c, tx), q.period as Period, start)));
  })
  .get('/forecast/projection', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => projection(rctx(c, tx)))))
  .get('/forecast/deals', async (c) => {
    const q = z.object({ period: z.enum(['month', 'quarter']), start: dateStr, category: z.enum(['closed', 'commit', 'best_case', 'pipeline', 'lost', 'omitted']), owner: uuid.optional() }).parse(c.req.query());
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => forecastDeals(rctx(c, tx), q.period, q.start, q.category, q.owner ?? null)) });
  })
  .put('/quotas', async (c) => {
    if (!hasAdmin(c.var.principal.permissions, 'users') && objectPerm(c.var.principal.permissions, 'deal').update !== 'all') throw forbidden();
    const b = z.object({ quotas: z.array(z.object({ userId: uuid, periodStart: dateStr.refine((d) => d.endsWith('-01'), 'must be the first of a month'), amount: z.number().min(0).max(1e13).nullable() })).max(500) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      for (const q of b.quotas) {
        if (q.amount === null) await tx.query(`delete from quotas where tenant_id = $1 and user_id = $2 and period_start = $3`, [c.var.tenant.id, q.userId, q.periodStart]);
        else await tx.query(`insert into quotas (tenant_id, user_id, period_start, amount) values ($1,$2,$3,$4) on conflict (tenant_id, user_id, period_start) do update set amount = excluded.amount`, [c.var.tenant.id, q.userId, q.periodStart, q.amount]);
      }
    });
    return c.json({ ok: true });
  })
  .get('/quotas', async (c) => {
    const q = z.object({ from: dateStr, to: dateStr }).parse(c.req.query());
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select user_id, to_char(period_start, 'YYYY-MM-DD') as period_start, amount::float8 as amount from quotas where tenant_id = $1 and period_start >= $2 and period_start < $3`, [c.var.tenant.id, q.from, q.to])) });
  })

  // ============================================================================ reports
  .get('/reports', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select r.id, r.name, r.description, r.object_key, r.definition, r.folder, r.is_shared, r.owner_id, r.updated_at, u.full_name as owner_name, (r.owner_id = $2) as mine
             from reports r left join users u on u.tenant_id = r.tenant_id and u.id = r.owner_id
            where r.tenant_id = $1 and (r.is_shared or r.owner_id = $2) order by r.folder nulls last, r.name`,
          [c.var.tenant.id, c.var.principal.user.id],
        ),
      ),
    }),
  )
  .post('/reports/run', async (c) => {
    const b = z.object({ objectKey: z.string().max(60), definition: reportDefinitionSchema }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c, true), (tx) => runReport(rctx(c, tx), b.objectKey, b.definition)));
  })
  .get('/reports/:id/run', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const r = await tx.one<{ object_key: string; definition: unknown; name: string }>(`select object_key, definition, name from reports where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id]);
      if (!r) throw notFound();
      const d = reportDefinitionSchema.parse(r.definition);
      return { name: r.name, objectKey: r.object_key, definition: d, result: await runReport(rctx(c, tx), r.object_key, d) };
    });
    return c.json(out);
  })
  .post('/reports', async (c) => {
    const b = reportBodySchema.parse(await c.req.json());
    if (b.isShared && !canSeeShared(c)) throw forbidden('Only admins and managers can share reports');
    getObject(c.var.meta, b.objectKey);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into reports (tenant_id, name, description, object_key, definition, folder, is_shared, owner_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [
        c.var.tenant.id, b.name, b.description ?? null, b.objectKey, JSON.stringify(b.definition), b.folder ?? null, b.isShared, c.var.principal.user.id,
      ]),
    );
    return c.json(row, 201);
  })
  .put('/reports/:id', async (c) => {
    const b = reportBodySchema.parse(await c.req.json());
    const admin = canSeeShared(c);
    if (b.isShared && !admin) throw forbidden('Only admins and managers can share reports');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update reports set name=$4, description=$5, object_key=$6, definition=$7, folder=$8, is_shared=$9 where tenant_id=$1 and id=$2 and (owner_id=$3 or $10::boolean) returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, b.name, b.description ?? null, b.objectKey, JSON.stringify(b.definition), b.folder ?? null, b.isShared, admin,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/reports/:id', async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from reports where tenant_id=$1 and id=$2 and (owner_id=$3 or $4::boolean) returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, canSeeShared(c)]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })

  // ============================================================================ dashboards
  .get('/dashboards', async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select d.*, (d.owner_id = $2) as mine from dashboards d where d.tenant_id = $1 and (d.is_shared or d.owner_id = $2) order by d.name`, [c.var.tenant.id, c.var.principal.user.id])) }),
  )
  .post('/dashboards', async (c) => {
    const b = dashboardSchema.parse(await c.req.json());
    if (b.isShared && !canSeeShared(c)) throw forbidden('Only admins and managers can share dashboards');
    const row = await c.var.db.tx(scope(c), (tx) => tx.one(`insert into dashboards (tenant_id, name, description, widgets, is_shared, owner_id) values ($1,$2,$3,$4,$5,$6) returning *`, [c.var.tenant.id, b.name, b.description ?? null, JSON.stringify(b.widgets), b.isShared, c.var.principal.user.id]));
    return c.json(row, 201);
  })
  .put('/dashboards/:id', async (c) => {
    const b = dashboardSchema.parse(await c.req.json());
    const admin = canSeeShared(c);
    if (b.isShared && !admin) throw forbidden('Only admins and managers can share dashboards');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update dashboards set name=$4, description=$5, widgets=$6, is_shared=$7 where tenant_id=$1 and id=$2 and (owner_id=$3 or $8::boolean) returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, b.name, b.description ?? null, JSON.stringify(b.widgets), b.isShared, admin,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/dashboards/:id', async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from dashboards where tenant_id=$1 and id=$2 and (owner_id=$3 or $4::boolean) returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, canSeeShared(c)]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  });

const eventBase = z.object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['meeting', 'call', 'site_visit', 'demo', 'other']).default('meeting'),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    allDay: z.boolean().default(false),
    location: z.string().max(300).nullish(),
    description: z.string().max(5000).nullish(),
    relatedObject: z.string().max(60).nullish(),
    relatedId: uuid.nullish(),
    ownerId: uuid.nullish(),
    attendees: z.array(z.union([z.object({ userId: uuid }), z.object({ email: z.string().email(), name: z.string().max(120).optional() })])).max(50).default([]),
    reminderMinutes: z.number().int().min(0).max(10_080).nullish(),
});
const eventSchema = eventBase.refine((e) => new Date(e.endsAt) >= new Date(e.startsAt), { message: 'The event must end after it starts', path: ['endsAt'] });

const reportBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  objectKey: z.string().max(60),
  definition: reportDefinitionSchema,
  folder: z.string().max(60).nullish(),
  isShared: z.boolean().default(false),
});

const dashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  widgets: z.array(z.object({ reportId: uuid, size: z.enum(['s', 'm', 'l']).default('m'), title: z.string().max(120).optional() })).max(24),
  isShared: z.boolean().default(false),
});
