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
import { publicRoutes } from './routes/public';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('/api/*', requestContext);
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

  app.use('/api/auth/*', tenantResolver);
  app.route('/api/auth', authRoutes);

  for (const path of ['/api/v1/*', '/api/ai/*', '/api/admin/*']) {
    app.use(path, tenantResolver, authenticate);
  }
  app.route('/api/v1', crmRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/admin', adminRoutes);

  app.all('/api/*', () => {
    throw notFound('No such API route');
  });

  // Everything else is the SPA (Workers Static Assets with SPA fallback)
  app.all('*', async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('HRP Synapse API', 200);
  });

  app.onError(onError);
  return app;
}
