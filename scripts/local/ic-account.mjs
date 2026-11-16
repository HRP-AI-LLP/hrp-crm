// pnpm gst:ic-account — your India Compliance account (the GST API provider), from the terminal.
//
//   pnpm gst:ic-account trial <GSTIN>           is this GSTIN eligible for the free credits?
//   pnpm gst:ic-account signup <email> <GSTIN>  create the account; a sign-in link is e-mailed
//   pnpm gst:ic-account login <email>           sign in to an existing account; a link is e-mailed
//   pnpm gst:ic-account finish                  after clicking the link: saves the API key in .env
//   pnpm gst:ic-account status                  credits left and validity
//   pnpm gst:ic-account prices                  price per credit (by pack size)
//
// The API key is written to the repo-root .env (git-ignored) as INDIA_COMPLIANCE_API_SECRET and is
// never printed. The pending sign-in is kept in infra/.local/ic-session.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './dotenv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = join(ROOT, '.env');
const SESSION_FILE = join(ROOT, 'infra', '.local', 'ic-session.json');
const BASE = 'https://asp.resilient.tech/v1/';
loadDotEnv(ROOT);

/** @param {string} endpoint @param {{ method?: string, body?: unknown, key?: string }} [o] */
async function call(endpoint, o = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (o.key) headers['x-api-key'] = o.key;
  const r = await fetch(BASE + endpoint, { method: o.method ?? 'POST', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(30_000) });
  /** @type {any} */
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || j?.exc_type) {
    let msg = j?.message ?? j?.error ?? j?.exception ?? `HTTP ${r.status}`;
    if (j?._server_messages) {
      try {
        msg = JSON.parse(JSON.parse(j._server_messages)[0]).message;
      } catch {}
    }
    throw new Error(String(typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/<[^>]+>/g, ''));
  }
  return j?.message ?? j;
}

/** @param {string} name @param {string} value */
function setEnv(name, value) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'));
}

const gstinRe = /^[0-9]{2}[A-Z0-9]{13}$/;
const [cmd, a1, a2] = process.argv.slice(2);
try {
  if (cmd === 'trial') {
    if (!gstinRe.test(String(a1).toUpperCase())) throw new Error('Usage: pnpm gst:ic-account trial <GSTIN>');
    const m = await call('auth/is_eligible_for_free_trial', { body: { gstin: String(a1).toUpperCase() } });
    console.log(m === true || m?.eligible || m?.is_eligible ? '✓ Eligible for the free credits.' : `Free credits: ${JSON.stringify(m)}`);
  } else if (cmd === 'signup' || cmd === 'login') {
    const email = String(a1 ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Usage: pnpm gst:ic-account ${cmd === 'signup' ? 'signup <email> <GSTIN>' : 'login <email>'}`);
    const body = cmd === 'signup' ? { email, gstin: String(a2 ?? '').toUpperCase() } : { email };
    if (cmd === 'signup' && !gstinRe.test(body.gstin ?? '')) throw new Error('Usage: pnpm gst:ic-account signup <email> <GSTIN>');
    const m = await call(cmd === 'signup' ? 'auth/signup' : 'auth/login', { body });
    if (!m?.session?.id) throw new Error(`Unexpected answer: ${JSON.stringify(m).slice(0, 300)}`);
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(m.session));
    console.log(`✓ India Compliance sent a sign-in link to ${email}. Click it, then run: pnpm gst:ic-account finish`);
  } else if (cmd === 'finish') {
    if (!existsSync(SESSION_FILE)) throw new Error('Run signup or login first');
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    const m = await call('auth/validate_session', { body: { session_id: session.id } });
    if (!m?.api_secret) throw new Error('Not signed in yet: click the link in the e-mail from India Compliance, then run finish again');
    setEnv('INDIA_COMPLIANCE_API_SECRET', String(m.api_secret));
    setEnv('GST_PROVIDER', 'indiacompliance');
    writeFileSync(SESSION_FILE, '{}');
    console.log('✓ Saved the API key to .env (INDIA_COMPLIANCE_API_SECRET) and chose India Compliance (GST_PROVIDER).');
    console.log('  Restart the app: pnpm local:stop, then pnpm local.');
  } else if (cmd === 'status' || cmd === 'prices') {
    const key = process.env.INDIA_COMPLIANCE_API_SECRET;
    if (!key) throw new Error('No INDIA_COMPLIANCE_API_SECRET in .env yet (run signup / login, then finish)');
    if (cmd === 'status') {
      const m = await call('account.get_subscription_details', { method: 'GET', key });
      const unlimited = m?.total_credits === -1;
      console.log(`Account: ${m?.email ?? '—'}`);
      console.log(unlimited ? `Credits used: ${m?.used_credits}` : `Credits left: ${m?.balance_credits ?? '—'} of ${m?.total_credits ?? '—'}`);
      if (m?.expiry_date) console.log(`Valid until: ${m.expiry_date}`);
    } else {
      const m = await call('account.get_calculator_details', { method: 'GET', key });
      const rates = m?.rates ?? {};
      console.log('Price per credit (1 credit = 1 government API call), before GST:');
      for (const [credits, paise] of Object.entries(rates)) console.log(`  from ${Number(credits).toLocaleString('en-IN')} credits: ₹${(Number(paise) / 100).toFixed(2)}`);
      if (m?.tax_rate) console.log(`GST: ${m.tax_rate}%`);
      if (m?.min_order_qty || m?.minimum_credits) console.log(`Minimum purchase: ${m.min_order_qty ?? m.minimum_credits} credits`);
    }
  } else {
    console.log('Usage: pnpm gst:ic-account trial|signup|login|finish|status|prices  (see scripts/local/ic-account.mjs)');
  }
} catch (e) {
  console.error(`✗ ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
