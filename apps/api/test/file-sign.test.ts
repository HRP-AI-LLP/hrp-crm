/** Signing any attached file: preview info, a saved signature stamped on the pages, a DSC (.pfx), withdrawal, public check. */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { testIdentity, toPfx, verifyPdf } from '../src/lib/pdf-sign';
import { fakeR2, makeHarness, PW } from './harness';

type Json = Record<string, any>;
let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let token = '';
let r2: ReturnType<typeof fakeR2>;
const ids: Record<string, string> = {};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

async function upload(object: string, id: string, name: string, bytes: Uint8Array, tok = token) {
  const res = await h.app.request(
    `http://synapse.test/api/v1/files?object=${object}&id=${id}&name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' }, body: bytes },
    h.env,
  );
  return { status: res.status, json: (await res.json()) as Json };
}
async function stored(fileId: string) {
  const f = ((await api('GET', `/api/v1/files?object=account&id=${ids.acc}`)).json.items as Json[]).find((x) => x.id === fileId)!;
  const res = await h.app.request(new URL(f.downloadUrl, 'http://synapse.test').toString(), { headers: { 'x-tenant': 'acme' } }, h.env);
  return new Uint8Array(await res.arrayBuffer());
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_filesign');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  token = (await h.login('acme', 'owner@acme.test')).token;
  api = h.as('acme', token);
  ids.me = (await api('GET', '/api/auth/me')).json.user.id;
  ids.acc = (await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India' })).json.id;
  const d = await PDFDocument.create();
  for (let i = 0; i < 3; i++) d.addPage([595, 842]).drawText(`Work order page ${i + 1}`, { x: 50, y: 780, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  const up = await upload('account', ids.acc!, 'Work order.pdf', await d.save());
  expect(up.status, JSON.stringify(up.json)).toBe(201);
  ids.pdf = up.json.id;
  ids.sig = (await api('POST', '/api/v1/organisation/signatures', { signerName: 'Prashant Srivastava', designation: 'CTO', image: PNG, userIds: [ids.me] })).json.id;
}, 120_000);

describe('signing an attached file', () => {
  it('tells what can be done with it', async () => {
    const r = await api('GET', `/api/v1/files/${ids.pdf}/signing`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ preview: 'pdf', pages: 3, canSign: true, digital: null, signatures: [] });
    expect(r.json.imageSignatures.map((s: Json) => s.signerName)).toEqual(['Prashant Srivastava']);
  });

  it('stamps a saved signature on every page and keeps a signed copy', async () => {
    const r = await api('POST', `/api/v1/files/${ids.pdf}/sign-image`, { signatureId: ids.sig, page: 'all', position: 'bottom-left' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.signed = r.json.fileId;
    const files = (await api('GET', `/api/v1/files?object=account&id=${ids.acc}`)).json.items as Json[];
    expect(files.map((f) => f.name)).toContain('Work order - signed.pdf');
    const doc = await PDFDocument.load(await stored(ids.signed!));
    expect(doc.getPageCount()).toBe(3);
    const s = (await api('GET', `/api/v1/files/${ids.pdf}/signing`)).json.signatures;
    expect(s[0]).toMatchObject({ signerName: 'Prashant Srivastava', method: 'image', revoked: false });
    // the public check knows the code
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    const v = await h.call('GET', `/api/public/verify/${tenant}/${r.json.verifyCode}`);
    expect(v.status, v.text).toBe(200);
    expect(v.json).toMatchObject({ found: true, valid: true, document: { type: 'file', number: 'Work order.pdf' } });
  });

  it('digitally signs the signed copy with a .pfx, then refuses to change it', async () => {
    const id = testIdentity('PRASHANT SRIVASTAVA');
    const cert = await api('POST', '/api/v1/organisation/dsc/pfx', { label: 'Prashant (Class 3)', pfx: b64(toPfx(id.key, id.cert, 'pw')), password: 'pw', userIds: [ids.me] });
    expect(cert.status, JSON.stringify(cert.json)).toBe(201);
    const r = await api('POST', `/api/v1/files/${ids.signed}/dsc/pfx`, { certificateId: cert.json.id, page: 'last', position: 'bottom-right' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const bytes = await stored(r.json.fileId);
    const v = verifyPdf(bytes);
    expect(v.ok, v.reason).toBe(true);
    expect(v.coversWholeFile).toBe(true);
    const info = (await api('GET', `/api/v1/files/${r.json.fileId}/signing`)).json;
    expect(info).toMatchObject({ canSign: false, digital: { valid: true } });
    expect(info.signatures.map((x: Json) => x.method)).toEqual(['image', 'dsc_pfx']);
    expect((await api('POST', `/api/v1/files/${r.json.fileId}/sign-image`, { signatureId: ids.sig })).status).toBe(400);
  });

  it('signs a photo as a PDF, refuses other files and people who cannot change the record', async () => {
    const d = await PDFDocument.create();
    const png = Uint8Array.from(Buffer.from(PNG.split(',')[1]!, 'base64'));
    void d;
    const photo = await upload('account', ids.acc!, 'Delivery challan.png', png);
    expect(photo.status, JSON.stringify(photo.json)).toBe(201);
    expect((await api('POST', `/api/v1/files/${photo.json.id}/sign-image`, { signatureId: ids.sig })).status).toBe(201);
    const txt = await upload('account', ids.acc!, 'notes.csv', new TextEncoder().encode('a,b\n1,2\n'));
    expect((await api('GET', `/api/v1/files/${txt.json.id}/signing`)).json).toMatchObject({ canSign: false, preview: 'text' });
    expect((await api('POST', `/api/v1/files/${txt.json.id}/sign-image`, { signatureId: ids.sig })).status).toBe(400);
    await api('POST', '/api/admin/users', { email: 'ro@acme.test', fullName: 'Viewer', password: PW, roles: ['read_only'] });
    const ro = h.as('acme', (await h.login('acme', 'ro@acme.test')).token);
    expect((await ro('GET', `/api/v1/files/${ids.pdf}/signing`)).json.canSign).toBe(false);
    expect((await ro('POST', `/api/v1/files/${ids.pdf}/sign-image`, { signatureId: ids.sig })).status).toBe(403);
  });

  it('withdraws a signature', async () => {
    const s = (await api('GET', `/api/v1/files/${ids.pdf}/signing`)).json.signatures[0];
    expect((await api('POST', `/api/v1/files/${ids.pdf}/signatures/${s.id}/revoke`, { reason: 'Wrong page' })).status).toBe(200);
    expect((await api('GET', `/api/v1/files/${ids.pdf}/signing`)).json.signatures[0].revoked).toBe(true);
  });
});
