// pnpm gst:check — checks the GSP keys in the repo-root .env without printing them
// (India Compliance: shows the account and credits; WhiteBooks: a public taxpayer search).
// It calls the public taxpayer search (no OTP needed) and, if you pass a GSTIN and the GST portal
// username, asks the portal for an OTP:  pnpm gst:check 09AAAAA0000A1Z5 my_gst_username
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './dotenv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadDotEnv(ROOT);
const e = /** @type {Record<string, string>} */ (process.env);
const want = (e.GST_PROVIDER ?? '').toLowerCase();
if (e.GSTINAPI_KEY && (!want || want.startsWith('gstinapi'))) {
  // gstinapi.in: today's usage (free) and the test GSTIN (free, never charged)
  console.log(`GST provider: gstinapi.in${/^(1|true|yes)$/i.test(e.GSTINAPI_TEST_MODE ?? '') ? ' (TEST MODE: nothing reaches the GST network)' : ''}`);
  const base = (e.GSTINAPI_BASE_URL || 'https://www.gstinapi.in').replace(/\/+$/, '');
  for (const [label, path] of /** @type {[string, string][]} */ ([['Key and usage today', '/v1/gstin/stats/me'], ['Test lookup (free)', '/v1/gstin/00AAAAA0000A1ZT']])) {
    try {
      const r = await fetch(base + path, { headers: { 'x-api-key': e.GSTINAPI_KEY ?? '' }, signal: AbortSignal.timeout(20_000) });
      /** @type {any} */
      const j = await r.json().catch(() => null);
      const ok = r.ok && j?.success !== false;
      console.log(`${ok ? '✓' : '✗'} ${label}: HTTP ${r.status}${ok ? '' : ` — ${String(j?.error ?? j?.message ?? '').slice(0, 200)}`}`);
      if (ok && path.endsWith('/me')) console.log(`  calls today ${j?.total_calls ?? j?.data?.total_calls ?? '—'}, credits used today ${j?.credits_used ?? j?.data?.credits_used ?? '—'}`);
      if (ok && j?.credits_remaining !== undefined) console.log(`  credits left: ${j.credits_remaining}`);
    } catch (err) {
      console.log(`✗ ${label}: ${/** @type {Error} */ (err).message}`);
    }
  }
  process.exit(0);
}
if (e.INDIA_COMPLIANCE_API_SECRET && want !== 'whitebooks') {
  // India Compliance: show the account (credits) without spending a credit
  const { execFileSync } = await import('node:child_process');
  console.log('GST Suvidha Provider: India Compliance');
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/local/ic-account.mjs'), 'status'], { stdio: 'inherit' });
  } catch {
    process.exit(1);
  }
  process.exit(0);
}
const missing = ['WHITEBOOKS_CLIENT_ID', 'WHITEBOOKS_CLIENT_SECRET', 'WHITEBOOKS_EMAIL'].filter((k) => !e[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const EMAIL = e.WHITEBOOKS_EMAIL ?? '';
const ID = e.WHITEBOOKS_CLIENT_ID ?? '';
const SECRET = e.WHITEBOOKS_CLIENT_SECRET ?? '';
const sandbox = (e.WHITEBOOKS_ENV ?? 'sandbox').toLowerCase() !== 'production';
const base = (e.WHITEBOOKS_BASE_URL || (sandbox ? 'https://apisandbox.whitebooks.in' : 'https://api.whitebooks.in')).replace(/\/+$/, '');
const [gstin = '27AAACT2727Q1ZW', username] = process.argv.slice(2);
console.log(`WhiteBooks ${sandbox ? 'SANDBOX' : 'PRODUCTION'} at ${base}`);

const secretValues = /** @type {string[]} */ ([e.WHITEBOOKS_CLIENT_ID, e.WHITEBOOKS_CLIENT_SECRET].filter(Boolean));
/** @param {unknown} s */
const scrub = (s) => secretValues.reduce((t, v) => t.split(v).join('***'), String(s));

/** @param {string} label @param {string} path @param {Record<string, string>} query @param {Record<string, string>} [headers] */
async function call(label, path, query, headers = {}) {
  const url = new URL(base + path);
  url.searchParams.set('email', EMAIL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', client_id: ID, client_secret: SECRET, ...headers }, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    const ok = r.ok && j && String(j.status_cd ?? '1') !== '0';
    console.log(`${ok ? '✓' : '✗'} ${label}: HTTP ${r.status}${j?.status_cd !== undefined ? `, status_cd ${j.status_cd}` : ''}`);
    if (!ok) console.log(`  ${scrub(j?.error?.message ?? j?.status_desc ?? j?.message ?? text.slice(0, 300))}`);
    else if (j?.data && typeof j.data === 'object') console.log(`  response keys: ${Object.keys(j.data).slice(0, 12).join(', ')}`);
    else if (j?.header) console.log(`  header keys: ${Object.keys(j.header).join(', ')}`);
    return ok;
  } catch (err) {
    const x = /** @type {Error} */ (err);
    console.log(`✗ ${label}: ${x.name === 'TimeoutError' ? 'timed out' : scrub(x.message)}`);
    return false;
  }
}

const searched = await call(`Taxpayer search ${gstin}`, '/public/search', { gstin });
if (!searched) console.log('\nIf this says the client is not authorised, check the client id / secret / email and that WHITEBOOKS_ENV matches the keys (sandbox keys only work on the sandbox).');
if (username) {
  await call('GST portal OTP request', '/authentication/otprequest', {}, { gst_username: username, state_cd: gstin.slice(0, 2), ip_address: '127.0.0.1' });
  if (sandbox) console.log('  In the sandbox the OTP is 575757. Finish connecting in the app: Billing & GST → GST portal.');
}
