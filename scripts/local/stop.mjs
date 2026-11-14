// @ts-check
/**
 * `pnpm local:stop`        stops a `pnpm local` / `pnpm local:cloud` that is still running (frees 8787 and 5173)
 * `pnpm local:stop --db`   also stops the local Postgres container (its data is kept)
 */
import { spawnSync } from 'node:child_process';
import { freePorts } from './ports.mjs';

const win = process.platform === 'win32';
freePorts([8787, 5173], true);
// wrangler's runtime sometimes outlives its parent on Windows
if (win) spawnSync('taskkill', ['/IM', 'workerd.exe', '/T', '/F'], { stdio: 'ignore' });

if (process.argv.includes('--db')) {
  const name = process.env.SYNAPSE_PG_CONTAINER ?? 'synapse-pg';
  for (const engine of [process.env.CONTAINER_ENGINE, 'podman', 'docker'].filter(Boolean)) {
    const r = spawnSync(String(engine), ['stop', name], { encoding: 'utf8', shell: win });
    if (r.status === 0) {
      console.log(`✓ stopped the ${name} container (${engine}); data is kept`);
      break;
    }
  }
}
