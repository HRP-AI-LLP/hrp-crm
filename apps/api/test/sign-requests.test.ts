/** Signature requests: a professional uploads a PDF to be signed, an admin signs it with a soft
 * certificate, and the signed copy comes back for the professional to download. */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { testIdentity, toPfx, verifyPdf } from '../src/lib/pdf-sign';
import { fakeR2, makeHarness } from './harness';

type Json = Record<string, any>;
let h: Awaited<ReturnType<typeof makeHarness>>;
let owner: ReturnType<typeof h.as>;
let ca: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const CA_EMAIL = 'ca@firm.test';
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

async function pdf(text: string) {
  const d = await PDFDocument.create();
  d.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  return d.save();
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_signreq');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  await h.signup('firm', 'owner@firm.test');
  owner = h.as('firm', (await h.login('firm', 'owner@firm.test')).token);
  ids.me = (await owner('GET', '/api/auth/me')).json.user.id;
  // a soft certificate the owner can sign with
  const id = testIdentity('HRP AI LLP');
  ids.cert = (await owner('POST', '/api/v1/organisation/dsc/pfx', { label: 'Company DSC', pfx: b64(toPfx(id.key, id.cert, 'pw')), password: 'pw', userIds: [ids.me] })).json.id;
  // a CA with a login, added as a professional
  await owner('POST', '/api/admin/users', { email: CA_EMAIL, fullName: 'Asha CA', password: 'Sup3r!pass' });
  await owner('POST', '/api/v1/organisation/professionals', { email: CA_EMAIL, fullName: 'Asha CA', kind: 'ca', modules: { gst: 'edit' }, canFile: true });
  ca = h.as('firm', (await h.login('firm', CA_EMAIL, 'Sup3r!pass')).token);
}, 120_000);

describe('Signature requests', () => {
  it('a professional uploads a document to be signed', async () => {
    const r = await ca('POST', '/api/v1/professionals/me/sign-requests', { name: 'Form 15CB', note: 'For the remittance', pdf: b64(await pdf('FORM 15CB')) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.req = r.json.id;

    const mine = await ca('GET', '/api/v1/professionals/me/sign-requests');
    expect(mine.json.items[0]).toMatchObject({ id: ids.req, name: 'Form 15CB', status: 'pending' });
    expect(mine.json.items[0].signedUrl).toBeNull();
  });

  it('an admin sees it and signs it with the company certificate', async () => {
    const list = await owner('GET', '/api/v1/organisation/sign-requests');
    const row = (list.json.items as Json[]).find((x) => x.id === ids.req)!;
    expect(row).toMatchObject({ name: 'Form 15CB', status: 'pending', requestedBy: 'Asha CA' });
    expect(row.sourceUrl).toBeTruthy();

    const signed = await owner('POST', `/api/v1/organisation/sign-requests/${ids.req}/sign`, { certificateId: ids.cert });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    expect(signed.json.signedUrl).toBeTruthy();

    // the signed PDF actually carries a valid digital signature
    const res = await h.app.request(new URL(signed.json.signedUrl, 'http://synapse.test').toString(), { headers: { 'x-tenant': 'firm' } }, h.env);
    const v = verifyPdf(new Uint8Array(await res.arrayBuffer()));
    expect(v.ok, v.reason).toBe(true);
  });

  it('the professional can now download the signed copy', async () => {
    const mine = await ca('GET', '/api/v1/professionals/me/sign-requests');
    const row = (mine.json.items as Json[]).find((x) => x.id === ids.req)!;
    expect(row.status).toBe('signed');
    expect(row.signedUrl).toBeTruthy();
  });

  it('refuses a second decision and rejects non-PDF uploads', async () => {
    const again = await owner('POST', `/api/v1/organisation/sign-requests/${ids.req}/reject`, {});
    expect(again.status).toBe(400); // already signed

    const bad = await ca('POST', '/api/v1/professionals/me/sign-requests', { name: 'notes', pdf: Buffer.from('hello world not a pdf at all......').toString('base64') });
    expect(bad.status).toBe(400);
  });
});
