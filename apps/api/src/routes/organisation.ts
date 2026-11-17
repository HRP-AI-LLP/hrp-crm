/**
 * Settings → Organisation (profile, contacts, partners and their personal accounts, the company's bank
 * accounts, saved signatures), signing documents, and the public signature check.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { createBankAccount } from '../services/books/banking';
import * as own from '../services/books/own-accounts';
import { ensureBooks } from '../services/books/ledger';
import * as org from '../services/organisation';
import * as dsc from '../services/dsc';
import * as tpl from '../services/doc-templates';
import * as odocs from '../services/org-documents';
import * as ident from '../services/person-identity';
import type { RecordCtx } from '../services/records';
import { loadMeta } from '../services/tenancy';
import { systemPrincipal } from '../services/worker';

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => z.string().uuid().parse(c.req.param(k));
/** The verification page for signature codes printed on documents. */
const verifyBase = (c: { req: { url: string; header: (k: string) => string | undefined }; var: AppEnv['Variables'] }) => {
  const origin = c.req.header('origin') ?? new URL(c.req.url).origin;
  return /^https?:\/\//.test(origin) ? `${origin}/verify/${c.var.tenant.id}` : null;
};

export const organisationRoutes = new Hono<AppEnv>()
  .get('/organisation', async (c) => {
    return c.json(await c.var.db.tx(scope(c, true), (tx) => org.getProfile(rctx(c, tx))));
  })
  .put('/organisation', async (c) => {
    const b = org.profileSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => org.saveProfile(rctx(c, tx), b)));
  })
  // partners / directors and the company's bank accounts (shared with the accounts desk)
  .get('/organisation/people', async (c) => {
    return c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const ctx = rctx(c, tx);
        await org.assertOrgManager(ctx).catch(async (e) => {
          // books admins see it too
          const { hasAdmin } = await import('@synapse/shared');
          if (!hasAdmin(ctx.principal.permissions, 'books')) throw e;
        });
        await ensureBooks(tx, ctx.tenantId);
        return own.listOwn(ctx);
      }),
    );
  })
  .post('/organisation/people', async (c) => {
    const b = own.personSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), async (tx) => {
      await ensureBooks(tx, c.var.tenant.id);
      return own.savePerson(rctx(c, tx), null, b);
    }));
  })
  .put('/organisation/people/:id', async (c) => {
    const b = own.personSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => own.savePerson(rctx(c, tx), id(c), b)));
  })
  // identity and statutory numbers of a partner or a team member (PAN, Aadhaar, UAN, PF)
  .get('/identity/:subject/:id', async (c) => {
    const subject = z.enum(['partner', 'user']).parse(c.req.param('subject'));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => ident.getIdentity(rctx(c, tx), c.env, subject, id(c))));
  })
  .put('/identity/:subject/:id', async (c) => {
    const subject = z.enum(['partner', 'user']).parse(c.req.param('subject'));
    const b = ident.identitySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ident.saveIdentity(rctx(c, tx), c.env, subject, id(c), b)));
  })
  .post('/identity/:subject/:id/reveal-aadhaar', async (c) => {
    const subject = z.enum(['partner', 'user']).parse(c.req.param('subject'));
    return c.json(await c.var.db.tx(scope(c), (tx) => ident.revealAadhaar(rctx(c, tx), c.env, subject, id(c))));
  })
  // registration documents of the organisation and its partners
  .get('/organisation/documents', async (c) => {
    return c.json(await c.var.db.tx(scope(c, true), (tx) => odocs.listDocuments(rctx(c, tx), c.env)));
  })
  .post('/organisation/documents', async (c) => {
    const b = odocs.docSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => odocs.createDocument(rctx(c, tx), c.env, b)), 201);
  })
  .put('/organisation/documents/:id', async (c) => {
    const b = odocs.docUpdateSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => odocs.updateDocument(rctx(c, tx), c.env, id(c), b)));
  })
  .delete('/organisation/documents/:id', async (c) => {
    return c.json(await c.var.db.tx(scope(c), (tx) => odocs.deleteDocument(rctx(c, tx), c.env, id(c))));
  })
  .post('/organisation/documents/:id/file', async (c) => {
    const name = z.string().trim().min(1).max(200).catch('document').parse(c.req.query('name'));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await c.var.db.tx(scope(c), (tx) => odocs.attachFile(rctx(c, tx), c.env, id(c), name, bytes)));
  })
  .delete('/organisation/documents/:id/file', async (c) => {
    return c.json(await c.var.db.tx(scope(c), (tx) => odocs.removeFile(rctx(c, tx), c.env, id(c))));
  })
  .delete('/organisation/people/:id', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => own.deletePerson(rctx(c, tx), id(c)));
    // their documents' copies leave storage once the deletion is committed
    if (c.env.FILES) await Promise.all(r.storageKeys.map((k) => c.env.FILES!.delete(k).catch(() => undefined)));
    return c.json({ ok: true });
  })
  .post('/organisation/bank-accounts', async (c) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(150),
        kind: z.enum(['bank', 'wallet']).default('bank'),
        bankName: z.string().max(120).nullish(),
        accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, 'Account number: 6 to 20 digits'),
        ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').nullish(),
        upi: z.string().trim().nullish(),
      })
      .parse(await c.req.json());
    return c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const ctx = rctx(c, tx);
        await org.assertOrgManager(ctx);
        await ensureBooks(tx, ctx.tenantId);
        const r = await createBankAccount(ctx, { name: b.name, kind: b.kind, bankName: b.bankName ?? null, last4: b.accountNumber.slice(-4), ifsc: b.ifsc ?? null });
        await own.saveBankIdents(ctx, r.id, { identifiers: [{ kind: 'account', value: b.accountNumber }, ...(b.upi ? [{ kind: 'upi' as const, value: b.upi }] : [])] });
        return r;
      }),
      201,
    );
  })
  .put('/organisation/bank-accounts/:id', async (c) => {
    const b = own.bankIdentsSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => own.saveBankIdents(rctx(c, tx), id(c), b));
    return c.json({ ok: true });
  })
  // saved signatures
  .get('/organisation/signatures', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => org.listSignatures(rctx(c, tx)))))
  .post('/organisation/signatures', async (c) => {
    const b = org.signatureSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => org.saveSignature(rctx(c, tx), null, b)), 201);
  })
  .put('/organisation/signatures/:id', async (c) => {
    const b = org.signatureSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => org.saveSignature(rctx(c, tx), id(c), b)));
  })
  .delete('/organisation/signatures/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => org.removeSignature(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  // document templates
  .get('/doc-templates', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => tpl.listTemplates(rctx(c, tx)))))
  .get('/doc-templates/for/:kind', async (c) => {
    const kind = z.enum(tpl.DOC_KINDS).parse(c.req.param('kind'));
    const t = c.req.query('id');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => tpl.templateFor(rctx(c, tx), kind, t && /^[0-9a-f-]{36}$/i.test(t) ? t : null)));
  })
  .post('/doc-templates', async (c) => {
    const b = tpl.templateSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => tpl.saveTemplate(rctx(c, tx), null, b)), 201);
  })
  .put('/doc-templates/:id', async (c) => {
    const b = tpl.templateSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => tpl.saveTemplate(rctx(c, tx), id(c), b)));
  })
  .delete('/doc-templates/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tpl.deleteTemplate(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .post('/doc-templates/:id/defaults', async (c) => {
    const b = z.object({ kinds: z.array(z.string()).max(4) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tpl.setDefaults(rctx(c, tx), id(c), b.kinds));
    return c.json({ ok: true });
  })
  .post('/doc-templates/ai', async (c) => {
    const b = tpl.aiSchema.parse(await c.req.json());
    return c.json(await tpl.aiTemplate({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, requestId: c.var.requestId, meta: c.var.meta }, b));
  })
  // digital signature certificates
  .get('/organisation/dsc', async (c) => {
    return c.json(await c.var.db.tx(scope(c, true), async (tx) => ({ certificates: await dsc.listCerts(rctx(c, tx)), signers: await dsc.listSigners(rctx(c, tx)) })));
  })
  .post('/organisation/dsc/pfx', async (c) => {
    const b = dsc.pfxSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dsc.addPfx(rctx(c, tx), c.env, b)), 201);
  })
  .post('/organisation/dsc/token', async (c) => {
    const b = dsc.tokenCertSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dsc.addTokenCert(rctx(c, tx), b)), 201);
  })
  .put('/organisation/dsc/:id', async (c) => {
    const b = dsc.certUpdateSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => dsc.updateCert(rctx(c, tx), id(c), b));
    return c.json({ ok: true });
  })
  .delete('/organisation/dsc/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => dsc.removeCert(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .post('/organisation/dsc-signers', async (c) => {
    const b = z.object({ label: z.string().trim().min(1).max(120) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dsc.pairSigner(rctx(c, tx), c.env, b.label)), 201);
  })
  .delete('/organisation/dsc-signers/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => dsc.revokeSigner(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .post('/documents/:object/:id/dsc/pfx', async (c) => {
    const b = dsc.pfxSignSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => dsc.signWithPfx(rctx(c, tx), c.env, c.req.param('object'), id(c), b, verifyBase(c)));
    return c.json(r);
  })
  .post('/documents/:object/:id/dsc/ticket', async (c) => {
    const b = dsc.ticketSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dsc.signTicket(rctx(c, tx), c.env, c.req.param('object'), id(c), b, verifyBase(c))));
  })
  .post('/documents/:object/:id/dsc/token', async (c) => {
    const b = dsc.tokenCompleteSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dsc.completeTokenSign(rctx(c, tx), c.env, c.req.param('object'), id(c), b)));
  })
  // signing a document
  .get('/documents/:object/:id/signatures', async (c) => {
    return c.json(await c.var.db.tx(scope(c, true), (tx) => org.documentSignatures(rctx(c, tx), c.req.param('object'), id(c), c.env)));
  })
  .post('/documents/:object/:id/sign', async (c) => {
    const b = z.object({ signatureId: z.string().uuid() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => org.signDocument(rctx(c, tx), c.req.param('object'), id(c), b.signatureId));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => org.documentSignatures(rctx(c, tx), c.req.param('object'), id(c))));
  })
  .post('/documents/:object/:id/signatures/:sid/revoke', async (c) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => org.revokeSignature(rctx(c, tx), c.req.param('object'), id(c), id(c, 'sid'), b.reason));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => org.documentSignatures(rctx(c, tx), c.req.param('object'), id(c))));
  });

async function publicCtx(c: { env: AppEnv['Bindings'] }, tx: RecordCtx['tx'], tenant: string): Promise<RecordCtx> {
  const t = await tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select * from tenants where id = $1`, [tenant]);
  if (!t) throw notFound();
  const meta = await loadMeta(c.env, tx, { id: t.id, slug: t.slug, name: t.name, status: t.status, metaVersion: t.meta_version });
  const owner = await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [tenant]);
  return { tx, meta, tenantId: tenant, principal: systemPrincipal(owner?.id ?? null, meta.objects.map((o) => o.key)) };
}

/** Anyone holding a printed document can check its signature code. */
export const verifyPublicRoutes = new Hono<AppEnv>()
  .post('/verify-pdf/:tenant', async (c) => {
    const tenant = c.req.param('tenant');
    if (!/^[0-9a-f-]{36}$/i.test(tenant)) throw notFound();
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > 25 * 1024 * 1024) throw badRequest('The PDF is too large');
    if (!(body[0] === 0x25 && body[1] === 0x50)) throw badRequest('Not a PDF');
    const out = await c.var.db.tx({ tenantId: tenant, readOnly: true }, async (tx) => dsc.verifyUploadedPdf(await publicCtx(c, tx, tenant), body));
    c.header('cache-control', 'no-store');
    return c.json(out);
  })
  .get('/verify/:tenant/:code', async (c) => {
  const tenant = c.req.param('tenant');
  const code = c.req.param('code').toUpperCase();
  if (!/^[0-9a-f-]{36}$/i.test(tenant)) throw notFound();
  if (!/^[A-Z0-9]{12}$/.test(code)) throw badRequest('A verification code is 12 letters and digits');
  const out = await c.var.db.tx({ tenantId: tenant, readOnly: true }, async (tx) => {
    const t = await tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select * from tenants where id = $1`, [tenant]);
    if (!t) throw notFound();
    const meta = await loadMeta(c.env, tx, { id: t.id, slug: t.slug, name: t.name, status: t.status, metaVersion: t.meta_version });
    const owner = await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [tenant]);
    return org.verifyByCode({ tx, meta, tenantId: tenant, principal: systemPrincipal(owner?.id ?? null, meta.objects.map((o) => o.key)) }, code);
  });
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  return c.json(out);
});
