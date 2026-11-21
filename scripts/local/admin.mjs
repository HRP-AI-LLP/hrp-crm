// @ts-check
/**
 * Find and recover sign-ins on the LOCAL database (`pnpm local`).
 *
 *   pnpm local:admin                              workspaces with their people (email, owner, status)
 *   pnpm local:admin reset <workspace> <email>    set a new password (asked for, not echoed in history),
 *                                                 unlock the account and end its sessions
 *   pnpm local:admin reset <workspace> <email> --no-mfa   also turn two-factor sign-in off
 *
 * Passwords are stored only as one-way hashes, so they can't be shown — only replaced.
 * The demo workspace's password is DEMO_ADMIN_PASSWORD in infra/.local/local.json.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = join(ROOT, 'infra', '.local', 'local.json');
const PORT = Number(process.env.SYNAPSE_PG_PORT ?? 54329);
const fail = (/** @type {string} */ m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`);
  process.exit(1);
};

// SYNAPSE_OWNER_DB_URL: another database (an owner / superuser connection string)
let conn = process.env.SYNAPSE_OWNER_DB_URL;
if (!conn) {
  if (!existsSync(LOCAL)) fail('infra/.local/local.json not found — run `pnpm local` once first.');
  const local = JSON.parse(readFileSync(LOCAL, 'utf8'));
  const url = new URL(`postgres://postgres@127.0.0.1:${PORT}/synapse`);
  url.password = local.PG_PASSWORD;
  conn = url.toString();
}
const db = new pg.Client({ connectionString: conn });
await db.connect().catch((e) => fail(`cannot reach the local database (${e.message}). Start it with \`pnpm local\`.`));

/** PBKDF2-SHA256, the same format the API writes (packages/shared/src/password.ts). */
function hashPassword(/** @type {string} */ pw) {
  const salt = randomBytes(16);
  const bits = pbkdf2Sync(pw.normalize('NFKC'), salt, 100_000, 32, 'sha256');
  return ['pbkdf2', 'sha256', '100000', salt.toString('base64'), bits.toString('base64')].join('$');
}

/** Reads lines without showing them (one reader for every question; works when piped too). */
let rl = /** @type {import('node:readline').Interface | null} */ (null);
const lines = /** @type {string[]} */ ([]);
let waiting = /** @type {((s: string) => void) | null} */ (null);
function askHidden(/** @type {string} */ q) {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    // @ts-ignore — keep what is typed off the screen
    rl._writeToOutput = () => undefined;
    rl.on('line', (l) => {
      process.stdout.write('\n');
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(l);
      } else lines.push(l);
    });
  }
  process.stdout.write(q);
  return new Promise((resolve) => (lines.length ? resolve(/** @type {string} */ (lines.shift())) : (waiting = resolve)));
}

const [cmd, slug, email] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
try {
  if (!cmd || cmd === 'list') {
    const { rows } = await db.query(
      `select t.slug, t.name, t.status as ws_status, u.email, u.full_name, u.is_owner, u.status, u.mfa_enabled_at is not null as mfa,
              u.locked_until > now() as locked, to_char(u.last_login_at, 'YYYY-MM-DD HH24:MI') as last_login
         from tenants t left join users u on u.tenant_id = t.id
        order by t.created_at, u.is_owner desc, u.email`,
    );
    let last = '';
    for (const r of rows) {
      if (r.slug !== last) {
        console.log(`\n\x1b[36m${r.name}\x1b[0m  — workspace ID: \x1b[1m${r.slug}\x1b[0m${r.ws_status !== 'active' ? ` (${r.ws_status})` : ''}`);
        last = r.slug;
      }
      if (r.email)
        console.log(
          `   ${r.is_owner ? '★' : ' '} ${r.email.padEnd(34)} ${r.full_name.padEnd(24)} ${r.status}${r.mfa ? ' · two-factor on' : ''}${r.locked ? ' · locked' : ''}${r.last_login ? ` · last sign-in ${r.last_login}` : ''}`,
        );
    }
    console.log(`\n★ = workspace owner. Sign in at http://localhost:5173 with the workspace ID, email and password.`);
    console.log('Forgot the password? pnpm local:admin reset <workspace ID> <email>');
    if (rows.some((r) => r.slug === 'demo')) console.log('The demo workspace password is DEMO_ADMIN_PASSWORD in infra/.local/local.json.');
  } else if (cmd === 'reset') {
    if (!slug || !email) fail('usage: pnpm local:admin reset <workspace ID> <email>');
    const { rows } = await db.query(`select u.id, u.full_name from users u join tenants t on t.id = u.tenant_id where t.slug = lower($1) and lower(u.email) = lower($2)`, [slug, email]);
    if (!rows.length) fail(`no user ${email} in workspace ${slug} — run \`pnpm local:admin\` to see them`);
    const pw = String(await askHidden(`New password for ${rows[0].full_name} (10+ characters): `));
    if (pw.length < 10) fail('use at least 10 characters');
    if (String(await askHidden('Type it again: ')) !== pw) fail('the two passwords differ');
    await db.query('begin');
    await db.query(
      `update users set password_hash = $2, failed_logins = 0, locked_until = null, status = 'active', updated_at = now()
              ${process.argv.includes('--no-mfa') ? ", mfa_secret_ciphertext = null, mfa_enabled_at = null, mfa_recovery_hashes = '{}'" : ''}
        where id = $1`,
      [rows[0].id, hashPassword(pw)],
    );
    await db.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [rows[0].id]);
    await db.query('commit');
    console.log(`\x1b[32m✓ password set for ${email} in workspace ${slug}\x1b[0m${process.argv.includes('--no-mfa') ? ' (two-factor sign-in turned off)' : ''}. Sign in at http://localhost:5173.`);
  } else fail(`unknown command ${cmd} — use: pnpm local:admin  |  pnpm local:admin reset <workspace ID> <email>`);
} finally {
  rl?.close();
  await db.end();
}
