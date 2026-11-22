// @ts-check
/**
 * Applies new migrations to the production database (Neon, branch "main").
 *
 *   node scripts/setup/migrate-prod.mjs        (GitHub Actions runs this before each deploy)
 *
 * Needs NEON_API_KEY and either NEON_PROJECT_ID or infra/state.json. The connection string is
 * fetched from Neon's API, handed to the migrator in its environment and never printed.
 * Already-applied migrations are skipped (checksums are verified), so running it twice is harmless.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@neondatabase/api-client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The owner (migration) connection string of production. */
export async function prodOwnerUrl() {
  // an explicit owner connection string wins (another host, or a test database)
  if (process.env.PROD_OWNER_DB_URL) return process.env.PROD_OWNER_DB_URL;
  const key = (process.env.NEON_API_KEY ?? '').trim();
  if (!key) throw new Error('NEON_API_KEY is not set');
  let projectId = (process.env.NEON_PROJECT_ID ?? '').trim();
  /** @type {string | undefined} */ let branchId;
  try {
    const state = JSON.parse(readFileSync(join(ROOT, 'infra', 'state.json'), 'utf8'));
    projectId ||= state.neon?.projectId ?? '';
    branchId = state.neon?.branches?.prod;
  } catch {
    /* no state file: look the branch up */
  }
  if (!projectId) throw new Error('NEON_PROJECT_ID is not set and infra/state.json has no Neon project');
  const neon = createApiClient({ apiKey: key });
  if (!branchId) {
    const branches = (await neon.listProjectBranches({ projectId })).data.branches;
    branchId = (branches.find((b) => b.default) ?? branches.find((b) => b.name === 'main'))?.id;
  }
  if (!branchId) throw new Error('could not find the production branch in Neon');
  const r = await neon.getConnectionUri({ projectId, branch_id: branchId, database_name: process.env.NEON_DB_NAME ?? 'neondb', role_name: process.env.NEON_OWNER_ROLE ?? 'neondb_owner', pooled: false });
  return r.data.uri.replace(/sslmode=require/, 'sslmode=verify-full');
}

/** Runs the migrator against production. */
export async function migrateProd() {
  const url = await prodOwnerUrl();
  const r = spawnSync('pnpm --filter @synapse/db migrate', { shell: true, stdio: 'inherit', cwd: ROOT, env: { ...process.env, DATABASE_URL_OWNER: url } });
  if (r.status !== 0) throw new Error('migration failed');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  migrateProd().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
