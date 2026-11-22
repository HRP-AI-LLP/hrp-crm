// @ts-check
/**
 * Copies everything from this computer's database (`pnpm local`) into production (Neon), once.
 *
 *   pnpm cloud:import              copy the database and the uploaded files
 *   pnpm cloud:import --replace    production already has workspaces: wipe them and copy anyway
 *   pnpm cloud:import --no-files   database only (files stay on this computer)
 *
 * What it does:
 *   1. checks the local database is up and fully migrated, and that `pnpm cloud:setup` has run
 *   2. dumps the local database inside its Postgres container (pg_dump, nothing to install)
 *   3. empties the production database and restores the dump into it (owner "neondb_owner";
 *      the app's role synapse_app keeps its password); then ANALYZE and a migration check
 *   4. production uses this computer's DATA_ENCRYPTION_KEY from now on, so saved connection keys,
 *      mailbox tokens and two-factor secrets still open (the Worker secret is updated)
 *   5. uploads the files saved locally (attachments, photos, signatures) to the R2 bucket
 *      synapse-files-prod, when R2 is set up (`pnpm setup:r2`)
 *
 * Passwords stay as they are (people sign in with the same ones); everyone signs in again once.
 * Needs: NEON_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID in the terminal.
 * Nothing secret is printed or put on a command line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { prodOwnerUrl, migrateProd } from './migrate-prod.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_DIR = join(ROOT, 'infra', '.local');
const LOCAL = join(LOCAL_DIR, 'local.json');
const SECRETS = join(LOCAL_DIR, 'secrets.json');
const STATE = join(ROOT, 'infra', 'state.json');
const args = new Set(process.argv.slice(2));

const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, err: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.bold('▸ ' + s)}`);
const fail = (/** @type {string} */ m) => {
  console.error(c.err(`\n✗ ${m}`));
  process.exit(1);
};
const readJson = (f, d) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

// ------------------------------------------------------------------------------ where pg tools run
// default: inside the local Postgres container (`pnpm local` made it); SYNAPSE_PG_TOOLS=host uses
// pg_dump / pg_restore from PATH instead (version 17 or newer).
const CONTAINER = process.env.SYNAPSE_PG_CONTAINER ?? 'synapse-pg';
const PORT = Number(process.env.SYNAPSE_PG_PORT ?? 54329);
const DB = 'synapse';
const hostTools = process.env.SYNAPSE_PG_TOOLS === 'host';
const ENGINE = hostTools
  ? ''
  : ((process.env.CONTAINER_ENGINE ? [process.env.CONTAINER_ENGINE] : ['podman', 'docker']).find((e) => spawnSync(e, ['--version'], { stdio: 'ignore' }).status === 0) ?? '');
const DUMP = hostTools ? join(LOCAL_DIR, 'import.dump') : '/tmp/sanchalan-import.dump';
const LIST = hostTools ? join(LOCAL_DIR, 'import.list') : '/tmp/sanchalan-import.list';

/**
 * Runs a pg tool. `env` values are passed by name only (never on the command line).
 * @param {string[]} argv @param {{ env?: Record<string, string>, input?: string }} [o]
 */
function tool(argv, o = {}) {
  const env = { ...process.env, ...(o.env ?? {}) };
  const r = hostTools
    ? spawnSync(String(argv[0]), argv.slice(1), { env, encoding: 'utf8', input: o.input, maxBuffer: 64 * 1024 * 1024 })
    : // no shell: podman.exe / docker.exe take the arguments exactly as given (spaces and quotes included)
      spawnSync(ENGINE, ['exec', ...(o.input !== undefined ? ['-i'] : []), ...Object.keys(o.env ?? {}).flatMap((k) => ['-e', k]), CONTAINER, ...argv], { env, encoding: 'utf8', input: o.input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
}

async function main() {
  for (const k of ['NEON_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!(process.env[k] ?? '').trim()) fail(`set $env:${k} first (the same values \`pnpm setup\` uses)`);
  }
  if (!hostTools && !ENGINE) fail('neither podman nor docker was found; start Podman Desktop (or set SYNAPSE_PG_TOOLS=host with pg_dump 17 on PATH)');
  const state = readJson(STATE, {});
  if (!state.neon?.projectId || !state.cloudflare?.prod?.hyperdriveId) fail('run `pnpm cloud:setup` first: production must exist before data can go into it');

  // ---------------------------------------------------------------------------- local side
  step('Checking the local database');
  const local = readJson(LOCAL, null);
  if (!local?.PG_PASSWORD) fail('infra/.local/local.json not found — this computer has no local database yet (`pnpm local`)');
  const srcUrl = new URL(process.env.SYNAPSE_SOURCE_DB_URL ?? `postgres://postgres@127.0.0.1:${PORT}/${DB}`);
  if (!process.env.SYNAPSE_SOURCE_DB_URL) srcUrl.password = local.PG_PASSWORD;
  const src = new pg.Client({ connectionString: srcUrl.toString() });
  await src.connect().catch((e) => fail(`cannot reach the local database (${e.message}). Start it with \`pnpm local\` (or \`pnpm local --no-build\`), then run this again.`));
  const files = readdirSync(join(ROOT, 'packages', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await src.query('select name from ops.schema_migrations')).rows.map((r) => r.name));
  const missing = files.filter((f) => !applied.has(f) && !applied.has(f.replace(/\.sql$/, '')));
  if (missing.length) fail(`the local database is missing ${missing.length} migration(s) (${missing.slice(0, 3).join(', ')}…). Run \`pnpm local\` once so it is up to date.`);
  const srcTenants = (await src.query(`select t.slug, t.name from tenants t join app.list_active_tenant_ids() a on a = t.id order by t.created_at`).catch(() => ({ rows: [] }))).rows;
  const schemas = (await src.query(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`)).rows.map((r) => r.nspname);
  const size = (await src.query(`select pg_size_pretty(pg_database_size(current_database())) as s`)).rows[0].s;
  await src.end();
  console.log(`  ${c.ok('✓')} ${srcTenants.length} workspace(s): ${srcTenants.map((t) => t.slug).join(', ') || '—'}  ·  ${size}  ·  schemas ${schemas.join(', ')}`);

  // ------------------------------------------------------------------------------ prod side
  step('Checking production (Neon)');
  const ownerUrl = await prodOwnerUrl();
  const dst = new pg.Client({ connectionString: ownerUrl });
  await dst.connect().catch((e) => fail(`cannot reach the production database (${e.message})`));
  const dstTenants = (await dst.query(`select count(*)::int as n from app.list_active_tenant_ids()`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const hasRole = (await dst.query(`select 1 from pg_roles where rolname = 'synapse_app' and rolcanlogin`)).rowCount;
  if (!hasRole) fail('production has no login for the app yet — run `pnpm cloud:setup` first');
  if (dstTenants > 0 && !args.has('--replace')) {
    await dst.end();
    fail(`production already has ${dstTenants} workspace(s). To wipe them and copy this computer's data instead, run:  pnpm cloud:import --replace`);
  }
  console.log(`  ${c.ok('✓')} reachable${dstTenants ? c.warn(` — its ${dstTenants} workspace(s) will be replaced (--replace)`) : ' and empty'}`);

  // ---------------------------------------------------------------------------------- dump
  step('Dumping the local database');
  mkdirSync(LOCAL_DIR, { recursive: true });
  const dump = hostTools
    ? tool(['pg_dump', '-Fc', '--no-owner', '-f', DUMP, '-d', srcUrl.toString()])
    : tool(['pg_dump', '-U', 'postgres', '-d', DB, '-Fc', '--no-owner', '-f', DUMP]);
  if (!dump.ok) fail(`pg_dump failed: ${dump.err.trim()}`);
  const listed = tool(['pg_restore', '-l', DUMP]);
  if (!listed.ok) fail(`pg_restore -l failed: ${listed.err.trim()}`);
  // left out: things only a superuser may restore, and the public schema itself (recreated below)
  const skip = [/ COMMENT - EXTENSION /, / EXTENSION - plpgsql/, / DEFAULT ACL /, / SCHEMA - public /, / COMMENT - SCHEMA public /, / ACL - SCHEMA public /];
  const list = listed.out.split(/\r?\n/).filter((l) => !skip.some((re) => re.test(l))).join('\n') + '\n';
  if (hostTools) writeFileSync(LIST, list);
  else if (!tool(['sh', '-c', `cat > ${LIST}`], { input: list }).ok) fail('could not write the restore list into the container');
  console.log(`  ${c.ok('✓')} ${list.split('\n').filter((l) => l && !l.startsWith(';')).length} objects`);

  // -------------------------------------------------------------------------- empty prod
  step('Emptying production');
  await dst.query('begin');
  for (const s of schemas) {
    if (s === 'public') await dst.query('drop schema if exists public cascade; create schema public; grant usage on schema public to public');
    else await dst.query(`drop schema if exists ${pg.escapeIdentifier(s)} cascade`);
  }
  await dst.query('commit');
  console.log(`  ${c.ok('✓')} ${schemas.join(', ')} dropped`);

  // -------------------------------------------------------------------------------- restore
  step('Restoring into production (one transaction: all or nothing)');
  // pg_restore inside the container can't check Neon's certificate chain; the link is still encrypted
  const target = new URL(ownerUrl);
  if (!hostTools) target.searchParams.set('sslmode', 'require');
  // in the container the URL is read from the environment, so it never appears in a process list
  const res = hostTools
    ? tool(['pg_restore', '--no-owner', '--exit-on-error', '--single-transaction', '-L', LIST, '-d', target.toString(), DUMP])
    : tool(['sh', '-c', `pg_restore --no-owner --exit-on-error --single-transaction -L ${LIST} -d "$TARGET_URL" ${DUMP}`], { env: { TARGET_URL: target.toString() } });
  if (!res.ok) {
    await dst.end();
    fail(`restore failed, production is left empty (re-run after fixing): ${res.err.trim().split('\n').slice(-4).join(' | ')}`);
  }
  await dst.query('analyze');
  const got = (await dst.query(`select count(*)::int as n from app.list_active_tenant_ids()`)).rows[0].n;
  await dst.end();
  console.log(`  ${c.ok('✓')} restored: ${got} workspace(s); statistics refreshed`);
  if (hostTools) {
    rmSync(DUMP, { force: true });
    rmSync(LIST, { force: true });
  } else tool(['rm', '-f', DUMP, LIST]);

  step('Checking migrations');
  await migrateProd();

  // ------------------------------------------------------------------------- encryption key
  step('Production now uses this computer\'s encryption key');
  if (!local.DATA_ENCRYPTION_KEY) fail('infra/.local/local.json has no DATA_ENCRYPTION_KEY');
  const secrets = readJson(SECRETS, {});
  secrets.prod ??= {};
  if (secrets.prod.DATA_ENCRYPTION_KEY && secrets.prod.DATA_ENCRYPTION_KEY !== local.DATA_ENCRYPTION_KEY) secrets.prod.DATA_ENCRYPTION_KEY_BEFORE_IMPORT = secrets.prod.DATA_ENCRYPTION_KEY;
  secrets.prod.DATA_ENCRYPTION_KEY = local.DATA_ENCRYPTION_KEY;
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 2) + '\n');
  const { uploadSecrets } = await import('./provision.mjs');
  try {
    uploadSecrets({ DATA_ENCRYPTION_KEY: local.DATA_ENCRYPTION_KEY });
    console.log(`  ${c.ok('✓')} Worker secret DATA_ENCRYPTION_KEY updated (kept in infra/.local/secrets.json)`);
  } catch {
    console.log(c.warn('  The Worker secret could not be updated (is the Worker deployed? `pnpm cloud:setup`). Run this again after deploying, or:'));
    console.log(c.warn('  pnpm --filter @synapse/api exec wrangler secret put DATA_ENCRYPTION_KEY --env production   (value: DATA_ENCRYPTION_KEY in infra/.local/local.json)'));
  }

  // --------------------------------------------------------------------------------- files
  if (args.has('--no-files')) console.log(c.dim('\nFiles skipped (--no-files).'));
  else await copyFiles();

  step('Done');
  const host = state.hosts?.prod ?? 'www.sanchalan.hrpai.in';
  console.log(`  Open https://${host} and sign in with the same workspace ID, email and password as on this computer.`);
  console.log('  Settings → Connection keys: check the callback URLs of Google / Microsoft / Zoom / GitHub now use the production address.');
}

/** Local R2 (wrangler's simulation in apps/api/.wrangler) → the production bucket. */
async function copyFiles() {
  step('Copying uploaded files to R2 (synapse-files-prod)');
  const wranglerToml = readFileSync(join(ROOT, 'apps', 'api', 'wrangler.jsonc'), 'utf8');
  if (!/"bucket_name":\s*"synapse-files-prod"/.test(wranglerToml)) {
    console.log(c.warn('  R2 is not set up for production yet, so files stay on this computer for now.'));
    console.log(c.warn('  Run `pnpm setup:r2`, deploy, then `pnpm cloud:import --replace` again (or copy files later with this same command).'));
    return;
  }
  const persist = join(ROOT, 'apps', 'api', '.wrangler', 'state', 'v3');
  if (!existsSync(join(persist, 'r2'))) {
    console.log(`  ${c.ok('✓')} no files saved locally`);
    return;
  }
  const req = createRequire(join(ROOT, 'apps', 'api', 'package.json'));
  /** @type {any} */ const wrangler = await import(pathToFileURL(req.resolve('wrangler')).href);
  const wranglerBin = join(dirname(req.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  const proxy = await wrangler.getPlatformProxy({ configPath: join(ROOT, 'apps', 'api', 'wrangler.local.jsonc'), persist: { path: persist } });
  const bucket = proxy.env.FILES;
  const tmpDir = join(LOCAL_DIR, 'import-files');
  mkdirSync(tmpDir, { recursive: true });
  let n = 0;
  let failed = 0;
  let cursor;
  try {
    do {
      const page = await bucket.list({ cursor, limit: 500, include: ['httpMetadata'] });
      for (const o of page.objects) {
        const body = await bucket.get(o.key);
        if (!body) continue;
        const tmp = join(tmpDir, 'object');
        writeFileSync(tmp, Buffer.from(await body.arrayBuffer()));
        const ct = o.httpMetadata?.contentType;
        // wrangler's own script through node: no shell, so any file name passes through unchanged
        const r = spawnSync(process.execPath, [wranglerBin, 'r2', 'object', 'put', `synapse-files-prod/${o.key}`, '--file', tmp, '--remote', ...(ct ? ['--content-type', ct] : [])], {
          cwd: join(ROOT, 'apps', 'api'),
          encoding: 'utf8',
        });
        if (r.status === 0) n++;
        else {
          failed++;
          console.log(c.warn(`  could not upload ${o.key}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`));
        }
        if ((n + failed) % 25 === 0) console.log(c.dim(`  … ${n + failed} files`));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } finally {
    await proxy.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`  ${c.ok('✓')} ${n} file(s) uploaded${failed ? c.warn(`, ${failed} failed (run again to retry)`) : ''}`);
}

main().catch((e) => fail(e?.message ?? String(e)));
