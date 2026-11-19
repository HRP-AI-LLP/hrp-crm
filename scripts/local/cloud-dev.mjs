// @ts-check
/**
 * Run HRP Synapse on this computer against the cloud DEV environment — no GitHub Actions needed.
 * (For a fully local setup with Postgres in Podman/Docker, use `pnpm local`.)
 *
 *   pnpm local:cloud               migrate the Neon "dev" branch, build the app, start API + UI
 *   pnpm local:cloud --no-migrate  skip the migration step
 *   pnpm local:cloud --no-build    skip the production build of the web app (faster restarts)
 *
 * What runs where:
 *   - Database: the Neon `dev` branch in the cloud (the same data as hrpsynapse-dev.hrpai.in)
 *   - Workers AI + Vectorize (synapse-kb-dev): Cloudflare, through wrangler remote bindings
 *   - API (Worker code): on this computer with `wrangler dev`  → http://localhost:8787
 *     (also serves the built app, with the service worker, push and offline mode)
 *   - UI with instant reload: Vite                           → http://localhost:5173
 *   - KV cache, queue and R2 files: simulated locally by wrangler (nothing shared with prod)
 *
 * Production is never touched: only the dev branch is migrated, nothing is deployed or pushed.
 *
 * Needs in the environment (already set for `pnpm setup`): NEON_API_KEY, CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID. Secrets are read from infra/.local/secrets.json and written only to
 * apps/api/.dev.vars (git-ignored); nothing secret is printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@neondatabase/api-client';
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

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { cwd: opts.cwd ?? ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0) fail(`${opts.display ?? cmd} failed`);
}

const SECRETS = join(ROOT, 'infra', '.local', 'secrets.json');
const STATE = join(ROOT, 'infra', 'state.json');
if (!existsSync(SECRETS)) fail('infra/.local/secrets.json is missing — run `pnpm setup` once on this computer first.');
if (!existsSync(STATE)) fail('infra/state.json is missing.');
const NEON_API_KEY = process.env.NEON_API_KEY;
if (!NEON_API_KEY) fail('Set NEON_API_KEY in this terminal first.');
if (!process.env.CLOUDFLARE_API_TOKEN) console.warn('! CLOUDFLARE_API_TOKEN is not set: AI and knowledge-base search will be unavailable (wrangler needs it for remote bindings).');

const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'));
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const dev = secrets.dev ?? fail('No "dev" entry in secrets.json');
if (!dev.APP_DB_PASSWORD || !dev.JWT_SECRET || !dev.DATA_ENCRYPTION_KEY) fail('secrets.json is missing dev database or key material — run `pnpm setup` once.');

// Web Push keys: reuse the dev pair, or create it once (the next `pnpm setup` deploy uploads the same pair)
if (!dev.VAPID_PRIVATE_KEY) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = /** @type {any} */ (publicKey.export({ format: 'jwk' }));
  dev.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
  dev.VAPID_PRIVATE_KEY = /** @type {any} */ (privateKey.export({ format: 'jwk' })).d;
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));
  console.log('✓ created a Web Push key pair for dev (kept in infra/.local/secrets.json)');
}

// packages added since the last install (e.g. after copying in new code) — quick no-op when up to date
step('Checking installed packages');
run('pnpm install --frozen-lockfile --prefer-offline', { display: 'pnpm install' });

step('Connecting to the Neon dev branch');
const neon = createApiClient({ apiKey: NEON_API_KEY });
const projectId = state.neon?.projectId;
const branchId = state.neon?.branches?.dev;
if (!projectId || !branchId) fail('infra/state.json has no Neon project or dev branch');
const dbName = process.env.NEON_DB_NAME ?? 'neondb';
const ownerRole = process.env.NEON_OWNER_ROLE ?? 'neondb_owner';
/** @param {boolean} pooled */
const uri = async (pooled) => {
  const u = new URL((await neon.getConnectionUri({ projectId, branch_id: branchId, database_name: dbName, role_name: ownerRole, pooled })).data.uri);
  u.searchParams.set('sslmode', 'verify-full');
  return u;
};
/** @type {URL} */
const owner = await uri(false).catch((e) => fail(`Neon API: ${e?.response?.data?.message ?? e.message}`));
const app = await uri(true);
app.username = 'synapse_app';
app.password = dev.APP_DB_PASSWORD;
console.log(`✓ dev branch ${branchId} (${app.hostname})`);

if (!args.has('--no-migrate')) {
  step('Applying database migrations to the dev branch only');
  run('pnpm --filter @synapse/db migrate', { env: { DATABASE_URL_OWNER: owner.toString() }, display: 'migrate (dev branch)' });
}

step('Writing apps/api/.dev.vars (git-ignored)');
const vars = {
  DATABASE_URL: app.toString(),
  // same keys as the deployed dev Worker: existing sessions, encrypted AI keys and channel secrets keep working
  JWT_SECRET: dev.JWT_SECRET,
  DATA_ENCRYPTION_KEY: dev.DATA_ENCRYPTION_KEY,
  VAPID_PUBLIC_KEY: dev.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: dev.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: 'mailto:info@hrpai.in',
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  // integrations (optional): your OAuth apps; add http://localhost:5173 and :8787 callback URLs in each console
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  MS_CLIENT_ID: process.env.MS_CLIENT_ID ?? '',
  MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET ?? '',
  ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID ?? '',
  ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET ?? '',
  META_APP_ID: process.env.META_APP_ID ?? '',
  META_APP_SECRET: process.env.META_APP_SECRET ?? '',
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN ?? '',
  // GST portal, e-invoice and e-way bill (WhiteBooks GSP): from .env or the terminal
  ...Object.fromEntries(WHITEBOOKS_KEYS.map((k) => [k, process.env[k] ?? ''])),
};
writeFileSync(
  join(ROOT, 'apps', 'api', '.dev.vars'),
  `# generated by scripts/local/cloud-dev.mjs — points at the Neon DEV branch\n${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
);
console.log('✓ done');

if (!args.has('--no-build')) {
  step('Building the web app (served at http://localhost:8787 with offline mode and push)');
  run('pnpm --filter @synapse/web build');
}

// a previous run that did not shut down cleanly would keep the ports busy
freePorts([8787, 5173]);

step('Starting the API (wrangler dev) and the UI (Vite)');
// the children get no keyboard: wrangler's and Vite's hotkeys put the terminal in raw mode and
// swallow Ctrl+C. Ctrl+C now reaches this script, which stops both.
const quiet = /** @type {import('node:child_process').StdioOptions} */ (['ignore', 'inherit', 'inherit']);
const procs = [
  spawn(`pnpm exec wrangler dev --port 8787 --ip 127.0.0.1 --test-scheduled --show-interactive-dev-session=false`, { cwd: join(ROOT, 'apps', 'api'), stdio: quiet, shell: true }),
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
\x1b[32m✓ HRP Synapse is running against the cloud DEV database\x1b[0m

  UI (instant reload)        http://localhost:5173
  Built app (PWA, push)      http://localhost:8787
  Sign in with workspace     demo   (or any dev workspace slug)

  Run the 5-minute reminder sweep:  http://localhost:8787/__scheduled?cron=*/5+*+*+*+*
  Run the daily job (backups etc.):  http://localhost:8787/__scheduled?cron=17+3+*+*+*

  Ctrl+C stops both.
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
