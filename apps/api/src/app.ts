import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env';
import { notFound, onError } from './lib/errors';
import { authenticate, requestContext, tenantResolver } from './middleware';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { crmRoutes } from './routes/crm';
import { dataRoutes } from './routes/data';
import { flowRoutes, rulesAdminRoutes } from './routes/flow';
import { appsAdminRoutes, opsRoutes } from './routes/ops';
import { fieldRoutes, serviceAdminRoutes } from './routes/field';
import { billingAdminRoutes, billingRoutes } from './routes/billing';
import { organisationRoutes, verifyPublicRoutes } from './routes/organisation';
import { dealBillingRoutes } from './routes/deal-billing';
import { booksRoutes } from './routes/books';
import { projectRoutes } from './routes/projects';
import { itRoutes } from './routes/it';
import { workAdminRoutes, workPublicRoutes, workRoutes } from './routes/work';
import { industryPublicRoutes, industryRoutes } from './routes/industry';
import { intakeRoutes } from './routes/intake';
import { manufacturingRoutes } from './routes/manufacturing';
import { depositRoutes } from './routes/deposits';
import { gstRoutes } from './routes/gst';
import { mobileRoutes } from './routes/mobile';
import { integrationAdminRoutes, integrationPublicRoutes, integrationRoutes } from './routes/integrations';
import { publicRoutes } from './routes/public';
import { whatsappAdminRoutes, whatsappPublicRoutes, whatsappRoutes } from './routes/whatsapp';
import { digestRoutes, insightsAdminRoutes, insightsRoutes, sharePublicRoutes } from './routes/insights';
import { tallyAdminRoutes, tallyPublicRoutes } from './routes/tally';
import { intelAdminRoutes, intelRoutes } from './routes/intel';
import { developerRoutes } from './routes/developers';
import { auditExportRoutes, privacyAdminRoutes, privacyPublicRoutes, privacyRoutes } from './routes/privacy';
import { salesRoutes } from './routes/sales';
import { securityRoutes } from './routes/security';
import { connectionKeyRoutes } from './routes/connection-keys';
import { usageRoutes } from './routes/usage';
import { agentRoutes, mcpRoutes } from './routes/mcp';
import { withPlatformKeys } from './services/connection-keys';
import { Db } from './lib/db';
import { projectChatRoutes } from './routes/project-chats';
import { assistantRoutes } from './routes/assistant';
import { setAssistantApp } from './services/assistant';
import { markDbAwake } from './services/cron-plan';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('/api/*', requestContext);
  // remembers that the database is awake, so the cron can do its background work for free
  app.use('/api/*', async (c, next) => {
    await next();
    let wait: ((p: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      wait = (p) => ctx.waitUntil(p);
    } catch {
      /* no execution context (tests) */
    }
    markDbAwake(c.env, wait);
  });
  // keys saved in Settings → Connection keys take the place of the .env values
  app.use('/api/*', async (c, next) => {
    c.env = await withPlatformKeys(c.env, c.var.db);
    await next();
  });
  app.use(
    '/api/*',
    secureHeaders({
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    }),
  );
  // The SPA is served from the same origin as the API; CORS is only opened for explicitly
  // configured origins (e.g. the Vite dev server) and for public form embeds (see public.ts).
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/public/forms/')) return next();
    const allowed = (c.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.length) return next();
    return cors({ origin: allowed, credentials: true, allowHeaders: ['authorization', 'content-type', 'x-tenant', 'x-requested-with', 'if-match'], exposeHeaders: ['x-request-id'] })(c, next);
  });
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
  });

  app.route('/api/public', publicRoutes);
  app.route('/api/public', integrationPublicRoutes);
  app.route('/api/public', privacyPublicRoutes);
  app.route('/api/public', whatsappPublicRoutes);
  app.route('/api/public', sharePublicRoutes);
  app.route('/api/public', tallyPublicRoutes);
  app.route('/api/public', verifyPublicRoutes);
  app.route('/api/public', industryPublicRoutes);
  app.route('/api/public', workPublicRoutes);

  app.use('/api/auth/*', tenantResolver);
  app.route('/api/auth', authRoutes);

  for (const path of ['/api/v1/*', '/api/ai/*', '/api/admin/*']) {
    app.use(path, tenantResolver, authenticate);
  }
  app.route('/api/v1', crmRoutes);
  app.route('/api/v1', dataRoutes);
  app.route('/api/v1', salesRoutes);
  app.route('/api/v1', flowRoutes);
  app.route('/api/v1', opsRoutes);
  app.route('/api/v1', fieldRoutes);
  app.route('/api/v1', billingRoutes);
  app.route('/api/v1', organisationRoutes);
  app.route('/api/v1', dealBillingRoutes);
  app.route('/api/v1', booksRoutes);
  app.route('/api/v1', projectRoutes);
  app.route('/api/v1', itRoutes);
  app.route('/api/v1', workRoutes);
  app.route('/api/v1', projectChatRoutes);
  app.route('/api/v1', assistantRoutes);
  app.route('/api/v1', mcpRoutes);
  app.route('/api/v1', agentRoutes);
  app.route('/api/v1', industryRoutes);
  app.route('/api/v1', intakeRoutes);
  app.route('/api/v1', manufacturingRoutes);
  app.route('/api/v1', depositRoutes);
  app.route('/api/v1', gstRoutes);
  app.route('/api/v1', mobileRoutes);
  app.route('/api/v1', integrationRoutes);
  app.route('/api/v1', privacyRoutes);
  app.route('/api/v1', whatsappRoutes);
  app.route('/api/v1', insightsRoutes);
  app.route('/api/v1', digestRoutes);
  app.route('/api/v1', developerRoutes);
  app.route('/api/v1/intel', intelRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', securityRoutes);
  app.route('/api/admin', rulesAdminRoutes);
  app.route('/api/admin', appsAdminRoutes);
  app.route('/api/admin', serviceAdminRoutes);
  app.route('/api/admin', billingAdminRoutes);
  app.route('/api/admin', integrationAdminRoutes);
  app.route('/api/admin', privacyAdminRoutes);
  app.route('/api/admin', auditExportRoutes);
  app.route('/api/admin', whatsappAdminRoutes);
  app.route('/api/admin', insightsAdminRoutes);
  app.route('/api/admin', tallyAdminRoutes);
  app.route('/api/admin', workAdminRoutes);
  app.route('/api/admin', connectionKeyRoutes);
  app.route('/api/admin', usageRoutes);
  app.route('/api/admin/intel', intelAdminRoutes);

  app.all('/api/*', () => {
    throw notFound('No such API route');
  });

  // Android Trusted Web Activity: proves the Play Store app and this domain belong together
  app.get('/.well-known/assetlinks.json', async (c) => {
    // the Android app keys can be set in Settings → Connection keys
    const db = Db.fromEnv(c.env);
    try {
      c.env = await withPlatformKeys(c.env, db);
    } finally {
      await db.close();
    }
    const fingerprints = (c.env.ANDROID_CERT_SHA256 ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!c.env.ANDROID_APP_ID || !fingerprints.length) return c.json([], 200, { 'cache-control': 'public, max-age=300' });
    return c.json(
      [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: c.env.ANDROID_APP_ID, sha256_cert_fingerprints: fingerprints } }],
      200,
      { 'cache-control': 'public, max-age=3600' },
    );
  });

  // Everything else is the SPA (Workers Static Assets with SPA fallback)
  app.all('*', async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('SanchalanOS API', 200);
  });

  app.onError(onError);
  // the workspace assistant calls this same API in-process, as the person it works for
  setAssistantApp(app as never);
  return app;
}
