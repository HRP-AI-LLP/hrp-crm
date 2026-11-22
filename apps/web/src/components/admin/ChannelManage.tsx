/**
 * Settings → Channels, after connecting: edit, replace a credential (e.g. an expired WhatsApp token),
 * pause / resume, check the connection with Meta / Resend and fix what it finds, connect the
 * account's other numbers, and get a new inbound address.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { patch, post } from '../../lib/api';
import { relative } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';
import { Guide } from './ConnectionKeys';

type Json = Record<string, any>;

const FIELDS: Record<string, { config: [string, string, string?][]; secrets: [string, string][] }> = {
  whatsapp: {
    config: [['phoneNumberId', 'Phone number ID'], ['wabaId', 'WhatsApp Business Account ID', 'For templates, the account\'s other numbers and the webhook subscription']],
    secrets: [['accessToken', 'Access token'], ['appSecret', 'App secret'], ['verifyToken', 'Webhook verify token']],
  },
  instagram: { config: [['pageId', 'Facebook page ID']], secrets: [['accessToken', 'Access token'], ['appSecret', 'App secret'], ['verifyToken', 'Webhook verify token']] },
  email: { config: [['from', 'From address', 'e.g. Sales <sales@yourco.in>']], secrets: [['apiKey', 'Resend API key']] },
  webhook: { config: [['url', 'Endpoint URL']], secrets: [['signingSecret', 'Signing secret']] },
};
const GUIDE: Record<string, string> = { whatsapp: 'whatsapp', instagram: 'instagram', email: 'email_channel', webhook: 'webhook_channel' };

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin-channels'] });
}

/** Status, number details and the time of the last check, under the channel's name. */
export function ChannelStatus({ x }: { x: Json }) {
  const chk = x.config?.check as Json | undefined;
  const info = (chk?.info ?? {}) as Json;
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
      {x.status === 'disabled' ? (
        <span className="chip">paused</span>
      ) : chk ? (
        <span className={`chip ${chk.ok ? 'good' : 'bad'}`} title={chk.problems?.join(', ')}>
          {chk.ok ? 'working' : `needs attention (${(chk.problems ?? []).length || 1})`}
        </span>
      ) : (
        <span className="chip">not checked</span>
      )}
      {info.displayPhone && (
        <span className="muted">
          {info.displayPhone}
          {info.verifiedName ? ` · ${info.verifiedName}` : ''}
          {info.quality ? ` · quality ${String(info.quality).toLowerCase()}` : ''}
        </span>
      )}
      {chk?.at && <span className="muted">checked {relative(chk.at)}</span>}
    </div>
  );
}

export function ChannelActions({ x, onTemplates }: { x: Json; onTemplates?: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [edit, setEdit] = useState<string | null>(null);
  const [check, setCheck] = useState(false);
  const toggle = async () => {
    try {
      await patch(`/api/admin/channels/${x.id}`, { status: x.status === 'disabled' ? 'active' : 'disabled' });
      toast(x.status === 'disabled' ? 'Resumed' : 'Paused: nothing is sent or received');
      invalidate();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <>
      <button className="btn sm primary" onClick={() => setCheck(true)} title="Check the connection with the provider and fix what is wrong">
        Check & fix
      </button>
      <button className="btn sm" onClick={() => setEdit('')}>
        Edit
      </button>
      {onTemplates && (
        <button className="btn sm" onClick={onTemplates}>
          Templates
        </button>
      )}
      <button className="btn sm ghost" onClick={toggle}>
        {x.status === 'disabled' ? 'Resume' : 'Pause'}
      </button>
      {edit !== null && <EditChannel x={x} focus={edit} onClose={() => setEdit(null)} />}
      {check && <CheckChannel x={x} onClose={() => setCheck(false)} onEdit={(f) => (setCheck(false), setEdit(f))} />}
    </>
  );
}

function EditChannel({ x, focus, onClose }: { x: Json; focus: string; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const f = FIELDS[x.channel] ?? { config: [], secrets: [] };
  const [name, setName] = useState<string>(x.name);
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(f.config.map(([k]) => [k, String(x.config?.[k] ?? '')])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [inbound, setInbound] = useState<string>(x.inboundUrl);
  const stored = new Set<string>(x.secretsSet ?? []);
  const save = async () => {
    setBusy(true);
    try {
      const changed = Object.fromEntries(Object.entries(config).filter(([k, v]) => v !== String(x.config?.[k] ?? '')));
      await patch(`/api/admin/channels/${x.id}`, { name, config: changed, secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim())) });
      toast('Saved');
      invalidate();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const newAddress = async () => {
    if (!confirm('Give this channel a new inbound address? The old one stops working at once — paste the new one in Meta (or the sender) straight away.')) return;
    try {
      const r = await post<{ inboundUrl: string }>(`/api/admin/channels/${x.id}/inbound-address`);
      setInbound(r.inboundUrl);
      invalidate();
      toast('New inbound address ready — update it at the provider');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title={`Edit ${x.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>Save</button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {f.config.map(([k, label, hint]) => (
          <label key={k} className="field">
            {label}
            <input value={config[k] ?? ''} onChange={(e) => setConfig({ ...config, [k]: e.target.value })} autoFocus={focus === k} />
            {hint && <small className="muted">{hint}</small>}
          </label>
        ))}
        {f.secrets.map(([k, label]) => (
          <label key={k} className="field">
            {label}
            <input
              type={k === 'verifyToken' ? 'text' : 'password'}
              value={secrets[k] ?? ''}
              onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })}
              placeholder={stored.has(k) ? 'Saved — type a new one to replace it' : 'Not saved yet'}
              autoComplete="new-password"
              autoFocus={focus === k}
            />
          </label>
        ))}
        <p className="wide muted small" style={{ margin: 0 }}>
          Leave a credential empty to keep the saved one. Credentials are encrypted and never shown again.
        </p>
        <div className="wide stack" style={{ gap: 4 }}>
          <span className="small">Inbound URL (paste in Meta → WhatsApp → Configuration → Callback URL)</span>
          <div className="row" style={{ gap: 6 }}>
            <code className="small" style={{ wordBreak: 'break-all', flex: 1 }}>{inbound}</code>
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(inbound).then(() => toast('Copied'))}>
              Copy
            </button>
          </div>
          <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={newAddress}>
            Make a new inbound address (if the old one leaked)
          </button>
        </div>
        {GUIDE[x.channel] && (
          <div className="wide">
            <Guide id={GUIDE[x.channel]!} />
          </div>
        )}
      </div>
    </Modal>
  );
}

const FIX_FIELD: Record<string, string> = { token: 'accessToken', app_secret: 'appSecret', verify_token: 'verifyToken', waba: 'wabaId' };

function CheckChannel({ x, onClose, onEdit }: { x: Json; onClose: () => void; onEdit: (field: string) => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [res, setRes] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(null);
    setRes(null);
    try {
      setRes(await post<Json>(`/api/admin/channels/${x.id}/check`));
      invalidate();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // check on open
  useState(() => {
    void run();
    return true;
  });
  const subscribe = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/channels/${x.id}/subscribe`);
      toast('Subscribed: Meta now sends incoming messages');
      await run();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const addNumber = async (n: Json) => {
    const name = prompt('Name for this number in SanchalanOS', n.name ? `${n.name} (${n.display})` : n.display);
    if (!name) return;
    try {
      await post(`/api/admin/channels/${x.id}/numbers`, { phoneNumberId: n.id, name });
      toast(`${n.display} connected — its chats come in on the same callback URL`);
      invalidate();
      await run();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title={`Check ${x.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={run}>Check again</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="modal-body">
        <div className="wide stack">
          {!res && !err && (
            <div className="row" style={{ gap: 8 }}>
              <Spinner /> Checking with {x.channel === 'email' ? 'Resend' : x.channel === 'webhook' ? 'the endpoint' : 'Meta'}…
            </div>
          )}
          {err && <div className="notice" style={{ borderColor: 'var(--bad)' }}>{err}</div>}
          {res && (
            <>
              <div className="notice small" style={{ borderColor: res.ok ? 'var(--good)' : 'var(--bad)', marginBottom: 0 }}>
                {res.ok ? 'Everything works.' : 'Some things need fixing — use the buttons next to them.'}
              </div>
              <table className="data">
                <tbody>
                  {(res.checks as Json[]).map((c, i) => (
                    <tr key={i}>
                      <td style={{ width: 24 }}>{c.ok ? '✅' : '⚠️'}</td>
                      <td>
                        <b>{c.label}</b>
                        {c.detail && <div className="small muted" style={{ whiteSpace: 'normal' }}>{c.detail}</div>}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        {c.fix === 'subscribe' && (
                          <button className="btn sm primary" disabled={busy} onClick={subscribe}>
                            Subscribe the app
                          </button>
                        )}
                        {c.fix && c.fix !== 'subscribe' && (
                          <button className="btn sm" onClick={() => onEdit(FIX_FIELD[c.fix] ?? '')}>
                            {c.fix === 'token' ? 'Replace token' : c.fix === 'waba' ? 'Add the ID' : 'Add it'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {res.numbers?.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <b>Numbers in this WhatsApp Business Account</b>
                  <table className="data">
                    <tbody>
                      {(res.numbers as Json[]).map((n) => (
                        <tr key={n.id}>
                          <td>
                            <b>{n.display}</b>
                            <div className="small muted">
                              {n.name ?? ''} {n.quality ? `· quality ${String(n.quality).toLowerCase()}` : ''} · ID {n.id}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {n.connectedAs ? (
                              <span className="chip good">connected as {n.connectedAs}</span>
                            ) : (
                              <button className="btn sm primary" onClick={() => addNumber(n)}>
                                Connect this number
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="small muted" style={{ margin: 0, whiteSpace: 'normal', maxWidth: 560 }}>
                    Every number of the account uses the same callback URL in Meta; each chat lands on the channel of the number the customer wrote to, and replies leave from that number.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
