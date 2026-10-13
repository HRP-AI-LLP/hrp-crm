import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits dist/sw.js from sw/sw.js with the precache list (app shell + hashed assets) and a
 * content version, so each deploy installs a fresh worker and drops the old cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'synapse-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => /\.(js|css|woff2?|svg|png)$/.test(f) && f.startsWith('assets/'))
        .map((f) => `/${f}`);
      const precache = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', ...assets].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

// `pnpm dev` runs Vite on :5173 and the Worker (wrangler dev) on :8787; /api is proxied.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        // stable vendor chunks: app deploys don't invalidate the cached framework code
        manualChunks(id: string) {
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('node_modules/@tanstack/')) return 'query';
          return undefined;
        },
      },
    },
  },
});
