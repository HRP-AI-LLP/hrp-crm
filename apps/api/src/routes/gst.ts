/**
 * GST portal, e-invoice and e-way bill through the WhiteBooks GSP: /api/v1/gst/*.
 * Needs the GST billing app; access (books or billing admins) is checked in services/gst.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import * as ein from '../services/gst/einvoice';
import * as gst from '../services/gst/portal';
import { filingCalendar, toRetPeriod } from '../services/gst/returns';
import type { RecordCtx } from '../services/records';

const uuid = z.string().uuid();
const period = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/, 'Return period is MMYYYY');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN is not valid');

function clientIp(c: Context<AppEnv>) {
  const raw = (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? '').trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(raw) ? raw : '127.0.0.1';
}
function deps(c: Context<AppEnv>, readOnly = false): gst.GstDeps {
  return {
    env: c.env,
    ip: clientIp(c),
    run: <T,>(fn: (ctx: RecordCtx) => Promise<T>) =>
      c.var.db.tx(scope(c, readOnly), (tx) => fn({ tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id })),
  };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};

const connSchema = z.object({
  gstin: z.string().trim().toUpperCase().length(15),
  legalName: z.string().trim().max(200).nullish(),
  gstUsername: z.string().trim().max(60).nullish(),
  signatoryPan: pan.nullish().or(z.literal('')),
  filingFrequency: z.enum(['monthly', 'quarterly']).optional(),
  einvUsername: z.string().trim().max(60).nullish(),
  einvPassword: z.string().max(100).nullish(),
  ewbUsername: z.string().trim().max(60).nullish(),
  ewbPassword: z.string().max(100).nullish(),
});
const transport = z.object({
  distance: z.number().int().min(0).max(4000),
  mode: z.enum(['road', 'rail', 'air', 'ship']),
  transporterId: z.string().trim().max(15).nullish(),
  transporterName: z.string().trim().max(100).nullish(),
  vehicleNo: z.string().trim().max(20).nullish(),
  vehicleType: z.enum(['regular', 'odc']).optional(),
  docNo: z.string().trim().max(15).nullish(),
  docDate: dateStr.nullish(),
});
const head = z.object({ tax: z.number().min(0).max(1e11).optional(), interest: z.number().min(0).max(1e11).optional(), fee: z.number().min(0).max(1e11).optional(), penalty: z.number().min(0).max(1e11).optional(), other: z.number().min(0).max(1e11).optional() });

export const gstRoutes = new Hono<AppEnv>()
  .use('/gst/*', async (c, next) => {
    if (!enabledApps(c.var.meta).has('billing')) throw notFound('GST billing is switched off for the workspace');
    return next();
  })
  // ------------------------------------------------------------ registrations and session
  .get('/gst/connections', async (c) => c.json(await gst.listConnections(deps(c))))
  .post('/gst/connections', async (c) => {
    const b = connSchema.parse(await c.req.json());
    return c.json(await gst.saveConnection(deps(c), null, { ...b, signatoryPan: b.signatoryPan || null }), 201);
  })
  .patch('/gst/connections/:id', async (c) => {
    const b = connSchema.partial().extend({ gstin: z.string().trim().toUpperCase().length(15) }).parse(await c.req.json());
    return c.json(await gst.saveConnection(deps(c), id(c), { ...b, signatoryPan: b.signatoryPan === '' ? null : b.signatoryPan }));
  })
  .delete('/gst/connections/:id', async (c) => c.json(await gst.deleteConnection(deps(c), id(c))))
  .post('/gst/connections/:id/otp', async (c) => c.json(await gst.requestOtp(deps(c), id(c))))
  .post('/gst/connections/:id/verify', async (c) => {
    const b = z.object({ otp: z.string().trim().regex(/^\d{4,8}$/) }).parse(await c.req.json());
    return c.json(await gst.verifyOtp(deps(c), id(c), b.otp));
  })
  .post('/gst/connections/:id/disconnect', async (c) => c.json(await gst.disconnect(deps(c), id(c))))
  .get('/gst/connections/:id/log', async (c) => c.json(await gst.connectionLog(deps(c, true), id(c))))

  // ------------------------------------------------------------ dashboard
  .get('/gst/connections/:id/overview', async (c) => c.json(await gst.overview(deps(c, true), id(c))))
  .post('/gst/connections/:id/sync-returns', async (c) => {
    const b = z.object({ fyStart: z.number().int().min(2017).max(2100) }).parse(await c.req.json());
    return c.json(await gst.syncReturnTrack(deps(c), id(c), b.fyStart));
  })
  .get('/gst/views', (c) => c.json(gst.viewsFor(c.env)))
  .post('/gst/connections/:id/views/:kind', async (c) => {
    const params = z.record(z.string(), z.string().max(64)).parse(await c.req.json().catch(() => ({})));
    return c.json(await gst.fetchView(deps(c), id(c), c.req.param('kind'), params));
  })
  .get('/gst/search/:gstin', async (c) => c.json(await gst.searchTaxpayer(deps(c, true), c.req.param('gstin'))))
  .get('/gst/calendar', (c) => {
    const q = z.object({ gstin: z.string().length(15), frequency: z.enum(['monthly', 'quarterly']).default('monthly'), from: z.string().regex(/^\d{4}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}$/) }).parse(c.req.query());
    toRetPeriod(q.from);
    toRetPeriod(q.to);
    return c.json(filingCalendar(q.gstin.toUpperCase(), q.frequency, q.from, q.to));
  })

  // ------------------------------------------------------------ returns
  .get('/gst/connections/:id/filings', async (c) => c.json(await gst.listFilings(deps(c, true), id(c))))
  .post('/gst/connections/:id/filings', async (c) => {
    const b = z
      .object({
        returnType: z.enum(Object.keys(gst.FORMS) as [string, ...string[]]),
        period,
        payload: z.record(z.string(), z.unknown()).nullish(),
        from: dateStr.optional(),
        to: dateStr.optional(),
      })
      .parse(await c.req.json());
    return c.json(await gst.prepareFiling(deps(c), id(c), b as gst.PrepareInput), 201);
  })
  .post('/gst/connections/:id/filings/from-portal', async (c) => {
    const b = z.object({ returnType: z.enum(['GSTR9', 'GSTR2X']), period }).parse(await c.req.json());
    return c.json(await gst.prepareFromPortal(deps(c), id(c), b.returnType, b.period), 201);
  })
  .post('/gst/connections/:id/gstr2b', async (c) => {
    const b = z.object({ period }).parse(await c.req.json());
    return c.json(await gst.importGstr2bFromPortal(deps(c), id(c), b.period));
  })
  .post('/gst/connections/:id/challans', async (c) => {
    const b = z
      .object({
        period,
        mode: z.enum(['EPY', 'NEFT', 'OTC', 'UPI']),
        bankCode: z.string().trim().max(10).nullish(),
        email: z.string().email(),
        mobile: z.string().regex(/^[6-9]\d{9}$/, 'Mobile number is 10 digits'),
        reason: z.string().max(10).optional(),
        amounts: z.object({ igst: head.optional(), cgst: head.optional(), sgst: head.optional(), cess: head.optional() }),
      })
      .parse(await c.req.json());
    return c.json(await gst.createChallan(deps(c), id(c), b), 201);
  })
  .get('/gst/filings/:id', async (c) => c.json(await gst.getFiling(deps(c, true), id(c))))
  .post('/gst/filings/:id/save', async (c) => c.json(await gst.saveFiling(deps(c), id(c))))
  .post('/gst/filings/:id/status', async (c) => c.json(await gst.checkFiling(deps(c), id(c))))
  .post('/gst/filings/:id/proceed', async (c) => {
    const b = z.object({ nil: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await gst.proceedFiling(deps(c), id(c), b));
  })
  .post('/gst/filings/:id/summary', async (c) => c.json(await gst.summaryFiling(deps(c), id(c))))
  .post('/gst/filings/:id/offset/propose', async (c) => c.json(await gst.proposeOffset(deps(c), id(c))))
  .post('/gst/filings/:id/offset', async (c) => {
    const b = z.object({ pdcash: z.array(z.record(z.string(), z.unknown())).max(10), pditc: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
    return c.json(await gst.offsetFiling(deps(c), id(c), b));
  })
  .post('/gst/filings/:id/reset', async (c) => c.json(await gst.resetFiling(deps(c), id(c))))
  .post('/gst/filings/:id/evc-otp', async (c) => {
    const b = z.object({ pan: pan.nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await gst.requestEvcOtp(deps(c), id(c), b.pan));
  })
  .post('/gst/filings/:id/file', async (c) => {
    const b = z
      .object({
        mode: z.enum(['evc', 'dsc']),
        pan: pan.nullish(),
        otp: z.string().trim().regex(/^\d{6}$/).nullish(),
        declaration: z.literal(true, { message: 'Confirm the declaration before filing' }),
      })
      .parse(await c.req.json());
    return c.json(await gst.fileFiling(deps(c), id(c), b));
  })

  // ------------------------------------------------------------ e-invoice and e-way bill
  .get('/gst/invoices/:id', async (c) => c.json(await ein.invoiceGstStatus(deps(c, true), id(c))))
  .post('/gst/invoices/:id/irn', async (c) => c.json(await ein.generateIrn(deps(c), id(c))))
  .post('/gst/invoices/:id/irn/cancel', async (c) => {
    const b = z.object({ reason: z.enum(['duplicate', 'data_entry_mistake', 'order_cancelled', 'other']), remark: z.string().trim().min(3).max(100) }).parse(await c.req.json());
    return c.json(await ein.cancelIrn(deps(c), id(c), b.reason, b.remark));
  })
  .post('/gst/invoices/:id/eway-bill', async (c) => c.json(await ein.generateEwayBill(deps(c), id(c), transport.parse(await c.req.json()))))
  .post('/gst/invoices/:id/eway-bill/cancel', async (c) => {
    const b = z.object({ reason: z.enum(['duplicate', 'order_cancelled', 'data_entry_mistake', 'other']), remark: z.string().trim().min(3).max(50) }).parse(await c.req.json());
    return c.json(await ein.cancelEwayBill(deps(c), id(c), b.reason, b.remark));
  })
  .post('/gst/invoices/:id/eway-bill/vehicle', async (c) => {
    const b = z
      .object({
        vehicleNo: z.string().trim().max(20),
        fromPlace: z.string().trim().max(50),
        reason: z.enum(['breakdown', 'transhipment', 'other', 'first_time']),
        remark: z.string().trim().min(3).max(50),
        mode: z.enum(['road', 'rail', 'air', 'ship']).optional(),
        docNo: z.string().trim().max(15).nullish(),
        docDate: dateStr.nullish(),
      })
      .parse(await c.req.json());
    return c.json(await ein.updateVehicle(deps(c), id(c), b));
  });
