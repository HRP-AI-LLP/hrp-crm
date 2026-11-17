import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { testIdentity, toPfx, verifyPdf } from '../src/lib/pdf-sign';
import { fakeR2, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let r2: ReturnType<typeof fakeR2>;
const ids: Record<string, string> = {};
let ownerId = '';
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

async function invoicePdf(no: string) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  p.drawText(`TAX INVOICE ${no}`, { x: 50, y: 780, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  return d.save();
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_dsc');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  ownerId = (await api('GET', '/api/auth/me')).json.user.id;
  for (const a of ['orders', 'billing']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh' } } });
  await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  const acc = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', state: 'Uttar Pradesh' })).json.id;
  const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: acc })).json.id;
  await api('PUT', `/api/v1/invoices/${inv}/lines`, { taxInclusive: true, lines: [{ name: 'Maintenance', quantity: 1, unitPrice: 1200, taxRate: 18 }] });
  ids.draft = inv;
  const inv2 = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: acc })).json.id;
  await api('PUT', `/api/v1/invoices/${inv2}/lines`, { lines: [{ name: 'Maintenance', quantity: 1, unitPrice: 3000, taxRate: 18 }] });
  expect((await api('POST', `/api/v1/invoices/${inv2}/issue`)).status).toBe(200);
  ids.inv = inv2;
}, 120_000);

describe('document templates', () => {
  it('keeps designs, one default per kind of document', async () => {
    const a = await api('POST', '/api/v1/doc-templates', { name: 'Modern blue', base: 'modern', settings: { accent: '#0b3d91', columns: { discount: false } } });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const b = await api('POST', '/api/v1/doc-templates', { name: 'With script', base: 'html', settings: {}, html: '<style>h1{color:red}</style><h1 onclick="x()">{{doc.number}}</h1><script>alert(1)</script>{{#lines}}{{name}}{{/lines}}' });
    expect(b.status).toBe(201);
    const list = (await api('GET', '/api/v1/doc-templates')).json.templates as any[];
    // the first one became the invoice default; scripts and handlers are gone
    expect(list.find((t) => t.id === a.json.id).defaults).toEqual(['invoice']);
    const html = list.find((t) => t.id === b.json.id).html;
    expect(html).not.toMatch(/script|onclick/);
    expect(list.find((t) => t.id === a.json.id).settings).toMatchObject({ accent: '#0b3d91', columns: { discount: false, hsn: true }, font: 'sans' });
    expect((await api('POST', `/api/v1/doc-templates/${b.json.id}/defaults`, { kinds: ['invoice', 'quote'] })).status).toBe(200);
    const def = (await api('GET', '/api/v1/doc-templates/for/invoice')).json;
    expect(def.id).toBe(b.json.id);
    expect((await api('GET', '/api/v1/doc-templates')).json.templates.find((t: any) => t.id === a.json.id).defaults).toEqual([]);
    // a rep can print with them, not change them
    expect((await rep('GET', '/api/v1/doc-templates/for/invoice')).json.id).toBe(b.json.id);
    expect((await rep('POST', '/api/v1/doc-templates', { name: 'x', base: 'classic', settings: {} })).status).toBe(403);
    expect((await api('POST', '/api/v1/doc-templates', { name: 'Letterhead', base: 'letterhead', settings: {} })).status).toBe(400);
  });
});

describe('a DSC kept as a .pfx', () => {
  const id = testIdentity('HARSHA RANI');
  it('is added once, never handed back, and signs only for the people named', async () => {
    expect((await api('POST', '/api/v1/organisation/dsc/pfx', { label: 'Harsha (Class 3)', pfx: b64(toPfx(id.key, id.cert, 'pw')), password: 'wrong', userIds: [ownerId] })).status).toBe(400);
    const add = await api('POST', '/api/v1/organisation/dsc/pfx', { label: 'Harsha (Class 3)', pfx: b64(toPfx(id.key, id.cert, 'pw')), password: 'pw', userIds: [ownerId] });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    ids.cert = add.json.id;
    const list = (await api('GET', '/api/v1/organisation/dsc')).json;
    expect(list.certificates[0]).toMatchObject({ subjectCn: 'HARSHA RANI', kind: 'pfx', canSign: true });
    expect(JSON.stringify(list)).not.toMatch(/pfx_enc|pass_enc|BEGIN/);
    const pdf = await invoicePdf('INV/26-27/0001');
    // a draft can't be signed; a rep isn't named on the certificate
    expect((await api('POST', `/api/v1/documents/invoice/${ids.draft}/dsc/pfx`, { certificateId: ids.cert, pdf: b64(pdf) })).status).toBe(400);
    expect((await rep('POST', `/api/v1/documents/invoice/${ids.inv}/dsc/pfx`, { certificateId: ids.cert, pdf: b64(pdf) })).status).toBe(403);
    const s = await api('POST', `/api/v1/documents/invoice/${ids.inv}/dsc/pfx`, { certificateId: ids.cert, pdf: b64(pdf) }, { headers: { origin: 'https://acme.synapse.test' } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    // the signed PDF is on the invoice and verifies
    const signed = [...r2.store.values()].pop()!;
    expect(verifyPdf(signed)).toMatchObject({ ok: true, cert: { subjectCn: 'HARSHA RANI' } });
    const sigs = (await api('GET', `/api/v1/documents/invoice/${ids.inv}/signatures`)).json;
    expect(sigs[0]).toMatchObject({ method: 'dsc_pfx', signerName: 'HARSHA RANI', valid: true, fileId: s.json.fileId });
    // anyone can check the PDF they received
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    const res = await h.app.request(`http://synapse.test/api/public/verify-pdf/${tenant}`, { method: 'POST', body: signed }, h.env);
    expect(await res.json()).toMatchObject({ signatureValid: true, issuedHere: { verifyCode: s.json.verifyCode, signer: 'HARSHA RANI' } });
    expect((await h.call('GET', `/api/public/verify/${tenant}/${s.json.verifyCode}`)).json).toMatchObject({ valid: true, method: 'dsc_pfx' });
  });
});

/* The USB-token path, end to end with the real signer against a software token (SoftHSM). */
const softhsm = '/usr/lib/softhsm/libsofthsm2.so';
const canToken = existsSync(softhsm) && (() => {
  try {
    execFileSync('python3', ['-c', 'import pyhanko, pkcs11']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canToken)('a DSC on a USB token, through the local signer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-'));
  let signer: ChildProcess | null = null;
  const port = 47000 + Math.floor(Math.random() * 900);
  const origin = 'http://localhost:8787';
  afterAll(() => signer?.kill());

  it('pairs, registers the token certificate, and signs a PDF that Synapse checks', async () => {
    // a software token holding a key and certificate, like a Class 3 USB token
    const env = { ...process.env, SOFTHSM2_CONF: join(dir, 'softhsm2.conf'), SYNAPSE_DSC_CONFIG: join(dir, 'signer.json') };
    writeFileSync(env.SOFTHSM2_CONF, `directories.tokendir = ${dir}\nobjectstore.backend = file\nlog.level = ERROR\n`);
    execFileSync('softhsm2-util', ['--init-token', '--free', '--label', 'DSC', '--pin', '123456', '--so-pin', '12345678'], { env });
    const t = testIdentity('PRASHANT KUMAR');
    const forge = (await import('node-forge')).default;
    writeFileSync(join(dir, 'key.pem'), forge.pki.privateKeyToPem(t.key));
    writeFileSync(join(dir, 'cert.der'), Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(t.cert)).getBytes(), 'binary'));
    execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', join(dir, 'key.pem'), '-out', join(dir, 'key8.pem')]);
    execFileSync('softhsm2-util', ['--import', join(dir, 'key8.pem'), '--token', 'DSC', '--label', 'prashant', '--id', 'a1b2', '--pin', '123456'], { env });
    execFileSync('pkcs11-tool', ['--module', softhsm, '--login', '--pin', '123456', '--write-object', join(dir, 'cert.der'), '--type', 'cert', '--id', 'a1b2', '--label', 'prashant'], { env });

    const pair = await api('POST', '/api/v1/organisation/dsc-signers', { label: "Prashant's laptop" });
    expect(pair.status).toBe(201);
    execFileSync('python3', [join(__dirname, '../../../tools/dsc-signer/dsc_signer.py'), 'pair', pair.json.pairingCode, '--origin', origin], { env });
    signer = spawn('python3', [join(__dirname, '../../../tools/dsc-signer/dsc_signer.py'), 'serve', '--lib', softhsm, '--port', String(port)], { env, stdio: 'ignore' });
    const local = (path: string, body?: unknown, o = origin) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { origin: o, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await local('/v1/status')).ok) break;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // another website gets nothing
    expect((await local('/v1/status', undefined, 'https://evil.example')).status).toBe(403);

    const certs = (await (await local('/v1/certificates', { pin: '123456' })).json()) as any;
    expect(certs.certificates, JSON.stringify(certs)).toHaveLength(1);
    const reg = await api('POST', '/api/v1/organisation/dsc/token', { label: 'Prashant (token)', certPem: certs.certificates[0].pem, userIds: [ownerId] });
    expect(reg.status, JSON.stringify(reg.json)).toBe(201);

    const pdf = await invoicePdf('INV/26-27/0001');
    const sha = Buffer.from(await crypto.subtle.digest('SHA-256', pdf)).toString('hex');
    const tk = await api('POST', `/api/v1/documents/invoice/${ids.inv}/dsc/ticket`, { certificateId: reg.json.id, signerId: pair.json.id, pdfSha256: sha, pdfLength: pdf.length });
    expect(tk.status, JSON.stringify(tk.json)).toBe(200);
    // a different PDF is refused by the signer
    const other = await invoicePdf('INV/26-27/9999');
    expect((await local('/v1/sign', { ticket: tk.json.ticket, pdf: b64(other), pin: '123456' })).status).toBe(403);
    const sres = await local('/v1/sign', { ticket: tk.json.ticket, pdf: b64(pdf), pin: '123456' });
    const sj = (await sres.json()) as any;
    expect(sres.status, JSON.stringify(sj)).toBe(200);
    const done = await api('POST', `/api/v1/documents/invoice/${ids.inv}/dsc/token`, { ticket: tk.json.ticket, pdf: sj.pdf });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const sigs = (await api('GET', `/api/v1/documents/invoice/${ids.inv}/signatures`)).json as any[];
    expect(sigs.find((x) => x.method === 'dsc_token')).toMatchObject({ signerName: 'PRASHANT KUMAR', valid: true });
    // the same ticket can't be used twice
    expect((await api('POST', `/api/v1/documents/invoice/${ids.inv}/dsc/token`, { ticket: tk.json.ticket, pdf: sj.pdf })).status).toBe(409);
  }, 60_000);
});
