// @ts-check
/**
 * `pnpm local:test` — runs the test suites against a throwaway Postgres in Podman/Docker.
 *
 * Tests use their own container (`synapse-pg-test`, 127.0.0.1:54330, data in memory) because they
 * reset role passwords, which would break the database `pnpm local` uses. Extra arguments are passed
 * to `pnpm test` (e.g. `pnpm local:test -- --filter @synapse/api`).
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const win = process.platform === 'win32';
const NAME = 'synapse-pg-test';
const PORT = Number(process.env.SYNAPSE_PG_TEST_PORT ?? 54330);
const IMAGE = process.env.SYNAPSE_PG_IMAGE ?? 'docker.io/library/postgres:17-alpine';
const candidates = process.env.CONTAINER_ENGINE ? [process.env.CONTAINER_ENGINE] : ['podman', 'docker'];
const ENGINE = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore', shell: win }).status === 0);
if (!ENGINE) {
  console.error('Neither podman nor docker was found. Run `pnpm local` once (it sets Podman up) or install Podman Desktop.');
  process.exit(1);
}
/** @param {string[]} a */
const eng = (a) => spawnSync(ENGINE, a, { encoding: 'utf8', shell: win });

const state = eng(['container', 'inspect', NAME, '--format', '{{.State.Running}}']);
if (state.status !== 0) {
  const r = eng(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'TZ=UTC', '-p', `127.0.0.1:${PORT}:5432`, '--tmpfs', '/var/lib/postgresql/data', IMAGE]);
  if (r.status !== 0) {
    console.error(`could not start ${NAME}: ${r.stderr}`);
    process.exit(1);
  }
} else if (state.stdout.trim() !== 'true') eng(['start', NAME]);

const url = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    ready = true;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await c.end().catch(() => undefined);
  }
}
if (!ready) {
  console.error(`${NAME} did not become ready`);
  process.exit(1);
}
console.log(`✓ test database ${NAME} on 127.0.0.1:${PORT} (${ENGINE})`);
const r = spawnSync(`pnpm test ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit', shell: true, env: { ...process.env, TEST_ADMIN_DATABASE_URL: url } });
process.exit(r.status ?? 1);
