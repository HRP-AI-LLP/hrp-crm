// @ts-check
/**
 * Run HRP Synapse fully on this computer: Postgres in a Podman (or Docker) container, the API with
 * `wrangler dev` and the UI with Vite. Nothing in the cloud is used or touched — no Neon, no
 * Cloudflare remote bindings, no deploy.
 *
 *   pnpm local                 start Postgres, migrate, seed a demo workspace once, build, start API + UI
 *   pnpm local --no-migrate    skip migrations
 *   pnpm local --no-build      skip the production build of the web app (faster restarts)
 *   pnpm local --reset-db      delete the local database (container and volume) and start fresh
 *   pnpm local:stop --db       stop the app and the database container (data is kept)
 *
 * What runs where:
 *   - Postgres 17: container `synapse-pg`, volume `synapse-pgdata`, on 127.0.0.1:54329
 *     (override with SYNAPSE_PG_PORT; choose the engine with CONTAINER_ENGINE=podman|docker)
 *   - API (Worker code): `wrangler dev` with apps/api/wrangler.local.jsonc → http://localhost:8787
 *   - UI with instant reload: Vite → http://localhost:5173
 *   - Files (R2), cache and queue: simulated by wrangler on this computer
 *   - AI: off unless you set GROQ_API_KEY / GEMINI_API_KEY in the terminal (those call the
 *     providers' APIs); everything else has rule-based fallbacks. Knowledge-base vector search is off.
 *   - GST portal / e-invoice / e-way bill: WHITEBOOKS_* keys from the repo-root .env (see
 *     docs/GST-PORTAL.md); they call WhiteBooks' sandbox unless WHITEBOOKS_ENV=production.
 *
 * Local passwords and keys are generated once into infra/.local/local.json (git-ignored) and written
 * only to apps/api/.dev.vars (git-ignored). Nothing secret is printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotEnv, WHITEBOOKS_KEYS } from './dotenv.mjs';
import { freePorts } from './ports.mjs';
import { startDscSigner } from './dsc-signer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// optional settings from the repo-root .env (git-ignored); only the names are shown
const fromDotEnv = loadDotEnv(ROOT);
if (fromDotEnv.length) console.log(`Read from .env: ${fromDotEnv.join(', ')}`);
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
/** @param {string} m @returns {never} */
const fail = (m) => {
  console.error(`\n\x1b[31m✗ ${m}\x1b[0m`);
  process.exit(1);
};
/** @param {string} cmd @param {{ cwd?: string; env?: Record<string, string>; display?: string }} [opts] */
function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { cwd: opts.cwd ?? ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0) fail(`${opts.display ?? cmd} failed`);
}
/** Runs the container engine quietly; returns { ok, out }. @param {string[]} a */
const eng = (a) => {
  const r = spawnSync(ENGINE, a, { encoding: 'utf8', shell: win });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONTAINER = process.env.SYNAPSE_PG_CONTAINER ?? 'synapse-pg';
const VOLUME = `${CONTAINER}data`;
const PORT = Number(process.env.SYNAPSE_PG_PORT ?? 54329);
const IMAGE = process.env.SYNAPSE_PG_IMAGE ?? 'docker.io/library/postgres:17-alpine';
const DB = 'synapse';

/* ───────────── container engine ───────────── */

step('Finding Podman or Docker');
const candidates = process.env.CONTAINER_ENGINE ? [process.env.CONTAINER_ENGINE] : ['podman', 'docker'];
const ENGINE = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore', shell: win }).status === 0) ?? fail('Neither podman nor docker was found on PATH. Install Podman Desktop (or set CONTAINER_ENGINE).');
if (!eng(['info']).ok) {
  if (ENGINE === 'podman' && process.platform !== 'linux') {
    // Windows / macOS: Podman runs containers in a small VM ("machine")
    const machines = eng(['machine', 'list', '--format', '{{.Name}}']).out.split(/\r?\n/).filter(Boolean);
    if (!machines.length) {
      console.log('· no Podman machine yet: creating one (first time only, downloads a small VM image)');
      run('podman machine init', { display: 'podman machine init' });
    }
    console.log('· starting the Podman machine');
    spawnSync('podman', ['machine', 'start'], { stdio: 'inherit', shell: win });
    if (!eng(['info']).ok) fail('Podman is installed but not running. Open Podman Desktop and start the machine, then run `pnpm local` again.');
  } else fail(`${ENGINE} is installed but not responding (\`${ENGINE} info\` failed). Start it and try again.`);
}
console.log(`✓ using ${ENGINE}`);

/* ───────────── local passwords and keys (created once) ───────────── */

const LOCAL = join(ROOT, 'infra', '.local', 'local.json');
mkdirSync(dirname(LOCAL), { recursive: true });
if (args.has('--reset-db')) {
  step('Deleting the local database');
  eng(['rm', '-f', CONTAINER]);
  eng(['volume', 'rm', '-f', VOLUME]);
  if (existsSync(LOCAL)) {
    const l = JSON.parse(readFileSync(LOCAL, 'utf8'));
    delete l.PG_PASSWORD;
    delete l.APP_DB_PASSWORD;
    delete l.DEMO_ADMIN_PASSWORD;
    writeFileSync(LOCAL, JSON.stringify(l, null, 2));
  }
  console.log('✓ removed; a fresh database will be created');
}
/** @type {Record<string, string>} */
const local = existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, 'utf8')) : {};
const rnd = (n) => randomBytes(n).toString('base64url');
local.PG_PASSWORD ??= rnd(18);
local.APP_DB_PASSWORD ??= rnd(18);
local.JWT_SECRET ??= rnd(48);
local.DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
local.DEMO_ADMIN_PASSWORD ??= `Demo-${rnd(9)}!`;
if (!local.VAPID_PRIVATE_KEY) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = /** @type {any} */ (publicKey.export({ format: 'jwk' }));
  local.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
  local.VAPID_PRIVATE_KEY = /** @type {any} */ (privateKey.export({ format: 'jwk' })).d;
}
writeFileSync(LOCAL, JSON.stringify(local, null, 2));

/* ───────────── Postgres container ───────────── */

step(`Starting Postgres (${CONTAINER} on 127.0.0.1:${PORT})`);
const state = eng(['container', 'inspect', CONTAINER, '--format', '{{.State.Running}}']);
if (!state.ok) {
  const r = eng([
    'run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${local.PG_PASSWORD}`, '-e', `POSTGRES_DB=${DB}`, '-e', 'TZ=UTC',
    '-p', `127.0.0.1:${PORT}:5432`, '-v', `${VOLUME}:/var/lib/postgresql/data`,
    '--restart', 'unless-stopped',
    IMAGE,
  ]);
  if (!r.ok) fail(`could not start the database container:\n${r.out.split('\n').slice(-5).join('\n')}`);
  console.log(`✓ created (image ${IMAGE}, data in volume ${VOLUME})`);
} else if (state.out !== 'true') {
  if (!eng(['start', CONTAINER]).ok) fail(`could not start the ${CONTAINER} container`);
  console.log('✓ started');
} else console.log('✓ already running');

const ownerUrl = new URL(`postgres://postgres@127.0.0.1:${PORT}/${DB}`);
ownerUrl.password = local.PG_PASSWORD;
const appUrl = new URL(`postgres://synapse_app@127.0.0.1:${PORT}/${DB}`);
appUrl.password = local.APP_DB_PASSWORD;

// wait until Postgres accepts connections through the published port
let ready = false;
let lastErr = '';
for (let i = 0; i < 60 && !ready; i++) {
  const c = new pg.Client({ connectionString: ownerUrl.toString(), connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.query('select 1');
    ready = true;
  } catch (e) {
    lastErr = /** @type {Error} */ (e).message;
    await sleep(1000);
  } finally {
    await c.end().catch(() => undefined);
  }
}
if (!ready) {
  if (/password authentication failed/i.test(lastErr))
    fail('The database volume was created with another password (infra/.local/local.json was replaced?). Run `pnpm local --reset-db` to start fresh.');
  fail(`Postgres did not become ready: ${lastErr}`);
}
console.log('✓ accepting connections');

if (!args.has('--no-migrate')) {
  step('Applying database migrations (local database)');
  run('pnpm --filter @synapse/db migrate', { env: { DATABASE_URL_OWNER: ownerUrl.toString(), APP_DB_PASSWORD: local.APP_DB_PASSWORD }, display: 'migrate (local)' });
  step('Demo workspace (created once)');
  run('pnpm --filter @synapse/db seed', {
    env: { DATABASE_URL_OWNER: ownerUrl.toString(), SEED_TENANT_SLUG: 'demo', SEED_ADMIN_EMAIL: 'admin@demo.local', SEED_ADMIN_PASSWORD: local.DEMO_ADMIN_PASSWORD, BASE_DOMAIN: 'localhost' },
    display: 'seed',
  });
}

/* ───────────── API configuration ───────────── */

step('Writing apps/api/.dev.vars (git-ignored)');
const vars = {
  DATABASE_URL: appUrl.toString(),
  JWT_SECRET: local.JWT_SECRET,
  DATA_ENCRYPTION_KEY: local.DATA_ENCRYPTION_KEY,
  VAPID_PUBLIC_KEY: local.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: local.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: 'mailto:info@hrpai.in',
  // optional: only if set in this terminal (these call the providers' APIs)
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  MS_CLIENT_ID: process.env.MS_CLIENT_ID ?? '',
  MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET ?? '',
  ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID ?? '',
  ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET ?? '',
  GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
  GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG ?? '',
  GITHUB_APP_PRIVATE_KEY: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET ?? '',
  META_APP_ID: process.env.META_APP_ID ?? '',
  META_APP_SECRET: process.env.META_APP_SECRET ?? '',
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN ?? '',
  // GST portal, e-invoice and e-way bill (WhiteBooks GSP): from .env or the terminal
  ...Object.fromEntries(WHITEBOOKS_KEYS.map((k) => [k, process.env[k] ?? ''])),
};
writeFileSync(
  join(ROOT, 'apps', 'api', '.dev.vars'),
  `# generated by scripts/local/local-dev.mjs — points at the LOCAL Postgres container\n${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
);
console.log('✓ done');

step('Checking installed packages');
run('pnpm install --frozen-lockfile --prefer-offline', { display: 'pnpm install' });

if (!args.has('--no-build')) {
  step('Building the web app (served at http://localhost:8787 with offline mode and push)');
  run('pnpm --filter @synapse/web build');
}

freePorts([8787, 5173]);

step('Starting the API (wrangler dev, local only) and the UI (Vite)');
const quiet = /** @type {import('node:child_process').StdioOptions} */ (['ignore', 'inherit', 'inherit']);
const procs = [
  spawn(`pnpm exec wrangler dev -c wrangler.local.jsonc --port 8787 --ip 127.0.0.1 --test-scheduled --show-interactive-dev-session=false`, {
    cwd: join(ROOT, 'apps', 'api'),
    stdio: quiet,
    shell: true,
  }),
  spawn(`pnpm exec vite --port 5173 --strictPort`, { cwd: join(ROOT, 'apps', 'web'), stdio: quiet, shell: true }),
];
// the cloud runs the 5-minute sweep on a schedule; locally this does it (reminders, mailboxes, GeM alerts)
const sweep = setInterval(() => {
  fetch('http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*').catch(() => undefined);
}, 5 * 60_000);
sweep.unref?.();
// the USB-token DSC signer, in the background (never holds up the app)
const signer = startDscSigner({ skip: args.has('--no-signer') });
setTimeout(() => {
  console.log(`
\x1b[32m✓ HRP Synapse is running fully on this computer (database: local ${ENGINE} container)\x1b[0m

  UI (instant reload)        http://localhost:5173
  Built app (PWA, push)      http://localhost:8787
  Sign in                    workspace demo · admin@demo.local
                             password: DEMO_ADMIN_PASSWORD in infra/.local/local.json
                             (or create a new workspace from the sign-up page)

  Database                   127.0.0.1:${PORT}, database ${DB} (owner "postgres"; password PG_PASSWORD in infra/.local/local.json)
  Run the 5-minute sweep     http://localhost:8787/__scheduled?cron=*/5+*+*+*+*
  Run the daily job          http://localhost:8787/__scheduled?cron=17+3+*+*+*

  Ctrl+C stops the app (the database keeps running; \`pnpm local:stop --db\` stops it).
`);
}, 8000);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  signer.stop();
  for (const p of procs) {
    if (win && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGINT');
  }
  freePorts([8787, 5173]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && console.error(`a process exited with code ${code}`));
