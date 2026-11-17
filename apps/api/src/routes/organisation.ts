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
import type { RecordCtx } from '../services/records';
import { loadMeta } from '../services/tenancy';
import { systemPrincipal } from '../services/worker';

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => z.string().uuid().parse(c.req.param(k));

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
  .delete('/organisation/people/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => own.deletePerson(rctx(c, tx), id(c)));
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
  // signing a document
  .get('/documents/:object/:id/signatures', async (c) => {
    return c.json(await c.var.db.tx(scope(c, true), (tx) => org.documentSignatures(rctx(c, tx), c.req.param('object'), id(c))));
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

/** Anyone holding a printed document can check its signature code. */
export const verifyPublicRoutes = new Hono<AppEnv>().get('/verify/:tenant/:code', async (c) => {
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
