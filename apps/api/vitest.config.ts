import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workers' TCP sockets, played by node:net / node:tls in tests
    alias: { 'cloudflare:sockets': fileURLToPath(new URL('./test/shims/cloudflare-sockets.ts', import.meta.url)) },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
