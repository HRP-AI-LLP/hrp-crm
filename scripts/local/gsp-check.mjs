// pnpm gst:check — checks the WhiteBooks GSP keys in the repo-root .env without printing them.
// It calls the public taxpayer search (no OTP needed) and, if you pass a GSTIN and the GST portal
// username, asks the portal for an OTP:  pnpm gst:check 09AAAAA0000A1Z5 my_gst_username
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './dotenv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadDotEnv(ROOT);
const e = /** @type {Record<string, string>} */ (process.env);
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
