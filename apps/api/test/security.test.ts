import { beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../src/lib/totp';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let ownerToken: string;
const NEW_PW = 'An0ther-Str0ng-Pass!';

beforeAll(async () => {
  h = await makeHarness('synapse_test_security');
  await h.signup('acme', 'owner@acme.test');
  ownerToken = (await h.login('acme', 'owner@acme.test')).token;
  api = h.as('acme', ownerToken);
}, 90_000);

async function addUser(email: string, roles = ['sales_rep']) {
  const r = await api('POST', '/api/admin/users', { email, fullName: email.split('@')[0], password: PW, roles });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}

describe('two-factor sign-in', () => {
  let secret: string;
  let recovery: string[];

  it('enrols with an authenticator code and returns one-time recovery codes', async () => {
    const s = await api('POST', '/api/auth/mfa/setup');
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    secret = s.json.secret;
    expect(s.json.uri).toMatch(/^otpauth:\/\/totp\/SanchalanOS/);
    expect((await api('POST', '/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    const e = await api('POST', '/api/auth/mfa/enable', { code: await totpAt(secret) });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    recovery = e.json.recoveryCodes;
    expect(recovery.length).toBe(10);
    expect((await api('GET', '/api/auth/me')).json.security).toEqual({ mfaEnabled: true, mfaRequired: false });
  });

  it('password alone no longer signs in; the code (not replayable) or a recovery code does', async () => {
    const step1 = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'owner@acme.test', password: PW } });
    expect(step1.status).toBe(200);
    expect(step1.json.mfaRequired).toBe(true);
    expect(step1.json.accessToken).toBeUndefined();
    expect((await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step1.json.challenge, code: '123456' } })).status).toBe(401);
    // the code used at enrolment cannot be replayed; the next one works
    const ok = await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step1.json.challenge, code: await totpAt(secret, Date.now() + 30_000) } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.accessToken).toBeTruthy();
    expect((await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step1.json.challenge, code: await totpAt(secret, Date.now() + 30_000) } })).status).toBe(401);

    const step2 = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'owner@acme.test', password: PW } });
    const rec = await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step2.json.challenge, recoveryCode: recovery[0] } });
    expect(rec.status).toBe(200);
    const step3 = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'owner@acme.test', password: PW } });
    expect((await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step3.json.challenge, recoveryCode: recovery[0] } })).status).toBe(401);
  });

  it('a workspace can require two-factor; members without it are held at setup', async () => {
    await addUser('rep1@acme.test');
    const rep = h.as('acme', (await h.login('acme', 'rep1@acme.test')).token);
    expect((await rep('PUT', '/api/admin/security', { requireMfa: true })).status).toBe(403);
    expect((await api('PUT', '/api/admin/security', { requireMfa: true })).status).toBe(200);
    const blocked = await rep('GET', '/api/v1/records/lead');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('mfa_setup_required');
    expect((await rep('GET', '/api/auth/me')).json.security).toEqual({ mfaEnabled: false, mfaRequired: true });
    expect((await api('GET', '/api/v1/records/lead')).status).toBe(200);
    // the owner cannot switch two-factor off while it is required
    expect((await api('POST', '/api/auth/mfa/disable', { password: PW, code: await totpAt(secret, Date.now() + 60_000) })).status).toBe(400);
    expect((await api('PUT', '/api/admin/security', { requireMfa: false })).status).toBe(200);
    expect((await rep('GET', '/api/v1/records/lead')).status).toBe(200);
    const sec = (await api('GET', '/api/admin/security')).json;
    expect(sec.stats).toMatchObject({ users: 2, mfa: 1 });
  });

  it('an admin can reset a member’s two-factor', async () => {
    const id = await addUser('rep2@acme.test');
    const rep = h.as('acme', (await h.login('acme', 'rep2@acme.test')).token);
    const s = await rep('POST', '/api/auth/mfa/setup');
    expect((await rep('POST', '/api/auth/mfa/enable', { code: await totpAt(s.json.secret) })).status).toBe(200);
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'rep2@acme.test', password: PW } })).json.mfaRequired).toBe(true);
    expect((await api('POST', `/api/admin/users/${id}/reset-mfa`)).status).toBe(200);
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'rep2@acme.test', password: PW } })).json.accessToken).toBeTruthy();
  });
});

describe('invitations and password resets', () => {
  it('invites by link; the invitee sets a password and is signed in', async () => {
    const r = await api('POST', '/api/admin/users/invite', { email: 'new@acme.test', fullName: 'New Person', roles: ['sales_rep'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.emailed).toBe(false);
    const token = new URL(r.json.inviteUrl).searchParams.get('token')!;
    expect(new URL(r.json.inviteUrl).searchParams.get('workspace')).toBe('acme');
    const info = await h.call('GET', `/api/auth/invite/${token}`, { tenant: 'acme' });
    expect(info.json).toMatchObject({ email: 'new@acme.test', fullName: 'New Person' });
    // invited people cannot sign in before accepting
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'new@acme.test', password: PW } })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: 'weak' } })).status).toBe(400);
    const acc = await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: NEW_PW } });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect(acc.json.accessToken).toBeTruthy();
    expect((await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: NEW_PW } })).status).toBe(404);
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'new@acme.test', password: NEW_PW } })).status).toBe(200);
    // the same token is useless in another workspace
    await h.signup('globex', 'owner@globex.test');
    expect((await h.call('GET', `/api/auth/invite/${token}`, { tenant: 'globex' })).status).toBe(404);
  });

  it('reset links set a new password and end existing sessions', async () => {
    const id = await addUser('forgetful@acme.test');
    const s = await h.login('acme', 'forgetful@acme.test');
    const f = await h.call('POST', '/api/auth/password/forgot', { tenant: 'acme', body: { email: 'forgetful@acme.test' } });
    expect(f.json).toEqual({ ok: true, emailed: false });
    expect((await h.call('POST', '/api/auth/password/forgot', { tenant: 'acme', body: { email: 'nobody@acme.test' } })).json).toEqual({ ok: true, emailed: false });
    const link = await api('POST', `/api/admin/users/${id}/reset-link`);
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    const token = new URL(link.json.resetUrl).searchParams.get('token')!;
    expect((await h.call('POST', '/api/auth/password/reset', { tenant: 'acme', body: { token, password: NEW_PW } })).status).toBe(200);
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'forgetful@acme.test', password: PW } })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'forgetful@acme.test', password: NEW_PW } })).status).toBe(200);
    expect((await h.call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: s.cookie, headers: { 'x-requested-with': 'synapse' } })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/password/reset', { tenant: 'acme', body: { token, password: NEW_PW } })).status).toBe(404);
  });

  it('lists and revokes my own sessions', async () => {
    const a = await h.login('acme', 'rep1@acme.test');
    await h.login('acme', 'rep1@acme.test');
    const me = h.as('acme', a.token);
    const list = (await me('GET', '/api/auth/sessions')).json.items;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((x: Json) => x.current).length).toBe(1);
    expect((await me('POST', '/api/auth/sessions/revoke', { others: true })).status).toBe(200);
    expect((await me('GET', '/api/auth/sessions')).json.items.length).toBe(1);
  });
});

describe('teams, sharing rules and record shares', () => {
  it('widen own-record access exactly as configured', async () => {
    const a = await addUser('alice@acme.test');
    const bId = await addUser('bob@acme.test');
    const alice = h.as('acme', (await h.login('acme', 'alice@acme.test')).token);
    const bob = h.as('acme', (await h.login('acme', 'bob@acme.test')).token);
    const ref = (await bob('POST', '/api/v1/records/lead', { last_name: 'Referral-B', source: 'referral' })).json.id;
    const web = (await bob('POST', '/api/v1/records/lead', { last_name: 'Website-B', source: 'website' })).json.id;
    expect((await alice('GET', `/api/v1/records/lead/${ref}`)).status).toBe(404);

    const team = await api('POST', '/api/admin/teams', { name: 'Referral desk', memberIds: [a] });
    expect(team.status, JSON.stringify(team.json)).toBe(201);
    expect((await api('POST', '/api/admin/teams', { name: 'Referral desk' })).status).toBe(409);
    const rule = await api('POST', '/api/admin/sharing-rules', { objectKey: 'lead', name: 'Referral leads to the desk', criteria: [{ field: 'source', op: 'eq', value: 'referral' }], teamId: team.json.id, access: 'read' });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    expect((await api('POST', '/api/admin/sharing-rules', { objectKey: 'lead', name: 'bad', teamId: team.json.id, roleKey: 'sales_rep' })).status).toBe(400);

    const seen = (await alice('GET', '/api/v1/records/lead')).json.items.map((x: Json) => x.last_name);
    expect(seen).toContain('Referral-B');
    expect(seen).not.toContain('Website-B');
    expect((await alice('PATCH', `/api/v1/records/lead/${ref}`, { company: 'x' })).status).toBe(404);
    // reports respect the same visibility
    const agg = await alice('POST', '/api/v1/reports/run', { objectKey: 'lead', definition: { type: 'summary', measure: { agg: 'count' } } });
    expect(agg.json.rows[0].value).toBe(1);

    // per-record share with edit access
    expect((await alice('POST', `/api/v1/records/lead/${web}/shares`, { userId: a, access: 'edit' })).status).toBe(404);
    expect((await bob('POST', `/api/v1/records/lead/${web}/shares`, { userId: a, access: 'edit' })).status).toBe(201);
    expect((await alice('PATCH', `/api/v1/records/lead/${web}`, { company: 'Shared Co' })).status).toBe(200);
    expect((await alice('DELETE', `/api/v1/records/lead/${web}`)).status).toBe(403);
    const shares = (await bob('GET', `/api/v1/records/lead/${web}/shares`)).json.items;
    expect(shares[0]).toMatchObject({ user_name: 'alice', access: 'edit' });
    await bob('DELETE', `/api/v1/records/lead/${web}/shares?userId=${a}`);
    expect((await alice('GET', `/api/v1/records/lead/${web}`)).status).toBe(404);

    // turning the rule off removes access
    await api('PUT', `/api/admin/sharing-rules/${rule.json.id}`, { objectKey: 'lead', name: 'Referral leads to the desk', criteria: [{ field: 'source', op: 'eq', value: 'referral' }], teamId: team.json.id, access: 'read', isActive: false });
    expect((await alice('GET', `/api/v1/records/lead/${ref}`)).status).toBe(404);
    void bId;
  });

  it('team leads see their team’s records under team access', async () => {
    await api('POST', '/api/admin/roles', { key: 'team_lead', name: 'Team lead', permissions: { objects: { '*': { read: 'team', create: true, update: 'team', delete: 'none' } } } });
    const leadId = await addUser('lead@acme.test', ['team_lead']);
    const memberId = await addUser('member@acme.test');
    const outsider = h.as('acme', (await h.login('acme', 'rep1@acme.test')).token);
    const member = h.as('acme', (await h.login('acme', 'member@acme.test')).token);
    const lead = h.as('acme', (await h.login('acme', 'lead@acme.test')).token);
    const m = (await member('POST', '/api/v1/records/lead', { last_name: 'Member-lead' })).json.id;
    const o = (await outsider('POST', '/api/v1/records/lead', { last_name: 'Outsider-lead' })).json.id;
    expect((await lead('GET', `/api/v1/records/lead/${m}`)).status).toBe(404);
    await api('POST', '/api/admin/teams', { name: 'West', leadId, memberIds: [memberId] });
    const lead2 = h.as('acme', (await h.login('acme', 'lead@acme.test')).token);
    expect((await lead2('GET', `/api/v1/records/lead/${m}`)).status).toBe(200);
    expect((await lead2('PATCH', `/api/v1/records/lead/${m}`, { company: 'Coached' })).status).toBe(200);
    expect((await lead2('GET', `/api/v1/records/lead/${o}`)).status).toBe(404);
  });
});

describe('API keys', () => {
  it('authenticate integrations with read or write scope and can be revoked', async () => {
    const r = await api('POST', '/api/admin/api-keys', { name: 'Website sync', scopes: ['read'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const key = r.json.key as string;
    expect(key.startsWith('syn_acme_')).toBe(true);
    // no X-Tenant needed: the workspace is in the key
    const list = await h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key}` } });
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect((await h.call('GET', '/api/v1/records/lead', { headers: { 'x-api-key': key } })).status).toBe(200);
    expect((await h.call('POST', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key}` }, body: { last_name: 'Nope' } })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/users', { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    expect((await h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key.slice(0, -2)}xx` } })).status).toBe(401);

    const w = await api('POST', '/api/admin/api-keys', { name: 'Zapier', scopes: ['write'], expiresInDays: 30 });
    expect(w.json.scopes).toEqual(['read', 'write']);
    const created = await h.call('POST', '/api/v1/records/lead', { headers: { authorization: `Bearer ${w.json.key}` }, body: { last_name: 'From API' } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const keys = (await api('GET', '/api/admin/api-keys')).json.items;
    const listed = keys.find((k: Json) => k.id === r.json.id);
    expect(listed.prefix.endsWith('…')).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(key);
    expect(listed.last_used_at).toBeTruthy();
    expect((await api('DELETE', `/api/admin/api-keys/${r.json.id}`)).status).toBe(200);
    expect((await h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});

describe('hardening', () => {
  it('parallel MFA guesses cannot exceed five per challenge', async () => {
    await addUser('brute@acme.test');
    const me = h.as('acme', (await h.login('acme', 'brute@acme.test')).token);
    const s = await me('POST', '/api/auth/mfa/setup');
    await me('POST', '/api/auth/mfa/enable', { code: await totpAt(s.json.secret) });
    const step = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'brute@acme.test', password: PW } });
    const guesses = await Promise.all(Array.from({ length: 12 }, (_, i) => h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step.json.challenge, code: String(100000 + i) } })));
    expect(guesses.filter((g) => g.json.error?.code === 'mfa_invalid').length).toBeLessThanOrEqual(5);
    // the challenge is dead now, even with the right code
    expect((await h.call('POST', '/api/auth/mfa/verify', { tenant: 'acme', body: { challenge: step.json.challenge, code: await totpAt(s.json.secret, Date.now() + 30_000) } })).status).toBe(401);
  });

  it('an old invitation cannot take over an account that is already active', async () => {
    const r = await api('POST', '/api/admin/users/invite', { email: 'twice@acme.test', fullName: 'Twice' });
    const token = new URL(r.json.inviteUrl).searchParams.get('token')!;
    const second = await api('POST', `/api/admin/users/${r.json.id}/invite-link`);
    const token2 = new URL(second.json.inviteUrl).searchParams.get('token')!;
    // re-issuing voids the first link
    expect((await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: NEW_PW } })).status).toBe(404);
    expect((await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token: token2, password: NEW_PW } })).status).toBe(200);
  });

  it('rejects sharing rules whose operator or value cannot work', async () => {
    const team = (await api('GET', '/api/admin/teams')).json.items[0];
    expect((await api('POST', '/api/admin/sharing-rules', { objectKey: 'lead', name: 'x', criteria: [{ field: 'source', op: 'drop table', value: 'x' }], teamId: team.id })).status).toBe(400);
    expect((await api('POST', '/api/admin/sharing-rules', { objectKey: 'deal', name: 'x', criteria: [{ field: 'amount', op: 'gt', value: 'abc' }], teamId: team.id })).status).toBe(400);
    expect((await api('POST', '/api/admin/sharing-rules', { objectKey: 'lead', name: 'x', criteria: [{ field: 'source', op: 'eq', value: 'not-a-choice' }], teamId: team.id })).status).toBe(400);
    expect((await api('POST', '/api/admin/sharing-rules', { objectKey: 'deal', name: 'Big deals', criteria: [{ field: 'amount', op: 'gte', value: 100000 }], teamId: team.id })).status).toBe(201);
  });

  it('API keys cannot reach auth, admin or AI endpoints', async () => {
    const k = (await api('POST', '/api/admin/api-keys', { name: 'Probe', scopes: ['write'] })).json.key;
    for (const path of ['/api/auth/me', '/api/ai/status', '/api/admin/usage']) {
      expect([401, 403]).toContain((await h.call('GET', path, { tenant: 'acme', headers: { authorization: `Bearer ${k}` } })).status);
    }
  });

  it('signing out everywhere ends other sessions immediately', async () => {
    const a = await h.login('acme', 'rep1@acme.test');
    const b = await h.login('acme', 'rep1@acme.test');
    expect((await h.as('acme', b.token)('GET', '/api/v1/records/lead')).status).toBe(200);
    await h.as('acme', a.token)('POST', '/api/auth/sessions/revoke', { others: true });
    expect((await h.as('acme', b.token)('GET', '/api/v1/records/lead')).status).toBe(401);
    expect((await h.as('acme', a.token)('GET', '/api/v1/records/lead')).status).toBe(200);
  });
});

describe('usage', () => {
  it('summarises the workspace', async () => {
    const u = await api('GET', '/api/admin/usage');
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.users.active).toBeGreaterThan(3);
    expect(u.json.records.lead).toBeGreaterThan(3);
    expect(u.json.apiKeys.active).toBeGreaterThanOrEqual(1);
  });
});
