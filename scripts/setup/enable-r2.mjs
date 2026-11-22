// @ts-check
/**
 * Turns on file storage (attachments, signatures, backups) once R2 is enabled on the account.
 *
 *   1. Enable R2 once in the Cloudflare dashboard (R2 Object Storage → "Get started"; the free
 *      tier needs a payment method on file but stays free up to 10 GB).
 *   2. Run:  pnpm setup:r2        (uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the env)
 *   3. Deploy (push to main, or `pnpm deploy:prod`).
 *
 * Creates the bucket synapse-files-prod (idempotent) and adds the FILES
 * binding to the production environment in wrangler.template.jsonc and wrangler.jsonc.
 * The token needs "Workers R2 Storage: Edit" in addition to the permissions setup already uses.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID first.');
  process.exit(1);
}

const BUCKETS = { production: 'synapse-files-prod' };

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  return { ok: res.ok && body.success !== false, status: res.status, body };
}

for (const [env, name] of Object.entries(BUCKETS)) {
  const r = await cf('/r2/buckets', { method: 'POST', body: JSON.stringify({ name, locationHint: 'apac' }) });
  const codes = (r.body.errors ?? []).map((e) => e.code);
  if (r.ok) console.log(`✓ created bucket ${name} (${env})`);
  else if (codes.includes(10004) || r.status === 409) console.log(`✓ bucket ${name} already exists (${env})`);
  else if (codes.includes(10042)) {
    console.error('✗ R2 is not enabled on this Cloudflare account yet. Open the dashboard → R2 Object Storage → Get started, then run this again.');
    process.exit(2);
  } else if (r.status === 403) {
    console.error('✗ The API token cannot manage R2. Add the permission "Account → Workers R2 Storage → Edit" to the token and run again.');
    process.exit(3);
  } else {
    console.error(`✗ could not create ${name}: ${JSON.stringify(r.body.errors ?? r.body)}`);
    process.exit(4);
  }
}

/** Adds the FILES binding right after the env's "ai" binding, unless it is already there. */
function addBinding(file) {
  const path = join(ROOT, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  let changed = false;
  for (const [env, name] of Object.entries(BUCKETS)) {
    const start = text.indexOf(`"${env}": {`);
    if (start < 0) continue;
    const next = Object.keys(BUCKETS).map((k) => text.indexOf(`"${k}": {`, start + 1)).filter((i) => i > start);
    const end = next.length ? Math.min(...next) : text.length;
    const block = text.slice(start, end);
    if (block.includes(`"binding": "FILES"`)) continue;
    const anchor = block.indexOf('"ai": { "binding": "AI" },');
    if (anchor < 0) throw new Error(`Could not find the AI binding of env "${env}" in ${file}`);
    const indent = /\n(\s*)"ai": \{/.exec(block)?.[1] ?? '      ';
    const insert = `"ai": { "binding": "AI" },\n${indent}"r2_buckets": [{ "binding": "FILES", "bucket_name": "${name}" }],`;
    text = text.slice(0, start) + block.replace('"ai": { "binding": "AI" },', insert) + text.slice(end);
    changed = true;
  }
  if (changed) {
    writeFileSync(path, text);
    console.log(`✓ FILES binding added to ${file}`);
  } else console.log(`✓ ${file} already has the FILES binding`);
}

addBinding('apps/api/wrangler.template.jsonc');
addBinding('apps/api/wrangler.jsonc');
console.log('\nDone. Commit the wrangler files and deploy; uploads, signatures and backups switch on automatically.');
