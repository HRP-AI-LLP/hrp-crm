// @ts-check
/**
 * HRP Synapse — one-shot, idempotent infrastructure provisioning.
 *
 * Reads credentials from the environment (never from files, never printed):
 *   NEON_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID         (required)
 *   BASE_DOMAIN        e.g. hrpsynapse.com — only if that zone is on your Cloudflare account
 *   NEON_ORG_ID        if your Neon account has several organisations
 *   NEON_PROJECT_NAME  default "hrp-synapse"
 *   NEON_REGION        default "aws-ap-southeast-1" (Singapore — lowest latency to India)
 *   GROQ_API_KEY, GEMINI_API_KEY   optional AI fallbacks, stored as Worker secrets
 *   SEED_DEMO          "false" to skip the demo workspace on dev
 *   SKIP_DEPLOY        "true" to provision without deploying
 *
 * Re-running is safe: every resource is looked up by name before being created. Generated
 * secrets (DB passwords, JWT keys) are kept in infra/.local/secrets.json (git-ignored) so reruns
 * don't rotate them by accident. Delete that file to rotate.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient, EndpointType } from '@neondatabase/api-client';
import Cloudflare from 'cloudflare';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INFRA = join(ROOT, 'infra');
const LOCAL = join(INFRA, '.local');
const STATE_FILE = join(INFRA, 'state.json');
const SECRETS_FILE = join(LOCAL, 'secrets.json');
const ENVS = /** @type {const} */ (['dev', 'prod']);

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.bold('▸ ' + s)}`);
const info = (s) => console.log(`  ${s}`);

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(c.err(`Missing environment variable ${name}.`));
    console.error(`In PowerShell:  $env:${name}="..."   then run  pnpm run setup  again.`);
    process.exit(1);
  }
  return v;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Runs a shell command, streaming output. Works on Windows (pnpm.cmd) and Unix. */
function run(cmd, opts = {}) {
  info(c.dim(`$ ${opts.display ?? cmd}`));
  const r = spawnSync(cmd, { shell: true, stdio: opts.capture ? 'pipe' : 'inherit', cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, encoding: 'utf8', input: opts.input });
  if (r.status !== 0 && !opts.allowFail) {
    if (opts.capture) console.error(r.stdout, r.stderr);
    throw new Error(`Command failed (${r.status}): ${opts.display ?? cmd}`);
  }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDb(url) {
  for (let i = 1; i <= 20; i++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return;
    } catch (e) {
      await client.end().catch(() => undefined);
      if (i === 20) throw e;
      info(c.dim(`database not ready yet (${/** @type {Error} */ (e).message}); retrying…`));
      await sleep(3000);
    }
  }
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const NEON_API_KEY = need('NEON_API_KEY');
  const CF_TOKEN = need('CLOUDFLARE_API_TOKEN');
  const CF_ACCOUNT = need('CLOUDFLARE_ACCOUNT_ID');
  const projectName = process.env.NEON_PROJECT_NAME ?? 'hrp-synapse';
  const region = process.env.NEON_REGION ?? 'aws-ap-southeast-1';
  const baseDomain = (process.env.BASE_DOMAIN ?? '').trim().toLowerCase();
  const dbName = process.env.NEON_DB_NAME ?? 'neondb';
  const ownerRole = process.env.NEON_OWNER_ROLE ?? 'neondb_owner';

  const state = readJson(STATE_FILE, { neon: {}, cloudflare: { dev: {}, prod: {} } });
  const secrets = readJson(SECRETS_FILE, {});
  for (const env of ENVS) {
    secrets[env] ??= {};
    secrets[env].APP_DB_PASSWORD ??= secret(24);
    secrets[env].JWT_SECRET ??= secret(48);
    secrets[env].DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  }
  writeJson(SECRETS_FILE, secrets);

  // ----------------------------------------------------------------------------------- Neon
  step('Neon Postgres');
  const neon = createApiClient({ apiKey: NEON_API_KEY });
  let orgId = process.env.NEON_ORG_ID;
  if (!orgId) {
    try {
      const orgs = (await neon.getCurrentUserOrganizations()).data.organizations ?? [];
      if (orgs.length === 1) orgId = orgs[0]?.id;
      else if (orgs.length > 1) {
        console.error(c.err('Your Neon account belongs to several organisations. Set $env:NEON_ORG_ID to one of:'));
        for (const o of orgs) console.error(`  ${o.id}  ${o.name}`);
        process.exit(1);
      }
    } catch {
      /* personal account without orgs */
    }
  }

  let projectId = state.neon.projectId;
  if (projectId) {
    try {
      await neon.getProject(projectId);
    } catch {
      projectId = undefined;
    }
  }
  if (!projectId) {
    const list = (await neon.listProjects({ search: projectName, limit: 50, ...(orgId ? { org_id: orgId } : {}) })).data.projects;
    projectId = list.find((p) => p.name === projectName)?.id;
  }
  if (!projectId) {
    info(`creating project "${projectName}" in ${region}`);
    const created = (
      await neon.createProject({
        project: { name: projectName, region_id: region, pg_version: 17, branch: { name: 'main', database_name: dbName, role_name: ownerRole }, ...(orgId ? { org_id: orgId } : {}) },
      })
    ).data;
    projectId = created.project.id;
  } else info(`using existing project ${projectId}`);
  state.neon.projectId = projectId;

  const branches = (await neon.listProjectBranches({ projectId })).data.branches;
  const main = branches.find((b) => b.default) ?? branches.find((b) => b.name === 'main');
  if (!main) throw new Error('Could not find the default Neon branch');
  state.neon.branches = { prod: main.id };

  const ownerUrl = async (branchId) =>
    (await neon.getConnectionUri({ projectId, branch_id: branchId, database_name: dbName, role_name: ownerRole, pooled: false })).data.uri;

  // prod (main branch) first, so the dev branch inherits the schema
  const prodOwner = await ownerUrl(main.id);
  await waitForDb(prodOwner);
  step('Migrating production database (branch main)');
  run('pnpm --filter @synapse/db migrate', { env: { DATABASE_URL_OWNER: prodOwner, APP_DB_PASSWORD: secrets.prod.APP_DB_PASSWORD }, display: 'pnpm --filter @synapse/db migrate  (prod)' });

  let dev = branches.find((b) => b.name === 'dev');
  if (!dev) {
    info('creating branch "dev" from main');
    dev = (await neon.createProjectBranch(projectId, { branch: { name: 'dev', parent_id: main.id }, endpoints: [{ type: EndpointType.ReadWrite }] })).data.branch;
  }
  state.neon.branches.dev = dev.id;
  const devOwner = await ownerUrl(dev.id);
  await waitForDb(devOwner);
  step('Migrating dev database (branch dev)');
  run('pnpm --filter @synapse/db migrate', { env: { DATABASE_URL_OWNER: devOwner, APP_DB_PASSWORD: secrets.dev.APP_DB_PASSWORD }, display: 'pnpm --filter @synapse/db migrate  (dev)' });
  writeJson(STATE_FILE, state);

  // ----------------------------------------------------------------------------- Cloudflare
  step('Cloudflare resources');
  const cf = new Cloudflare({ apiToken: CF_TOKEN });
  const account_id = CF_ACCOUNT;

  const kvList = [];
  for await (const ns of cf.kv.namespaces.list({ account_id, per_page: 100 })) kvList.push(ns);
  const queueList = [];
  for await (const q of cf.queues.list({ account_id })) queueList.push(q);
  const hdList = [];
  for await (const h of cf.hyperdrive.configs.list({ account_id })) hdList.push(h);
  const vecList = [];
  for await (const v of cf.vectorize.indexes.list({ account_id })) vecList.push(v);

  for (const env of ENVS) {
    const s = (state.cloudflare[env] ??= {});
    const branchId = env === 'prod' ? main.id : dev.id;

    const kvTitle = `synapse-cache-${env}`;
    s.kvId = kvList.find((n) => n.title === kvTitle)?.id ?? (await cf.kv.namespaces.create({ account_id, title: kvTitle })).id;
    info(`${c.ok('✓')} KV ${kvTitle}`);

    for (const qn of [`synapse-jobs-${env}`, `synapse-jobs-dlq-${env}`]) {
      if (!queueList.some((q) => q.queue_name === qn)) await cf.queues.create({ account_id, queue_name: qn });
      info(`${c.ok('✓')} Queue ${qn}`);
    }

    const vecName = `synapse-kb-${env}`;
    if (!vecList.some((v) => v.name === vecName)) {
      await cf.vectorize.indexes.create({ account_id, name: vecName, config: { dimensions: 1024, metric: 'cosine' }, description: 'HRP Synapse knowledge base (bge-m3). Namespace = tenant id.' });
    }
    info(`${c.ok('✓')} Vectorize ${vecName}`);

    // Hyperdrive → Neon *direct* endpoint as the least-privilege runtime role, caching DISABLED
    const owner = new URL(await ownerUrl(branchId));
    const origin = { host: owner.hostname, port: 5432, database: dbName, user: 'synapse_app', password: secrets[env].APP_DB_PASSWORD, scheme: /** @type {'postgres'} */ ('postgres') };
    const hdName = `synapse-${env}`;
    const existing = hdList.find((h) => h.name === hdName);
    if (existing) {
      await cf.hyperdrive.configs.update(existing.id, { account_id, name: hdName, origin, caching: { disabled: true } });
      s.hyperdriveId = existing.id;
    } else {
      s.hyperdriveId = (await cf.hyperdrive.configs.create({ account_id, name: hdName, origin, caching: { disabled: true } })).id;
    }
    info(`${c.ok('✓')} Hyperdrive ${hdName} (query cache disabled for tenant safety)`);
  }

  // custom domain (only if the zone lives on this Cloudflare account)
  let zoneFound = false;
  if (baseDomain) {
    for await (const z of cf.zones.list({ name: baseDomain, account: { id: account_id } })) if (z.name === baseDomain) zoneFound = true;
    info(zoneFound ? `${c.ok('✓')} Zone ${baseDomain} found — production will serve *.${baseDomain}` : c.warn(`Zone ${baseDomain} is not on this Cloudflare account — production stays on workers.dev for now`));
  }
  state.baseDomain = zoneFound ? baseDomain : '';
  writeJson(STATE_FILE, state);

  // --------------------------------------------------------------------------- wrangler.jsonc
  step('Rendering apps/api/wrangler.jsonc');
  const tpl = readFileSync(join(ROOT, 'apps/api/wrangler.template.jsonc'), 'utf8');
  const routes = zoneFound ? `"routes": [{ "pattern": "*.${baseDomain}/*", "zone_name": "${baseDomain}" }],` : '// no custom domain yet: set BASE_DOMAIN and re-run setup';
  const rendered = tpl
    .replace(/^\/\/ HRP Synapse gateway Worker — TEMPLATE\.\n(\/\/.*\n){2}/m, '// HRP Synapse gateway Worker — GENERATED by `pnpm run setup` from wrangler.template.jsonc.\n// Resource IDs are not secrets; commit this file so CI can deploy.\n')
    .replaceAll('__DEV_HYPERDRIVE_ID__', state.cloudflare.dev.hyperdriveId)
    .replaceAll('__PROD_HYPERDRIVE_ID__', state.cloudflare.prod.hyperdriveId)
    .replaceAll('__DEV_KV_ID__', state.cloudflare.dev.kvId)
    .replaceAll('__PROD_KV_ID__', state.cloudflare.prod.kvId)
    .replaceAll('__DEV_BASE_DOMAIN__', '')
    .replaceAll('__PROD_BASE_DOMAIN__', state.baseDomain)
    .replace('// __PROD_ROUTES__', routes);
  writeFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), rendered);
  info(`${c.ok('✓')} written`);

  // local dev vars (dev branch, pooled endpoint, runtime role)
  const devPooled = new URL((await neon.getConnectionUri({ projectId, branch_id: dev.id, database_name: dbName, role_name: ownerRole, pooled: true })).data.uri);
  devPooled.username = 'synapse_app';
  devPooled.password = secrets.dev.APP_DB_PASSWORD;
  const devVars = join(ROOT, 'apps/api/.dev.vars');
  if (!existsSync(devVars)) {
    writeFileSync(devVars, [`DATABASE_URL=${devPooled.toString()}`, `JWT_SECRET=${secret(48)}`, `DATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`, `GROQ_API_KEY=${process.env.GROQ_API_KEY ?? ''}`, `GEMINI_API_KEY=${process.env.GEMINI_API_KEY ?? ''}`, ''].join('\n'));
    info(`${c.ok('✓')} apps/api/.dev.vars for local development (git-ignored)`);
  }

  // ------------------------------------------------------------------------------ deploy
  if (process.env.SKIP_DEPLOY !== 'true') {
    step('Building the web app');
    run('pnpm --filter @synapse/web build');
    for (const env of ENVS) {
      const wenv = env === 'prod' ? 'production' : 'dev';
      step(`Deploying Worker (${wenv})`);
      run(`pnpm --filter @synapse/api exec wrangler deploy --env ${wenv}`);
      const bulk = { JWT_SECRET: secrets[env].JWT_SECRET, DATA_ENCRYPTION_KEY: secrets[env].DATA_ENCRYPTION_KEY };
      if (process.env.GROQ_API_KEY) bulk.GROQ_API_KEY = process.env.GROQ_API_KEY;
      if (process.env.GEMINI_API_KEY) bulk.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      const tmp = join(LOCAL, `secrets-${env}.tmp.json`);
      writeJson(tmp, bulk);
      try {
        run(`pnpm --filter @synapse/api exec wrangler secret bulk "${tmp}" --env ${wenv}`, { display: `wrangler secret bulk <generated> --env ${wenv}` });
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }

  // ------------------------------------------------------------------------------- seed
  if (process.env.SEED_DEMO !== 'false') {
    step('Seeding a demo workspace on dev');
    secrets.dev.DEMO_ADMIN_PASSWORD ??= `Demo-${secret(9)}!`;
    writeJson(SECRETS_FILE, secrets);
    run('pnpm --filter @synapse/db seed', { env: { DATABASE_URL_OWNER: devOwner, SEED_ADMIN_PASSWORD: secrets.dev.DEMO_ADMIN_PASSWORD, SEED_ADMIN_EMAIL: 'admin@demo.hrpsynapse.local' }, display: 'pnpm --filter @synapse/db seed  (dev)' });
  }

  // ------------------------------------------------------------------------------ GitHub
  step('GitHub Actions secrets');
  const gh = spawnSync('gh auth status', { shell: true, stdio: 'pipe', cwd: ROOT });
  const hasRemote = spawnSync('git remote get-url origin', { shell: true, stdio: 'pipe', cwd: ROOT }).status === 0;
  if (gh.status === 0 && hasRemote) {
    for (const [k, v] of [['NEON_API_KEY', NEON_API_KEY], ['CLOUDFLARE_API_TOKEN', CF_TOKEN], ['CLOUDFLARE_ACCOUNT_ID', CF_ACCOUNT]]) {
      run(`gh secret set ${k}`, { input: v, capture: true, display: `gh secret set ${k} <hidden>` });
    }
    run(`gh variable set NEON_PROJECT_ID --body ${projectId}`);
    info(`${c.ok('✓')} repository secrets set`);
  } else {
    info(c.warn('GitHub CLI not logged in or no git remote yet. After pushing the repo, add these repository secrets'));
    info(c.warn('(Settings → Secrets and variables → Actions): NEON_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID'));
    info(c.warn(`and the repository variable NEON_PROJECT_ID = ${projectId}`));
  }

  writeJson(STATE_FILE, state);
  step('Done');
  info(`Neon project:  ${projectId}  (branches: main → prod, dev → dev)`);
  info(`Dev app:       https://synapse-dev.<your-workers-subdomain>.workers.dev  (see the deploy output above)`);
  if (process.env.SEED_DEMO !== 'false') {
    info(`Demo sign-in:  workspace "demo", admin@demo.hrpsynapse.local, password in infra/.local/secrets.json (dev.DEMO_ADMIN_PASSWORD)`);
  }
  info(state.baseDomain ? `Production:    https://<workspace>.${state.baseDomain}` : c.warn('Production needs a domain on Cloudflare to route workspaces: set $env:BASE_DOMAIN and re-run.'));
  info('Commit apps/api/wrangler.jsonc and infra/state.json (no secrets inside), then push dev/prod branches.');
}

main().catch((e) => {
  console.error(c.err(`\nSetup failed: ${e?.message ?? e}`));
  if (e?.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
