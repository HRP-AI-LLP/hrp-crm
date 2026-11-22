// @ts-check
/**
 * SanchalanOS — one-shot, idempotent infrastructure provisioning.
 *
 * Reads credentials from the environment (never from files, never printed):
 *   NEON_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID         (required)
 *   ZONE_NAME          Cloudflare zone that hosts the app, default "hrpai.in"
 *   PROD_APP_HOST      default "www.sanchalan.hrpai.in" (the bare sanchalan.hrpai.in redirects to it)
 *   CF_TENANT_DOMAINS_TOKEN  optional: lets the app give each workspace <slug>.sanchalan.hrpai.in
 *   NEON_ORG_ID        if your Neon account has several organisations
 *   NEON_PROJECT_NAME  default "hrp-synapse" (the existing project is kept)
 *   NEON_REGION        default "aws-ap-southeast-1" (Singapore — lowest latency to India)
 *   GROQ_API_KEY, GEMINI_API_KEY   optional AI fallbacks, stored as Worker secrets
 *   RESEND_API_KEY           optional: emails invitations and password resets (resend.com free tier)
 *   GOOGLE_CLIENT_ID/SECRET, MS_CLIENT_ID/SECRET, META_APP_ID/SECRET, META_VERIFY_TOKEN, FCM_SERVICE_ACCOUNT (JSON)
 *                            optional: Gmail/Outlook sync and Facebook lead ads (docs/INTEGRATIONS.md)
 *   SKIP_DEPLOY        "true" to provision without deploying
 *   REMOVE_OLD         "true" to delete the old cloud "dev" environment (Neon branch dev,
 *                      Hyperdrive/KV/queues/worker synapse-dev). The old worker synapse-prod is
 *                      always removed: "sanchalanos" takes over its queue.
 *
 * Run it as  pnpm run setup  (or pnpm cloud:setup). Plain `pnpm setup` is pnpm's own command (it only edits PATH).
 *
 * Environments: dev runs on this computer (`pnpm local`); prod runs on Cloudflare + Neon.
 *
 * Re-running is safe: every resource is looked up by name before being created. Generated
 * secrets (DB passwords, JWT keys) are kept in infra/.local/secrets.json (git-ignored) so reruns
 * don't rotate them by accident. Delete that file to rotate.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@neondatabase/api-client';
import Cloudflare from 'cloudflare';
import pg from 'pg';

/** P-256 key pair in the base64url shapes Web Push expects (65-byte public point, 32-byte private scalar). */
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(String(pub.x), 'base64url'), Buffer.from(String(pub.y), 'base64url')]);
  return { VAPID_PUBLIC_KEY: point.toString('base64url'), VAPID_PRIVATE_KEY: String(priv.d) };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INFRA = join(ROOT, 'infra');
const LOCAL = join(INFRA, '.local');
const STATE_FILE = join(INFRA, 'state.json');
const SECRETS_FILE = join(LOCAL, 'secrets.json');

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.bold('▸ ' + s)}`);
const info = (s) => console.log(`  ${s}`);

function need(name) {
  // tolerate stray whitespace / quotes from copy-paste ("abc" or 'abc' or a trailing newline)
  const v = (process.env[name] ?? '').trim().replace(/^["']|["']$/g, '').trim();
  if (!v) {
    console.error(c.err(`Missing environment variable ${name}.`));
    console.error(`In PowerShell:  $env:${name}="..."   then run  pnpm cloud:setup  again.`);
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
// Cloudflare preflight: pinpoints token / account / permission problems before anything is created
// ---------------------------------------------------------------------------------------------
async function cfGet(token, path) {
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` } });
    /** @type {any} */ let j = {};
    try {
      j = await r.json();
    } catch {
      /* non-JSON */
    }
    return { status: r.status, ok: r.ok && j.success !== false, errors: j.errors ?? [], result: j.result };
  } catch (e) {
    return { status: 0, ok: false, errors: [{ message: /** @type {Error} */ (e).message }], result: null };
  }
}

async function cloudflarePreflight(token, accountId, zoneName) {
  step('Checking the Cloudflare token');
  const fmtErr = (r) => `${r.status} ${r.errors.map((e) => `${e.code ?? ''} ${e.message}`.trim()).join('; ')}`;

  // 1. is the token itself valid? (user-owned and account-owned tokens use different verify endpoints)
  let verify = await cfGet(token, '/user/tokens/verify');
  if (!verify.ok) verify = await cfGet(token, `/accounts/${accountId}/tokens/verify`);
  if (!verify.ok || (verify.result && verify.result.status && verify.result.status !== 'active')) {
    console.error(c.err(`\nCloudflare does not accept this API token (${fmtErr(verify)}).`));
    console.error(`  Token length seen by the script: ${token.length} characters.`);
    console.error('  Common causes:');
    console.error('   • The Global API Key or the token *ID* was copied instead of the token value shown once after "Create Token".');
    console.error('   • The token was rolled/deleted, has expired, or has "Client IP Address Filtering" that excludes this network.');
    console.error('   • Extra characters were pasted. Re-copy the token, then in this terminal run:');
    console.error('       $env:CLOUDFLARE_API_TOKEN = (Get-Clipboard).Trim()');
    console.error('  Quick check:  curl.exe -s -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify');
    process.exit(1);
  }
  info(`${c.ok('✓')} token is valid and active`);

  // 2. can it see this account?
  const acct = await cfGet(token, `/accounts/${accountId}`);
  if (!acct.ok) {
    console.error(c.err(`\nThe token is valid but cannot access account ${accountId} (${fmtErr(acct)}).`));
    console.error('  • Check $env:CLOUDFLARE_ACCOUNT_ID: dashboard → Account home → ⋯ next to the account → Copy account ID (32 hex characters).');
    console.error('  • In the token settings, "Account Resources" must include this account, and it needs "Account Settings: Read".');
    process.exit(1);
  }
  info(`${c.ok('✓')} account "${acct.result?.name ?? accountId}"`);

  // 3. per-permission probes (a successful read means the permission group is on the token)
  const checks = [
    ['Account · Workers Scripts', `/accounts/${accountId}/workers/scripts`],
    ['Account · Workers KV Storage', `/accounts/${accountId}/storage/kv/namespaces?per_page=5`],
    ['Account · Queues', `/accounts/${accountId}/queues`],
    ['Account · Hyperdrive', `/accounts/${accountId}/hyperdrive/configs`],
    ['Account · Vectorize', `/accounts/${accountId}/vectorize/v2/indexes`],
  ];
  const missing = [];
  for (const [label, path] of checks) {
    const r = await cfGet(token, path);
    info(`${r.ok ? c.ok('✓') : c.err('✗')} ${label}${r.ok ? '' : `  (${fmtErr(r)})`}`);
    if (!r.ok) missing.push(`${label} – Edit`);
  }
  const zones = await cfGet(token, `/zones?name=${encodeURIComponent(zoneName)}&account.id=${accountId}`);
  const zone = zones.ok && Array.isArray(zones.result) ? zones.result.find((z) => z.name === zoneName) : null;
  if (!zone) {
    info(`${c.err('✗')} Zone · ${zoneName}  (${zones.ok ? 'not visible to this token — add the zone under "Zone Resources" or add the site to this account' : fmtErr(zones)})`);
    missing.push(`Zone · Zone – Read (for ${zoneName})`);
  } else {
    info(`${c.ok('✓')} Zone · ${zoneName} (${zone.status})`);
    for (const [label, path] of [
      ['Zone · DNS', `/zones/${zone.id}/dns_records?per_page=1`],
      ['Zone · Workers Routes', `/zones/${zone.id}/workers/routes`],
    ]) {
      const r = await cfGet(token, path);
      info(`${r.ok ? c.ok('✓') : c.err('✗')} ${label}${r.ok ? '' : `  (${fmtErr(r)})`}`);
      if (!r.ok) missing.push(`${label} – Edit`);
    }
  }
  if (missing.length) {
    console.error(c.err('\nThe token is missing these permissions. Edit the token in Cloudflare (My Profile → API Tokens → Edit) and add:'));
    for (const m of missing) console.error(`   • ${m}`);
    console.error('  Also needed (not testable by reading): Account Settings – Read, SSL and Certificates – Edit on the zone.');
    console.error('  Saving the edited token keeps the same value, so just run setup again.');
    process.exit(1);
  }
  info(c.dim('Read access confirmed. Make sure each permission is set to "Edit", not "Read".'));
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const NEON_API_KEY = need('NEON_API_KEY');
  const CF_TOKEN = need('CLOUDFLARE_API_TOKEN');
  const CF_ACCOUNT = need('CLOUDFLARE_ACCOUNT_ID');
  const projectName = process.env.NEON_PROJECT_NAME ?? 'hrp-synapse';
  const region = process.env.NEON_REGION ?? 'aws-ap-southeast-1';
  const zoneName = (process.env.ZONE_NAME ?? 'hrpai.in').trim().toLowerCase();
  const appHost = (process.env.PROD_APP_HOST ?? 'www.sanchalan.hrpai.in').trim().toLowerCase();
  // www.<x> is the app; <x> redirects to it and is the parent of per-workspace <slug>.<x> addresses
  const baseDomain = appHost.replace(/^www\./, '');
  const hosts = [...new Set([appHost, baseDomain])];
  for (const h of hosts) {
    if (!h.endsWith(`.${zoneName}`)) {
      console.error(c.err(`${h} is not inside the zone ${zoneName}. Set $env:ZONE_NAME to the domain on your Cloudflare account.`));
      process.exit(1);
    }
  }
  const dbName = process.env.NEON_DB_NAME ?? 'neondb';
  const ownerRole = process.env.NEON_OWNER_ROLE ?? 'neondb_owner';
  const removeOld = process.env.REMOVE_OLD === 'true';

  await cloudflarePreflight(CF_TOKEN, CF_ACCOUNT, zoneName);

  const state = readJson(STATE_FILE, { neon: {}, cloudflare: { prod: {} } });
  state.cloudflare ??= {};
  const secrets = readJson(SECRETS_FILE, {});
  secrets.prod ??= {};
  secrets.prod.APP_DB_PASSWORD ??= secret(24);
  secrets.prod.JWT_SECRET ??= secret(48);
  secrets.prod.DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  // Web Push (installable app): one VAPID key pair, generated once and kept
  if (!secrets.prod.VAPID_PRIVATE_KEY) Object.assign(secrets.prod, vapidKeys());
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

  // the smallest compute, never larger than 1 CU, asleep after 5 idle minutes
  // (free plan: 100 CU-hours a month; 0.25 CU ≈ 400 awake hours)
  try {
    const eps = (await neon.listProjectBranchEndpoints(projectId, main.id)).data.endpoints;
    for (const ep of eps) {
      await neon.updateProjectEndpoint(projectId, ep.id, { endpoint: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 1, suspend_timeout_seconds: 300 } }).catch(() =>
        neon.updateProjectEndpoint(projectId, ep.id, { endpoint: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 1 } }),
      );
    }
    info(`${c.ok('✓')} compute 0.25–1 CU, sleeps after 5 idle minutes`);
  } catch (e) {
    info(c.warn(`could not adjust the compute size (${/** @type {Error} */ (e).message}); the plan's defaults stay`));
  }

  // Neon returns sslmode=require; pg treats that as verify-full anyway, so say so explicitly (silences pg's warning)
  const strictSsl = (uri) => uri.replace(/sslmode=require/, 'sslmode=verify-full');
  const ownerUrl = async (branchId) =>
    strictSsl((await neon.getConnectionUri({ projectId, branch_id: branchId, database_name: dbName, role_name: ownerRole, pooled: false })).data.uri);

  const prodOwner = await ownerUrl(main.id);
  await waitForDb(prodOwner);
  step('Migrating the production database (branch main)');
  run('pnpm --filter @synapse/db migrate', { env: { DATABASE_URL_OWNER: prodOwner, APP_DB_PASSWORD: secrets.prod.APP_DB_PASSWORD }, display: 'pnpm --filter @synapse/db migrate  (prod)' });
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

  const s = (state.cloudflare.prod ??= {});
  const kvTitle = 'synapse-cache-prod';
  s.kvId = kvList.find((n) => n.title === kvTitle)?.id ?? (await cf.kv.namespaces.create({ account_id, title: kvTitle })).id;
  info(`${c.ok('✓')} KV ${kvTitle}`);

  for (const qn of ['synapse-jobs-prod', 'synapse-jobs-dlq-prod']) {
    if (!queueList.some((q) => q.queue_name === qn)) await cf.queues.create({ account_id, queue_name: qn });
    info(`${c.ok('✓')} Queue ${qn}`);
  }

  const vecName = 'synapse-kb-prod';
  if (!vecList.some((v) => v.name === vecName)) {
    await cf.vectorize.indexes.create({ account_id, name: vecName, config: { dimensions: 1024, metric: 'cosine' }, description: 'SanchalanOS knowledge base (bge-m3). Namespace = tenant id.' });
  }
  info(`${c.ok('✓')} Vectorize ${vecName}`);

  // Hyperdrive → Neon *direct* endpoint as the least-privilege runtime role, caching DISABLED
  const owner = new URL(prodOwner);
  const origin = { host: owner.hostname, port: 5432, database: dbName, user: 'synapse_app', password: secrets.prod.APP_DB_PASSWORD, scheme: /** @type {'postgres'} */ ('postgres') };
  const hdName = 'synapse-prod';
  const existingHd = hdList.find((h) => h.name === hdName);
  if (existingHd) {
    await cf.hyperdrive.configs.update(existingHd.id, { account_id, name: hdName, origin, caching: { disabled: true } });
    s.hyperdriveId = existingHd.id;
  } else {
    s.hyperdriveId = (await cf.hyperdrive.configs.create({ account_id, name: hdName, origin, caching: { disabled: true } })).id;
  }
  info(`${c.ok('✓')} Hyperdrive ${hdName} (query cache disabled for tenant safety)`);

  // ------------------------------------------------------------- what the old setup left behind
  const oldDev = {
    neonBranch: branches.find((b) => b.name === 'dev'),
    hyperdrive: hdList.find((h) => h.name === 'synapse-dev'),
    kv: kvList.find((n) => n.title === 'synapse-cache-dev'),
    queues: queueList.filter((q) => ['synapse-jobs-dev', 'synapse-jobs-dlq-dev'].includes(q.queue_name ?? '')),
  };
  const oldWorkers = [];
  for await (const w of cf.workers.scripts.list({ account_id })) if (['synapse-dev', 'synapse-prod'].includes(/** @type {any} */ (w).id)) oldWorkers.push(/** @type {any} */ (w).id);
  // the old production Worker still consumes synapse-jobs-prod and a queue takes only one
  // consumer, so it always goes: "sanchalanos" replaces it with the same database, KV and queue
  if (oldWorkers.includes('synapse-prod')) {
    await cf.workers.scripts.delete('synapse-prod', { account_id, force: true }).then(
      () => info(`${c.ok('✓')} deleted the old Worker synapse-prod (replaced by sanchalanos)`),
      (e) => info(c.warn(`could not delete the old Worker synapse-prod (${e.message}); delete it in the dashboard (Workers & Pages), then run setup again`)),
    );
    oldWorkers.splice(oldWorkers.indexOf('synapse-prod'), 1);
  }
  const leftovers = [
    oldDev.neonBranch && 'Neon branch "dev"',
    oldDev.hyperdrive && 'Hyperdrive synapse-dev',
    oldDev.kv && 'KV synapse-cache-dev',
    ...oldDev.queues.map((q) => `Queue ${q.queue_name}`),
    ...oldWorkers.map((w) => `Worker ${w}`),
  ].filter(Boolean);
  if (leftovers.length && removeOld) {
    step('Removing what the old setup made (REMOVE_OLD=true)');
    for (const w of oldWorkers) {
      await cf.workers.scripts.delete(w, { account_id, force: true }).then(() => info(`${c.ok('✓')} deleted Worker ${w}`), (e) => info(c.warn(`Worker ${w}: ${e.message}`)));
    }
    for (const q of oldDev.queues) {
      await cf.queues.delete(q.queue_id ?? '', { account_id }).then(() => info(`${c.ok('✓')} deleted Queue ${q.queue_name}`), (e) => info(c.warn(`Queue ${q.queue_name}: ${e.message}`)));
    }
    if (oldDev.hyperdrive) await cf.hyperdrive.configs.delete(oldDev.hyperdrive.id, { account_id }).then(() => info(`${c.ok('✓')} deleted Hyperdrive synapse-dev`), (e) => info(c.warn(`Hyperdrive: ${e.message}`)));
    if (oldDev.kv) await cf.kv.namespaces.delete(oldDev.kv.id, { account_id }).then(() => info(`${c.ok('✓')} deleted KV synapse-cache-dev`), (e) => info(c.warn(`KV: ${e.message}`)));
    if (oldDev.neonBranch) await neon.deleteProjectBranch({ projectId, branchId: oldDev.neonBranch.id }).then(() => info(`${c.ok('✓')} deleted Neon branch dev`), (e) => info(c.warn(`Neon branch dev: ${e.message}`)));
  } else if (leftovers.length) {
    info(c.warn(`Not used any more: ${leftovers.join(', ')}.`));
    info(c.warn('Run setup once with $env:REMOVE_OLD="true" to delete them (frees the old hostnames and Neon storage).'));
  }
  delete state.cloudflare.dev;

  // app hostnames (Workers Custom Domains → Cloudflare issues a certificate for each exact host,
  // multi-level ones like www.sanchalan.hrpai.in included)
  let zoneId = null;
  for await (const z of cf.zones.list({ name: zoneName, account: { id: account_id } })) if (z.name === zoneName) zoneId = z.id;
  if (zoneId) {
    info(`${c.ok('✓')} Zone ${zoneName} found — https://${appHost}${baseDomain !== appHost ? ` (https://${baseDomain} redirects there)` : ''}`);
    for (const h of hosts) {
      try {
        const existing = [];
        for await (const r of cf.dns.records.list({ zone_id: zoneId, name: { exact: h } })) existing.push(r);
        if (existing.length) {
          info(c.warn(`DNS already has ${existing.map((r) => r.type).join('/')} record(s) for ${h}. Wrangler cannot attach the Worker until you delete them in the Cloudflare dashboard (DNS → Records).`));
        }
      } catch {
        /* token without DNS read: wrangler will report conflicts itself */
      }
    }
    if (baseDomain !== appHost) await bareToWww(CF_TOKEN, zoneId, baseDomain, appHost);
  } else {
    info(c.warn(`Zone ${zoneName} is not on this Cloudflare account (or the token lacks Zone:Read). Add it and re-run: the app is served only on its own domain.`));
  }
  state.zoneName = zoneId ? zoneName : '';
  state.hosts = zoneId ? { prod: appHost, base: baseDomain } : {};
  writeJson(STATE_FILE, state);

  // --------------------------------------------------------------------------- wrangler.jsonc
  step('Rendering apps/api/wrangler.jsonc');
  renderWrangler({ zoneId, zoneName, appHost, baseDomain, accountId: account_id, kvId: s.kvId, hyperdriveId: s.hyperdriveId });
  info(`${c.ok('✓')} written`);

  // ------------------------------------------------------------------------------ deploy
  if (process.env.SKIP_DEPLOY !== 'true') {
    step('Building the web app');
    run('pnpm --filter @synapse/web build');
    step('Deploying the Worker (production)');
    run('pnpm --filter @synapse/api exec wrangler deploy --env production');
    const bulk = { JWT_SECRET: secrets.prod.JWT_SECRET, DATA_ENCRYPTION_KEY: secrets.prod.DATA_ENCRYPTION_KEY, VAPID_PUBLIC_KEY: secrets.prod.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: secrets.prod.VAPID_PRIVATE_KEY };
    // everything else (AI keys, mail, Google/Microsoft/Meta apps…) is set in the app:
    // Settings → Connection keys. Values in the terminal are still uploaded if present.
    for (const k of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'CF_TENANT_DOMAINS_TOKEN', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'FCM_SERVICE_ACCOUNT']) {
      if (process.env[k]) bulk[k] = process.env[k];
    }
    uploadSecrets(bulk);
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
  info(`Neon project:  ${projectId}  (branch main = production)`);
  info(state.zoneName ? `Production:    https://${appHost}  (workspace chosen at sign-in)` : c.warn(`Production needs the zone ${zoneName} on this Cloudflare account; add it and re-run.`));
  info('Your data: `pnpm cloud:import` copies the local database (and files) into production.');
  if (!process.env.CF_TENANT_DOMAINS_TOKEN) info(c.dim(`Optional: set $env:CF_TENANT_DOMAINS_TOKEN and re-run to give each workspace its own <slug>.${baseDomain} address.`));
  info('Commit apps/api/wrangler.jsonc and infra/state.json (no secrets inside); pushing to "main" deploys.');
}

/**
 * sanchalan.hrpai.in → https://www.sanchalan.hrpai.in (same path and query) with a Cloudflare
 * redirect rule, before the request reaches the Worker. Other redirect rules in the zone are kept.
 */
async function bareToWww(token, zoneId, bare, www) {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const rule = {
    ref: 'sanchalanos_bare_to_www',
    description: `SanchalanOS: ${bare} → ${www}`,
    expression: `(http.host eq "${bare}")`,
    action: 'redirect',
    action_parameters: { from_value: { status_code: 301, target_url: { expression: `concat("https://${www}", http.request.uri.path)` }, preserve_query_string: true } },
  };
  try {
    const cur = await fetch(url, { headers });
    /** @type {any} */ const j = await cur.json().catch(() => ({}));
    const rules = cur.ok ? (j.result?.rules ?? []).filter((r) => r.ref !== rule.ref).map(({ id, version, last_updated, ...r }) => r) : [];
    if (!cur.ok && cur.status !== 404) throw new Error(`${cur.status} ${(j.errors ?? []).map((e) => e.message).join('; ')}`);
    const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ rules: [...rules, rule] }) });
    /** @type {any} */ const pj = await put.json().catch(() => ({}));
    if (!put.ok) throw new Error(`${put.status} ${(pj.errors ?? []).map((e) => e.message).join('; ')}`);
    info(`${c.ok('✓')} https://${bare} redirects to https://${www}`);
  } catch (e) {
    info(c.warn(`Could not add the redirect ${bare} → ${www} (${/** @type {Error} */ (e).message}).`));
    info(c.warn('Either add "Zone → Single Redirect → Edit" to the token and re-run, or in the dashboard: hrpai.in → Rules →'));
    info(c.warn(`Redirect Rules → Create: hostname equals ${bare} → dynamic concat("https://${www}", http.request.uri.path), 301, keep query string.`));
  }
}

/**
 * Writes apps/api/wrangler.jsonc from the template.
 * @param {{ zoneId: string | null, zoneName: string, appHost: string, baseDomain: string, accountId: string, kvId: string, hyperdriveId: string }} o
 */
export function renderWrangler(o) {
  const tpl = readFileSync(join(ROOT, 'apps/api/wrangler.template.jsonc'), 'utf8');
  const hosts = [...new Set([o.appHost, o.baseDomain])];
  const routes = o.zoneId
    ? `"routes": [${hosts.map((h) => `{ "pattern": "${h}", "custom_domain": true }`).join(', ')}],`
    : `// add the zone ${o.zoneName} to Cloudflare and re-run setup to serve ${o.appHost}`;
  const rendered = tpl
    .replace(/^\/\/ SanchalanOS gateway Worker — TEMPLATE\.\n(\/\/.*\n){2}/m, '// SanchalanOS gateway Worker — GENERATED by `pnpm run setup` from wrangler.template.jsonc.\n// Resource IDs are not secrets; commit this file so CI can deploy.\n')
    .replaceAll('__PROD_HYPERDRIVE_ID__', o.hyperdriveId)
    .replaceAll('__PROD_KV_ID__', o.kvId)
    .replaceAll('__PROD_APP_HOST__', o.appHost)
    .replaceAll('__PROD_BASE_DOMAIN__', o.baseDomain)
    .replaceAll('__CF_ACCOUNT_ID__', o.accountId)
    .replaceAll('__ZONE_NAME__', o.zoneName)
    .replace('// __PROD_ROUTES__', routes);
  writeFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), rendered);
}

/** Uploads Worker secrets to production without printing them. @param {Record<string, string>} bulk */
export function uploadSecrets(bulk) {
  const tmp = join(LOCAL, 'secrets-prod.tmp.json');
  writeJson(tmp, bulk);
  try {
    run(`pnpm --filter @synapse/api exec wrangler secret bulk "${tmp}" --env production`, { display: 'wrangler secret bulk <generated> --env production' });
  } finally {
    rmSync(tmp, { force: true });
  }
}

// run directly (`pnpm cloud:setup`), not when another script imports the helpers above
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => {
    console.error(c.err(`\nSetup failed: ${e?.message ?? e}`));
    if (e?.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  });
}
