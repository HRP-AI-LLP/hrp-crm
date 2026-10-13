import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` runs Vite on :5173 and the Worker (wrangler dev) on :8787; /api is proxied.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
