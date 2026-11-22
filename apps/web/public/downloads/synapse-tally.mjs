#!/usr/bin/env node
/**
 * SanchalanOS ⇄ Tally connector.
 *
 * Runs on the PC where Tally Prime (or ERP 9) is open. It needs Node.js 18 or newer and nothing
 * else. Every few minutes it:
 *   1. asks SanchalanOS for new or changed customer ledgers, invoices, credit notes and receipts,
 *   2. imports each into Tally through Tally's XML server (http://localhost:9000 by default),
 *   3. tells SanchalanOS what Tally accepted or rejected,
 *   4. reads receipts entered in Tally and sends them to SanchalanOS (they settle invoices there).
 *
 * In Tally: F1 (Help) → Settings → Connectivity → Client/Server configuration →
 *   "TallyPrime acts as" = Both (or Server), port 9000. Keep the company open.
 *
 * Usage:
 *   node synapse-tally.mjs --url <connector URL> --token <tly_… token>
 *   options: --tally http://localhost:9000   --every 10 (minutes)   --once   --dry-run
 * The URL and token can also go in synapse-tally.json next to this file:
 *   { "url": "https://…/api/public/tally/…", "token": "tly_…", "tally": "http://localhost:9000" }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'synapse-tally-state.json');

// ------------------------------------------------------------------------------ Tally XML helpers

const unesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? unesc(m[1].trim()) : null;
};
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);
const attr = (xml, el, name) => {
  const m = new RegExp(`<${el}\\s[^>]*\\b${name}="([^"]*)"`, 'i').exec(xml);
  return m ? unesc(m[1]) : null;
};

/** Tally's answer to an import: created / altered / errors and the error lines. */
export function parseImportResponse(xml) {
  const num = (n) => Number(tag(xml, n) ?? 0) || 0;
  const errors = tags(xml, 'LINEERROR').map((e) => unesc(e.trim()));
  const res = { created: num('CREATED'), altered: num('ALTERED'), errors: num('ERRORS') + num('EXCEPTIONS'), messages: errors };
  if (!/<RESPONSE>/i.test(xml) && !/<CREATED>/i.test(xml)) res.errors = Math.max(res.errors, 1), res.messages.push(xml.slice(0, 300) || 'No answer from Tally');
  res.ok = res.errors === 0 && res.created + res.altered > 0;
  return res;
}

/** The TDL request for receipt vouchers between two dates (YYYYMMDD). */
export function receiptsRequest(company, from, to) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SynapseReceipts</ID></HEADER><BODY><DESC><STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : ''}<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="SynapseReceipts" ISMODIFY="No"><TYPE>Voucher</TYPE><FILTER>SynapseIsReceipt</FILTER><FETCH>Date, VoucherNumber, PartyLedgerName, Narration, GUID, RemoteID, AllLedgerEntries.*</FETCH></COLLECTION><SYSTEM TYPE="Formulae" NAME="SynapseIsReceipt">$$IsReceipt:$VoucherTypeName AND NOT $IsCancelled</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Receipt vouchers from Tally's export: party, amount and the bills they settle. */
export function parseReceipts(xml) {
  const out = [];
  for (const m of xml.matchAll(/<VOUCHER(\s[^>]*)?>([\s\S]*?)<\/VOUCHER>/gi)) {
    const full = m[0];
    const v = m[2];
    const party = tag(v, 'PARTYLEDGERNAME');
    const d = tag(v, 'DATE');
    const guid = tag(v, 'GUID');
    if (!party || !d || !guid || d.length !== 8) continue;
    const entries = [...tags(v, 'ALLLEDGERENTRIES.LIST'), ...tags(v, 'LEDGERENTRIES.LIST')];
    const partyEntry = entries.find((e) => (tag(e, 'LEDGERNAME') ?? '').toLowerCase() === party.toLowerCase());
    if (!partyEntry) continue;
    const amount = Math.abs(Number(tag(partyEntry, 'AMOUNT') ?? 0));
    if (!(amount > 0)) continue;
    const bills = tags(partyEntry, 'BILLALLOCATIONS.LIST')
      .map((b) => ({ name: tag(b, 'NAME') ?? '', amount: Math.abs(Number(tag(b, 'AMOUNT') ?? 0)), type: tag(b, 'BILLTYPE') ?? '' }))
      .filter((b) => b.name && b.amount > 0 && !/new ref|advance|on account/i.test(b.type))
      .map(({ name, amount }) => ({ name, amount }));
    out.push({ guid, remoteId: tag(v, 'REMOTEID') ?? attr(full, 'VOUCHER', 'REMOTEID'), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, number: tag(v, 'VOUCHERNUMBER'), party, amount, narration: tag(v, 'NARRATION'), bills });
  }
  return out;
}

// --------------------------------------------------------------------------------- the connector

function loadConfig(argv) {
  const file = join(HERE, 'synapse-tally.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const arg = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfg = {
    url: arg('url') ?? process.env.SYNAPSE_TALLY_URL ?? fromFile.url,
    token: arg('token') ?? process.env.SYNAPSE_TALLY_TOKEN ?? fromFile.token,
    tally: arg('tally') ?? process.env.TALLY_URL ?? fromFile.tally ?? 'http://localhost:9000',
    every: Number(arg('every') ?? fromFile.every ?? 10),
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
  };
  if (!cfg.url || !cfg.token) throw new Error('Give --url and --token (from SanchalanOS: Billing & GST → Tally)');
  return cfg;
}

const log = (...a) => console.log(new Date().toLocaleString('en-IN'), ...a);

async function synapse(cfg, path, body) {
  const res = await fetch(`${cfg.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SanchalanOS ${res.status}: ${j?.error?.message ?? res.statusText}`);
  return j;
}

async function tally(cfg, xml) {
  const res = await fetch(cfg.tally, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' }, body: xml });
  return res.text();
}

async function pushOnce(cfg) {
  let rounds = 0;
  let sent = 0;
  let failed = 0;
  while (rounds++ < 10) {
    const batch = await synapse(cfg, '/pull', { limit: 50 });
    if (!batch.items.length) break;
    const results = [];
    for (const it of batch.items) {
      if (cfg.dryRun) {
        log(`[dry run] would import ${it.kind} ${it.name}`);
        continue;
      }
      let r = parseImportResponse(await tally(cfg, it.xml));
      // an existing ledger is updated instead
      if (!r.ok && it.alterXml && r.messages.some((m) => /already exists|duplicate/i.test(m))) r = parseImportResponse(await tally(cfg, it.alterXml));
      results.push({ kind: it.kind, id: it.id, ok: r.ok, error: r.ok ? null : r.messages.join('; ').slice(0, 900) || 'Tally rejected it' });
      r.ok ? sent++ : failed++;
      if (!r.ok) log(`✗ ${it.kind} ${it.name}: ${results.at(-1).error}`);
    }
    if (cfg.dryRun) break;
    await synapse(cfg, '/ack', { results });
    if (!batch.more) break;
  }
  return { sent, failed };
}

async function pullReceipts(cfg, hello) {
  if (hello.config?.importReceipts === false) return { imported: 0 };
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  // look back a week past the last run: receipts are often entered late; duplicates are ignored
  const since = state.lastReceiptsTo ? new Date(Date.parse(state.lastReceiptsTo) - 7 * 86400_000) : new Date(Date.parse(hello.config?.syncFrom ?? fmt(today)));
  const xml = await tally(cfg, receiptsRequest(hello.config?.companyName, fmt(since), fmt(today)));
  const receipts = parseReceipts(xml);
  if (cfg.dryRun) {
    log(`[dry run] ${receipts.length} receipts found in Tally`);
    return { imported: 0 };
  }
  let imported = 0;
  for (let i = 0; i < receipts.length; i += 100) {
    const r = await synapse(cfg, '/receipts', { receipts: receipts.slice(i, i + 100) });
    imported += r.imported;
    for (const u of r.unmatched ?? []) log(`? receipt not matched to a customer: ${u}`);
  }
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastReceiptsTo: today.toISOString() }, null, 2));
  return { imported };
}

async function cycle(cfg) {
  const hello = await synapse(cfg, '/hello');
  const push = await pushOnce(cfg);
  const rec = await pullReceipts(cfg, hello).catch((e) => (log(`receipts: ${e.message}`), { imported: 0 }));
  log(`${hello.workspace}: ${push.sent} sent to Tally${push.failed ? `, ${push.failed} failed` : ''}; ${rec.imported} receipts from Tally`);
}

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  log(`SanchalanOS ⇄ Tally connector. Tally at ${cfg.tally}. ${cfg.once ? 'One run.' : `Every ${cfg.every} minutes; Ctrl+C to stop.`}`);
  for (;;) {
    try {
      await cycle(cfg);
    } catch (e) {
      log(`! ${e.message}${/ECONNREFUSED|fetch failed/.test(e.message) ? ' (is Tally open with its XML server on?)' : ''}`);
    }
    if (cfg.once) return;
    await new Promise((r) => setTimeout(r, Math.max(1, cfg.every) * 60_000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
