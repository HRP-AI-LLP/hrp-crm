/**
 * WhatsApp Business, shared inbox and campaigns.
 *   whatsappRoutes       → /api/v1     inbox, sending from a record, templates to pick, media, document links
 *   whatsappAdminRoutes  → /api/admin  templates (sync / submit), quick replies (channels); campaigns (campaigns)
 *   whatsappPublicRoutes → /api/public customer view of an invoice or order (signed link)
 */
import { hasAdmin } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { getInvoice } from '../services/billing';
import { campaignResults, campaignStep, MAX_RECIPIENTS, previewAudience, startCampaign, checkContent } from '../services/campaigns';
import type { ChannelAccount } from '../services/channels';
import { appOrigin } from '../services/mailer';
import { getOrder } from '../services/orders';
import { Params, type RecordCtx, visibilityWhere } from '../services/records';
import { systemCtxFor } from '../services/system';
import { assertConversationAccess, createTemplate, docToken, fetchMedia, isInboxAdmin, readDocToken, sendToRecord, syncTemplates, whatsappAccount, windowOpen } from '../services/whatsapp';
import { safeCtx } from './public';

const uuid = z.string().uuid();
function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

const outboundSchema = z
  .object({
    text: z.string().trim().max(4096).nullish(),
    templateId: uuid.nullish(),
    values: z.array(z.string().max(1024)).max(20).optional(),
    doc: z.object({ kind: z.enum(['quote', 'invoice', 'sales_order']), id: uuid }).nullish(),
    replyTo: z.string().max(200).nullish(),
  })
  .refine((b) => b.text || b.templateId || b.doc, 'Write a message, pick a template or attach a document');

/** Conversations the caller may open: assigned to them, or about a lead / contact / account they can see. */
function inboxWhere(ctx: RecordCtx, p: Params) {
  if (isInboxAdmin(ctx)) return 'true';
  const parts = [`c.assigned_to = ${p.add(ctx.principal.user.id)}::uuid`];
  for (const [object, table] of [['lead', 'leads'], ['contact', 'contacts'], ['account', 'accounts']] as const) {
    if (!ctx.meta.objects.some((o) => o.key === object)) continue;
    try {
      const vis = visibilityWhere(ctx, object, p);
      parts.push(`(c.related_object = '${object}' and exists (select 1 from ${table} r where r.id = c.related_id and ${vis.join(' and ')}))`);
    } catch {
      /* no access to this object */
    }
  }
  return `(${parts.join(' or ')})`;
}

export const whatsappRoutes = new Hono<AppEnv>()
  .get('/inbox', async (c) => {
    const q = z
      .object({ view: z.enum(['mine', 'unassigned', 'all']).default('all'), status: z.enum(['open', 'pending', 'closed', 'any']).default('open'), q: z.string().trim().max(80).optional(), before: z.string().datetime({ offset: true }).optional() })
      .parse(c.req.query());
    const rows = await c.var.db.tx(scope(c, true), (tx) => {
      const ctx = rctx(c, tx);
      const p = new Params();
      const where = [`c.tenant_id = ${p.add(c.var.tenant.id)}::uuid`, inboxWhere(ctx, p)];
      if (q.status !== 'any') where.push(`c.status = ${p.add(q.status)}`);
      if (q.view === 'mine') where.push(`c.assigned_to = ${p.add(c.var.principal.user.id)}::uuid`);
      if (q.view === 'unassigned') where.push(`c.assigned_to is null`);
      if (q.q) where.push(`(c.display_name ilike ${p.add(`%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)} or c.address like ${p.add(`%${q.q.replace(/[^0-9]/g, '') || '~'}%`)})`);
      if (q.before) where.push(`c.last_message_at < ${p.add(q.before)}::timestamptz`);
      return tx.query(
        `select c.id, c.channel, c.address, c.display_name, c.related_object, c.related_id, c.assigned_to, u.full_name as assignee, c.status, c.last_inbound_at, c.last_message_at, c.last_preview, c.last_direction, c.unread,
                coalesce(l.full_name, ct.full_name, a.name) as record_name
           from conversations c
           left join users u on u.tenant_id = c.tenant_id and u.id = c.assigned_to
           left join leads l on c.related_object = 'lead' and l.tenant_id = c.tenant_id and l.id = c.related_id
           left join contacts ct on c.related_object = 'contact' and ct.tenant_id = c.tenant_id and ct.id = c.related_id
           left join accounts a on c.related_object = 'account' and a.tenant_id = c.tenant_id and a.id = c.related_id
          where ${where.join(' and ')} order by c.last_message_at desc limit 60`,
        p.values,
      );
    });
    const counts = await c.var.db.tx(scope(c, true), (tx) => {
      const p = new Params();
      const w = inboxWhere(rctx(c, tx), p);
      return tx.one<Record<string, number>>(
        `select count(*) filter (where c.assigned_to = ${p.add(c.var.principal.user.id)}::uuid and c.status = 'open')::int as mine,
                count(*) filter (where c.assigned_to is null and c.status = 'open')::int as unassigned,
                coalesce(sum(c.unread) filter (where c.assigned_to = $1::uuid), 0)::int as unread
           from conversations c where c.tenant_id = ${p.add(c.var.tenant.id)}::uuid and ${w}`,
        p.values,
      );
    });
    return c.json({ items: rows.map((r) => ({ ...r, windowOpen: windowOpen(r.last_inbound_at as string | null) })), counts });
  })
  .get('/inbox/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    return c.json(
      await c.var.db.tx(scope(c, true), async (tx) => {
        const ctx = rctx(c, tx);
        const conv = await tx.one<Record<string, any>>(
          `select c.*, u.full_name as assignee, coalesce(l.full_name, ct.full_name, a.name) as record_name
             from conversations c left join users u on u.tenant_id = c.tenant_id and u.id = c.assigned_to
             left join leads l on c.related_object = 'lead' and l.tenant_id = c.tenant_id and l.id = c.related_id
             left join contacts ct on c.related_object = 'contact' and ct.tenant_id = c.tenant_id and ct.id = c.related_id
             left join accounts a on c.related_object = 'account' and a.tenant_id = c.tenant_id and a.id = c.related_id
            where c.tenant_id = $1 and c.id = $2`,
          [c.var.tenant.id, id],
        );
        if (!conv) throw notFound();
        await assertConversationAccess(ctx, conv as never);
        const messages = await tx.query(
          `select m.id, m.direction, m.body, m.status, m.error, m.created_at, m.delivered_at, m.read_at, m.media, m.template_id, m.campaign_id, u.full_name as sent_by_name
             from messages m left join users u on u.tenant_id = m.tenant_id and u.id = m.sent_by
            where m.tenant_id = $1 and m.conversation_id = $2 order by m.created_at desc limit 200`,
          [c.var.tenant.id, id],
        );
        return { ...conv, windowOpen: windowOpen(conv.last_inbound_at), windowClosesAt: conv.last_inbound_at ? new Date(new Date(conv.last_inbound_at).getTime() + 86400_000).toISOString() : null, messages: messages.reverse() };
      }),
    );
  })
  .post('/inbox/:id/messages', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = outboundSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => sendToRecord(c.env, rctx(c, tx), appOrigin(c.env, c.req.url), { conversationId: id }, b));
    if (r.status === 'failed') return c.json({ ...r, error: { code: 'send_failed', message: r.error } }, 502);
    return c.json(r, 201);
  })
  .patch('/inbox/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ assignedTo: uuid.nullish(), status: z.enum(['open', 'pending', 'closed']).optional(), related: z.object({ object: z.enum(['lead', 'contact', 'account']), id: uuid }).optional() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const conv = await tx.one<Record<string, any>>(`select * from conversations where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!conv) throw notFound();
      await assertConversationAccess(ctx, conv as never);
      if (b.assignedTo !== undefined) {
        // people take conversations for themselves; handing them to others is for inbox admins and the current owner
        if (b.assignedTo && b.assignedTo !== c.var.principal.user.id && !isInboxAdmin(ctx) && conv.assigned_to !== c.var.principal.user.id) throw forbidden('Only the current owner or an inbox admin can hand this conversation over');
        await tx.query(`update conversations set assigned_to = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.assignedTo]);
        if (b.assignedTo && b.assignedTo !== c.var.principal.user.id)
          await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'message',$3,$4,$5)`, [c.var.tenant.id, b.assignedTo, `${c.var.principal.user.fullName} gave you a conversation`, conv.display_name ?? conv.address, `/inbox?c=${id}`]);
      }
      if (b.status) await tx.query(`update conversations set status = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.status]);
      if (b.related) {
        const t = { lead: 'leads', contact: 'contacts', account: 'accounts' }[b.related.object];
        const { loadRow } = await import('../services/records');
        await loadRow(ctx, b.related.object, b.related.id, 'read');
        await tx.query(`update conversations set related_object = $3, related_id = $4 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.related.object, b.related.id]);
        // only this thread's messages that were unlinked or linked to the old record move over
        await tx.query(
          `update messages set related_object = $3, related_id = $4 where tenant_id = $1 and conversation_id = $2
              and (related_id is null or (related_object is not distinct from $5 and related_id is not distinct from $6::uuid))`,
          [c.var.tenant.id, id, b.related.object, b.related.id, conv.related_object ?? null, conv.related_id ?? null],
        );
        void t;
      }
    });
    return c.json({ ok: true });
  })
  .post('/inbox/:id/read', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const conv = await tx.one<Record<string, any>>(`select * from conversations where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!conv) throw notFound();
      await assertConversationAccess(rctx(c, tx), conv as never);
      await tx.query(`update conversations set unread = 0 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
    });
    return c.json({ ok: true });
  })
  .post('/whatsapp/send', async (c) => {
    const b = z.object({ object: z.string().regex(/^[a-z_]{2,40}$/), id: uuid }).and(outboundSchema).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => sendToRecord(c.env, rctx(c, tx), appOrigin(c.env, c.req.url), { object: b.object, id: b.id }, b));
    if (r.status === 'failed') return c.json({ ...r, error: { code: 'send_failed', message: r.error } }, 502);
    return c.json(r, 201);
  })
  .get('/whatsapp/status', async (c) => {
    const q = z.object({ object: z.string().regex(/^[a-z_]{2,40}$/), id: uuid }).parse(c.req.query());
    return c.json(
      await c.var.db.tx(scope(c, true), async (tx) => {
        // only for a record the caller can open
        const { loadRow } = await import('../services/records');
        await loadRow(rctx(c, tx), q.object, q.id, 'read');
        const acc = await tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and channel = 'whatsapp' and status = 'active' order by created_at limit 1`, [c.var.tenant.id]);
        if (!acc) return { connected: false };
        const conv = await tx.one<{ id: string; last_inbound_at: string | null }>(
          `select id, last_inbound_at from conversations where tenant_id = $1 and channel_account_id = $2 and related_object = $3 and related_id = $4 order by last_message_at desc limit 1`,
          [c.var.tenant.id, acc.id, q.object, q.id],
        );
        const templates = await tx.query(`select id, name, language, category, body_text, variable_count, header_type from wa_templates where tenant_id = $1 and channel_account_id = $2 and status = 'APPROVED' order by category, name`, [c.var.tenant.id, acc.id]);
        return { connected: true, conversationId: conv?.id ?? null, windowOpen: windowOpen(conv?.last_inbound_at), templates };
      }),
    );
  })
  .get('/whatsapp/templates', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), async (tx) => {
        const acc = await whatsappAccount(tx, c.var.tenant.id, c.req.query('accountId') ?? null);
        return tx.query(`select id, name, language, category, body_text, variable_count, header_type from wa_templates where tenant_id = $1 and channel_account_id = $2 and status = 'APPROVED' order by category, name`, [c.var.tenant.id, acc.id]);
      }),
    }),
  )
  .get('/whatsapp/media/:messageId', async (c) => {
    const id = uuid.parse(c.req.param('messageId'));
    const { acc, mediaId } = await c.var.db.tx(scope(c, true), async (tx) => {
      const m = await tx.one<{ media: { id: string } | null; channel_account_id: string; conversation_id: string | null }>(`select media, channel_account_id, conversation_id from messages where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!m?.media?.id || !m.conversation_id) throw notFound();
      const conv = await tx.one<Record<string, any>>(`select * from conversations where tenant_id = $1 and id = $2`, [c.var.tenant.id, m.conversation_id]);
      await assertConversationAccess(rctx(c, tx), conv as never);
      return { acc: await whatsappAccount(tx, c.var.tenant.id, m.channel_account_id), mediaId: m.media.id };
    });
    const f = await fetchMedia(c.env, acc, mediaId);
    return new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
  })
  .get('/quick-replies', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select id, shortcut, title, body from quick_replies where tenant_id = $1 order by shortcut`, [c.var.tenant.id])) }))
  .post('/doc-link', async (c) => {
    const b = z.object({ kind: z.enum(['invoice', 'sales_order']), id: uuid }).parse(await c.req.json());
    await c.var.db.tx(scope(c, true), async (tx) => {
      const { loadRow } = await import('../services/records');
      const { row } = await loadRow(rctx(c, tx), b.kind, b.id, 'read');
      if (b.kind === 'invoice' && row.status === 'draft') throw badRequest('Issue the invoice first');
    });
    return c.json({ url: `${appOrigin(c.env, c.req.url)}/doc/${await docToken(c.env, c.var.tenant.id, b.kind, b.id)}`, expiresInDays: 30 });
  });

const templateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'lowercase letters, digits and _'),
  language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/),
  category: z.enum(['MARKETING', 'UTILITY']),
  header: z.string().trim().max(60).nullish(),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).nullish(),
  examples: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  buttons: z
    .array(z.discriminatedUnion('type', [z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25) }), z.object({ type: z.literal('URL'), text: z.string().trim().min(1).max(25), url: z.string().url().max(2000) }), z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim().min(1).max(25), phone: z.string().regex(/^\+?[0-9]{8,15}$/) })]))
    .max(10)
    .default([]),
});

const varSpec = z.discriminatedUnion('source', [z.object({ source: z.literal('field'), field: z.string().regex(/^[a-z_][a-z0-9_]{0,60}$/), fallback: z.string().max(200).optional() }), z.object({ source: z.literal('text'), value: z.string().max(1024) })]);
const audienceSchema = z.object({ object: z.enum(['lead', 'contact']), filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).max(20).default([]), q: z.string().max(100).optional() });
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  channel: z.enum(['whatsapp', 'email']),
  channelAccountId: uuid,
  templateId: uuid.nullish(),
  variables: z.array(varSpec).max(20).default([]),
  subject: z.string().trim().max(300).nullish(),
  body: z.string().trim().max(20000).nullish(),
  audience: audienceSchema,
});

export const whatsappAdminRoutes = new Hono<AppEnv>()
  // --------------------------------------------------------------------- templates & quick replies
  .get('/whatsapp/:accountId/templates', requireAdmin('channels'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select * from wa_templates where tenant_id = $1 and channel_account_id = $2 and status <> 'DELETED' order by name, language`, [c.var.tenant.id, uuid.parse(c.req.param('accountId'))])) }),
  )
  .post('/whatsapp/:accountId/templates/sync', requireAdmin('channels'), async (c) =>
    c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const acc = await whatsappAccount(tx, c.var.tenant.id, uuid.parse(c.req.param('accountId')));
        return syncTemplates(c.env, tx, c.var.tenant.id, acc);
      }),
    ),
  )
  .post('/whatsapp/:accountId/templates', requireAdmin('channels'), async (c) => {
    const b = templateSchema.parse(await c.req.json());
    return c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const acc = await whatsappAccount(tx, c.var.tenant.id, uuid.parse(c.req.param('accountId')));
        return createTemplate(c.env, tx, c.var.tenant.id, acc, b);
      }),
      201,
    );
  })
  .post('/quick-replies', requireAdmin('channels'), async (c) => {
    const b = z.object({ shortcut: z.string().regex(/^[a-z0-9_-]{1,30}$/), title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => tx.one(`insert into quick_replies (tenant_id, shortcut, title, body) values ($1,$2,$3,$4) on conflict (tenant_id, shortcut) do update set title = excluded.title, body = excluded.body returning id`, [c.var.tenant.id, b.shortcut, b.title, b.body]));
    return c.json(r, 201);
  })
  .delete('/quick-replies/:id', requireAdmin('channels'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from quick_replies where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------------------------- campaigns
  .get('/campaigns', requireAdmin('campaigns'), async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select c.id, c.name, c.channel, c.status, c.purpose, c.total, c.skipped, c.sent, c.delivered, c.read, c.replied, c.failed, c.scheduled_at, c.started_at, c.finished_at, c.created_at, u.full_name as created_by_name, t.name as template_name
             from campaigns c left join users u on u.tenant_id = c.tenant_id and u.id = c.created_by left join wa_templates t on t.tenant_id = c.tenant_id and t.id = c.template_id
            where c.tenant_id = $1 order by c.created_at desc limit 200`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/campaigns', requireAdmin('campaigns'), async (c) => {
    const b = campaignSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const row = { channel: b.channel, channel_account_id: b.channelAccountId, template_id: b.templateId ?? null, variables: b.variables, subject: b.subject ?? null, body: b.body ?? null };
      const { purpose } = await checkContent(tx, c.var.tenant.id, row);
      return tx.one(
        `insert into campaigns (tenant_id, name, channel, channel_account_id, template_id, variables, subject, body, audience, purpose) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [c.var.tenant.id, b.name, b.channel, b.channelAccountId, b.templateId ?? null, JSON.stringify(b.variables), b.subject ?? null, b.body ?? null, JSON.stringify(b.audience), purpose],
      );
    });
    return c.json(r, 201);
  })
  .get('/campaigns/:id', requireAdmin('campaigns'), async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => campaignResults(tx, c.var.tenant.id, uuid.parse(c.req.param('id'))))))
  .patch('/campaigns/:id', requireAdmin('campaigns'), async (c) => {
    const b = campaignSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      const cur = await tx.one<{ status: string }>(`select status from campaigns where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]);
      if (!cur) throw notFound();
      if (cur.status !== 'draft') throw badRequest('Only drafts can be edited');
      const { purpose } = await checkContent(tx, c.var.tenant.id, { channel: b.channel, channel_account_id: b.channelAccountId, template_id: b.templateId ?? null, variables: b.variables, subject: b.subject ?? null, body: b.body ?? null });
      await tx.query(`update campaigns set name = $3, channel = $4, channel_account_id = $5, template_id = $6, variables = $7, subject = $8, body = $9, audience = $10, purpose = $11 where tenant_id = $1 and id = $2`, [
        c.var.tenant.id, c.req.param('id'), b.name, b.channel, b.channelAccountId, b.templateId ?? null, JSON.stringify(b.variables), b.subject ?? null, b.body ?? null, JSON.stringify(b.audience), purpose,
      ]);
    });
    return c.json({ ok: true });
  })
  .delete('/campaigns/:id', requireAdmin('campaigns'), async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from campaigns where tenant_id = $1 and id = $2 and status = 'draft' returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!r.length) throw badRequest('Only drafts can be deleted; cancel a running campaign instead');
    return c.json({ ok: true });
  })
  .post('/campaigns/preview', requireAdmin('campaigns'), async (c) => {
    const b = z.object({ channel: z.enum(['whatsapp', 'email']), audience: audienceSchema, purpose: z.enum(['marketing', 'transactional']).default('marketing') }).parse(await c.req.json());
    return c.json({ ...(await c.var.db.tx(scope(c, true), (tx) => previewAudience(rctx(c, tx), b.channel, b.audience, b.purpose))), max: MAX_RECIPIENTS });
  })
  .post('/campaigns/:id/start', requireAdmin('campaigns'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ scheduleAt: z.string().datetime({ offset: true }).nullish() }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => startCampaign(c.env, rctx(c, tx), id, b.scheduleAt ?? null));
    if (r.status === 'sending') {
      // the first batch goes out right away; the rest every five minutes
      const work = campaignStep(c.env, c.var.db, c.var.tenant.id, id, 40, appOrigin(c.env, c.req.url)).catch(() => undefined);
      const w = safeCtx(c);
      if (w) w.waitUntil(work);
      else await work;
    }
    return c.json(r);
  })
  .post('/campaigns/:id/cancel', requireAdmin('campaigns'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.query(`update campaigns set status = 'cancelled', finished_at = now() where tenant_id = $1 and id = $2 and status in ('scheduled','sending') returning id`, [c.var.tenant.id, id]);
      if (!r.length) throw badRequest('This campaign is not running');
      await tx.query(`update campaign_recipients set status = 'skipped', skip_reason = 'cancelled' where tenant_id = $1 and campaign_id = $2 and status = 'queued'`, [c.var.tenant.id, id]);
      const { recountCampaign } = await import('../services/whatsapp');
      await recountCampaign(tx, c.var.tenant.id, id);
    });
    return c.json({ ok: true });
  })
  .get('/campaigns/:id/recipients', requireAdmin('campaigns'), async (c) => {
    const status = z.enum(['queued', 'skipped', 'sent', 'delivered', 'read', 'replied', 'failed', 'any']).default('any').parse(c.req.query('status') ?? 'any');
    return c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select r.id, r.subject_object, r.subject_id, r.address, r.status, r.skip_reason, r.error, r.sent_at, coalesce(l.full_name, ct.full_name) as name
             from campaign_recipients r
             left join leads l on r.subject_object = 'lead' and l.tenant_id = r.tenant_id and l.id = r.subject_id
             left join contacts ct on r.subject_object = 'contact' and ct.tenant_id = r.tenant_id and ct.id = r.subject_id
            where r.tenant_id = $1 and r.campaign_id = $2 and ($3 = 'any' or r.status = $3) order by r.id limit 500`,
          [c.var.tenant.id, uuid.parse(c.req.param('id')), status],
        ),
      ),
    });
  });

import { templateFor } from '../services/doc-templates';
import { documentSignatures } from '../services/organisation';

export const whatsappPublicRoutes = new Hono<AppEnv>().get('/docs/:token', async (c) => {
  const t = await readDocToken(c.env, c.req.param('token'));
  if (!t) throw notFound('This link has expired. Ask for a new one.');
  const out = await c.var.db.tx({ tenantId: t.tenantId, readOnly: true }, async (tx) => {
    const ctx = await systemCtxFor(c.env, tx, t.tenantId);
    if (!ctx) throw notFound();
    // customers see the printed document: no owner, internal custom fields or approval state
    const scrub = (object: string, dto: Record<string, any>) => {
      const internal = new Set(ctx.meta.objects.find((o) => o.key === object)?.fields.filter((f) => !f.standard).map((f) => f.key) ?? []);
      for (const k of Object.keys(dto)) if (internal.has(k) || /^(owner_id|created_by|updated_by|approval_|ai_)/.test(k)) delete dto[k];
      return dto;
    };
    if (t.kind === 'invoice') {
      const inv = (await getInvoice(ctx, t.id)) as Record<string, any>;
      if (!inv.invoice || ['draft', 'cancelled'].includes(inv.invoice.status)) throw notFound();
      const link = await tx.one<{ short_url: string }>(`select short_url from payment_links where tenant_id = $1 and invoice_id = $2 and status in ('created', 'partially_paid') and short_url is not null order by created_at desc limit 1`, [t.tenantId, t.id]);
      // printed with the workspace's template and its signatures, as on paper
      const template = await templateFor(ctx, 'invoice');
      const signatures = (await documentSignatures(ctx, 'invoice', t.id)).filter((x) => !x.revoked).map(({ signerName, designation, image, signedAt, verifyCode, valid, method }) => ({ signerName, designation, image, signedAt, verifyCode, valid, method }));
      return { kind: t.kind, data: { ...inv, invoice: scrub('invoice', { ...inv.invoice }), payments: undefined, payUrl: link?.short_url ?? null, template, signatures, verifyBase: `${new URL(c.req.url).origin}/verify/${t.tenantId}` } };
    }
    const o = (await getOrder(ctx, t.id)) as Record<string, any>;
    if (['draft', 'cancelled'].includes(o.order.status)) throw notFound();
    // milestones show what is due, not internal notes; the workspace's plan template stays inside
    const milestones = (o.milestones as Record<string, unknown>[]).map(({ notes: _n, invoice_id: _i, ...m }) => m);
    const template = await templateFor(ctx, 'sales_order');
    const signatures = (await documentSignatures(ctx, 'sales_order', t.id)).filter((x) => !x.revoked).map(({ signerName, designation, image, signedAt, verifyCode, valid, method }) => ({ signerName, designation, image, signedAt, verifyCode, valid, method }));
    return { kind: t.kind, data: { ...o, milestones, milestonePlan: undefined, order: scrub('sales_order', { ...o.order }), template, signatures, verifyBase: `${new URL(c.req.url).origin}/verify/${t.tenantId}` } };
  });
  return c.json(out);
});

export { hasAdmin };
