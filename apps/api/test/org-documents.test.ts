import { beforeAll, describe, expect, it } from 'vitest';
import { fakeR2, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let ownerToken = '';
let r2: ReturnType<typeof fakeR2>;

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function uploadTo(id: string, bytes: Uint8Array, name = 'copy.pdf') {
  const res = await h.app.request(
    `http://synapse.test/api/v1/organisation/documents/${id}/file?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${ownerToken}`, 'content-type': 'application/octet-stream' }, body: bytes },
    h.env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_orgdocs');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  ownerToken = (await h.login('acme', 'owner@acme.test')).token;
  api = h.as('acme', ownerToken);
  await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
}, 120_000);

describe('organisation profile: Startup India', () => {
  it('keeps the DPIIT recognition and checks its number', async () => {
    const base = (await api('GET', '/api/v1/organisation')).json.profile;
    const bad = await api('PUT', '/api/v1/organisation', { ...base, legalName: 'HRP AI LLP', dpiitNumber: '12345' });
    expect(bad.status).toBe(400);
    const ok = await api('PUT', '/api/v1/organisation', { ...base, legalName: 'HRP AI LLP', dpiitNumber: 'dipp154321', dpiitRecognisedOn: '2025-02-10', startupSector: 'Artificial Intelligence', section56Exempt: true, section80IacFrom: '2026-27' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.profile).toMatchObject({ dpiitNumber: 'DIPP154321', dpiitRecognisedOn: '2025-02-10', section56Exempt: true, section80IacFrom: '2026-27' });
  });
});

describe('organisation documents', () => {
  let docId = '';
  let personId = '';
  it('adds a company document with its copy, and replaces the copy', async () => {
    expect((await api('POST', '/api/v1/organisation/documents', { kind: 'pan', number: 'AASFH68' })).status).toBe(400);
    const c = await api('POST', '/api/v1/organisation/documents', { kind: 'pan', number: 'AASFH6805J', issuedOn: '2024-04-01' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    docId = c.json.id;
    const u = await uploadTo(docId, PDF);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.file).toMatchObject({ name: 'copy.pdf', contentType: 'application/pdf' });
    expect(u.json.file.url).toMatch(/^\/api\/public\/files\//);
    const first = u.json.file.id;
    // the signed link serves it; the generic file route does not
    const got = await h.app.request(`http://synapse.test${u.json.file.downloadUrl}`, {}, h.env);
    expect(got.status).toBe(200);
    expect((await api('GET', `/api/v1/files/${first}`, undefined, { raw: true })).status).not.toBe(200);
    const again = await uploadTo(docId, PDF, 'pan-new.pdf');
    expect(again.json.file.id).not.toBe(first);
    expect(r2.store.size).toBe(1);
  });

  it('keeps documents for a partner and drops them with the partner', async () => {
    const p = await api('POST', '/api/v1/organisation/people', { name: 'Prashant', role: 'partner', identifiers: [{ kind: 'mobile', value: '9311421118' }] });
    expect(p.status, JSON.stringify(p.json)).toBeLessThan(300);
    personId = p.json.id ?? p.json.person?.id;
    expect(personId).toBeTruthy();
    expect((await api('POST', '/api/v1/organisation/documents', { personId, kind: 'gst' })).status).toBe(400); // not a person's document
    expect((await api('POST', '/api/v1/organisation/documents', { personId, kind: 'aadhaar', number: '1234' })).status).toBe(400);
    const a = await api('POST', '/api/v1/organisation/documents', { personId, kind: 'aadhaar', number: 'XXXXXXXX4321' });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect((await uploadTo(a.json.id, PDF, 'aadhaar.pdf')).status).toBe(200);
    const list = (await api('GET', '/api/v1/organisation/documents')).json;
    expect(list.documents.map((d: any) => [d.kind, d.personName])).toEqual([
      ['pan', null],
      ['aadhaar', 'Prashant'],
    ]);
    expect(list.companyKinds.find((k: any) => k.key === 'startup_india')).toMatchObject({ profileField: 'dpiitNumber' });
    expect((await api('DELETE', `/api/v1/organisation/people/${personId}`)).status).toBe(200);
    const after = (await api('GET', '/api/v1/organisation/documents')).json.documents;
    expect(after).toHaveLength(1);
  });

  it('flags expiry and is for managers only', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const s = await api('POST', '/api/v1/organisation/documents', { kind: 'shops_establishment', number: 'SE/123', validUntil: soon });
    expect(s.json.status).toBe('expiring');
    expect((await api('POST', '/api/v1/organisation/documents', { kind: 'other' })).status).toBe(400);
    expect((await rep('GET', '/api/v1/organisation/documents')).status).toBe(403);
    expect((await rep('DELETE', `/api/v1/organisation/documents/${docId}`)).status).toBe(403);
    expect((await api('DELETE', `/api/v1/organisation/documents/${docId}`)).status).toBe(200);
    expect(r2.store.size).toBe(0);
  });
});

describe('identity of people onboarded (PAN, Aadhaar, UAN, PF)', () => {
  it('keeps a team member\'s numbers, Aadhaar encrypted and masked', async () => {
    const users = (await api('GET', '/api/v1/organisation')).json.users as any[];
    const repId = users.find((u) => u.email === 'rep@acme.test').id;
    expect((await api('PUT', `/api/v1/identity/user/${repId}`, { aadhaar: '234567890123' })).status).toBe(400); // check digit
    expect((await api('PUT', `/api/v1/identity/user/${repId}`, { uan: '1234' })).status).toBe(400);
    expect((await api('PUT', `/api/v1/identity/user/${repId}`, { pfNumber: 'nonsense' })).status).toBe(400);
    const r = await api('PUT', `/api/v1/identity/user/${repId}`, { pan: 'abcde1234f', aadhaar: '2345 6789 0124', uan: '100123456789', pfNumber: 'mh/ban/12345/000/678' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ pan: 'ABCDE1234F', aadhaar: 'XXXX XXXX 0124', hasAadhaar: true, uan: '100123456789', pfNumber: 'MH/BAN/12345/000/678' });
    expect(JSON.stringify(r.json)).not.toContain('234567890124');
    // a later save without Aadhaar keeps it; an empty string removes it
    expect((await api('PUT', `/api/v1/identity/user/${repId}`, { uan: '100123456789', pfNumber: 'MH/BAN/12345/000/678' })).json.hasAadhaar).toBe(true);
    const shown = await api('POST', `/api/v1/identity/user/${repId}/reveal-aadhaar`, {});
    expect(shown.json.aadhaar).toBe('2345 6789 0124');
    // the person themselves (a sales rep, not an admin) cannot read it
    expect((await rep('GET', `/api/v1/identity/user/${repId}`)).status).toBe(403);
    // a copy of the Aadhaar keeps only the last four digits as its number
    const doc = await api('POST', '/api/v1/organisation/documents', { userId: repId, kind: 'aadhaar', number: '234567890124' });
    expect(doc.status, JSON.stringify(doc.json)).toBe(201);
    expect(doc.json.number).toBe('XXXXXXXX0124');
    expect((await uploadTo(doc.json.id, PDF, 'aadhaar.pdf')).status).toBe(200);
    const got = (await api('GET', `/api/v1/identity/user/${repId}`)).json;
    expect(got.documents.map((d: any) => d.kind)).toEqual(['aadhaar']);
    expect((await api('PUT', `/api/v1/identity/user/${repId}`, { aadhaar: '' })).json.hasAadhaar).toBe(false);
  });

  it('keeps a partner\'s, with PAN on the partner', async () => {
    const p = await api('POST', '/api/v1/organisation/people', { name: 'Harsha', role: 'partner', identifiers: [{ kind: 'mobile', value: '9811122233' }] });
    const pid = p.json.id;
    const r = await api('PUT', `/api/v1/identity/partner/${pid}`, { pan: 'BCDEF2345G', aadhaar: '987654321012', uan: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ pan: 'BCDEF2345G', aadhaar: 'XXXX XXXX 1012' });
    const people = (await api('GET', '/api/v1/organisation/people')).json.persons as any[];
    expect(people.find((x) => x.id === pid).pan).toBe('BCDEF2345G');
  });
});
