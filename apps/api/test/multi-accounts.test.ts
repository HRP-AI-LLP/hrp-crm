/** Several accounts per integration: more than one mailbox per person, more than one Razorpay / Exotel account per workspace. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { activeOf, sealSecret } from '../src/services/integrations';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}
async function addMailbox(provider: string, address: string, config: Json = {}) {
  const secret = await sealSecret(h.env, ids.tenant!, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
  const r = await sql(`insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [
    ids.tenant, provider, ids.owner, provider === 'google' ? 'Gmail' : 'Outlook', address, secret, JSON.stringify({ calendar: true, ...config }),
  ]);
  return r[0]!.id as string;
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_multiacct');
  await h.signup('maco', 'owner@maco.test');
  api = h.as('maco', (await h.login('maco', 'owner@maco.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ids.tenant = me.tenant.id;
  ids.owner = me.user.id;
}, 120_000);

describe('several accounts per integration', () => {
  it('a person keeps two Gmail mailboxes and an Outlook one; the first is primary', async () => {
    ids.a = await addMailbox('google', 'harsha.rani@hrpai.in', { primary: true });
    ids.b = await addMailbox('google', 'sales@hrpai.in');
    ids.c = await addMailbox('microsoft', 'harsha@client-project.in');
    const s = (await api('GET', '/api/v1/integrations/status')).json;
    expect(s.mailboxes.map((m: Json) => [m.account, m.primary])).toEqual([
      ['harsha.rani@hrpai.in', true],
      ['sales@hrpai.in', false],
      ['harsha@client-project.in', false],
    ]);
    expect(s.mailbox.account).toBe('harsha.rani@hrpai.in');
  });

  it('switches the primary, keeps settings per mailbox', async () => {
    expect((await api('PATCH', `/api/v1/integrations/mailboxes/${ids.b}`, { primary: true, ignore: ['family.com'] })).status).toBe(200);
    const s = (await api('GET', '/api/v1/integrations/status')).json;
    expect(s.mailbox.account).toBe('sales@hrpai.in');
    expect(s.mailboxes.filter((m: Json) => m.primary).length).toBe(1);
    expect(s.mailboxes.find((m: Json) => m.id === ids.b).config.ignore).toEqual(['family.com']);
    expect(s.mailboxes.find((m: Json) => m.id === ids.a).config.ignore).toBeUndefined();
  });

  it('sends from the mailbox chosen in the composer, else the primary', async () => {
    const lead = (await api('POST', '/api/v1/records/lead', { first_name: 'Asha', last_name: 'Iyer', email: 'asha@buyer.in' })).json.id;
    const chosen = await api('POST', `/api/v1/records/lead/${lead}/send-email`, { to: 'asha@buyer.in', subject: 'Hello', body: 'Hi Asha', fromMailboxId: ids.c });
    expect(chosen.status, JSON.stringify(chosen.json)).toBeLessThan(300);
    const plain = await api('POST', `/api/v1/records/lead/${lead}/send-email`, { to: 'asha@buyer.in', subject: 'Hello again', body: 'Hi', fromMailboxId: null });
    expect(plain.status).toBeLessThan(300);
    const sent = await sql(`select subject, mailbox_id, from_addr from messages where related_id = $1 order by created_at`, [lead]);
    expect(sent.map((m) => [m.subject, m.from_addr])).toEqual([
      ['Hello', 'harsha@client-project.in'],
      ['Hello again', 'sales@hrpai.in'],
    ]);
    // someone else's (or an unknown) mailbox cannot be used
    expect((await api('POST', `/api/v1/records/lead/${lead}/send-email`, { to: 'asha@buyer.in', subject: 'x', body: 'y', fromMailboxId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });

  it('disconnecting the primary makes the next one primary', async () => {
    expect((await api('DELETE', `/api/v1/integrations/mailboxes/${ids.b}`)).status).toBe(204);
    const s = (await api('GET', '/api/v1/integrations/status')).json;
    expect(s.mailboxes.map((m: Json) => [m.account, m.primary])).toEqual([
      ['harsha.rani@hrpai.in', true],
      ['harsha@client-project.in', false],
    ]);
    expect((await api('DELETE', `/api/v1/integrations/mailboxes/${ids.b}`)).status).toBe(404);
  });

  it('a workspace keeps several Razorpay accounts; the default takes new links', async () => {
    const secret = await sealSecret(h.env, ids.tenant!, { keySecret: 'k', webhookSecret: 'w' });
    const [r1] = await sql(`insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config) values ($1,'razorpay','Razorpay','rzp_live_A',$2,'{"default":true}') returning id`, [ids.tenant, secret]);
    const [r2] = await sql(`insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config) values ($1,'razorpay','Razorpay','rzp_live_B',$2,'{}') returning id`, [ids.tenant, secret]);
    const pick = async () => {
      const db = Db.fromEnv(h.env);
      try {
        return (await db.tx({ tenantId: ids.tenant! }, (tx) => activeOf(tx, ids.tenant!, 'razorpay')))?.account_ref;
      } finally {
        await db.close();
      }
    };
    expect(await pick()).toBe('rzp_live_A');
    expect((await api('PATCH', `/api/admin/integrations/${r2!.id}`, { makeDefault: true })).status).toBe(200);
    expect(await pick()).toBe('rzp_live_B');
    const listed = (await api('GET', '/api/admin/integrations')).json.items.filter((i: Json) => i.provider === 'razorpay');
    expect(listed.map((i: Json) => [i.account, i.isDefault, i.status])).toEqual([
      ['rzp_live_A', false, 'active'],
      ['rzp_live_B', true, 'active'],
    ]);
    expect(r1).toBeTruthy();
  });
});
