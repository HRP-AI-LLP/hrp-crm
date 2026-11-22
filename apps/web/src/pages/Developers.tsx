/**
 * Developers: the API reference for this workspace (OpenAPI), the event catalog and webhooks with
 * a delivery log. Built for Zapier / Make / n8n users as much as for programmers.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { Guide } from '../components/admin/ConnectionKeys';

type Json = Record<string, any>;

function Code({ children }: { children: string }) {
  const toast = useToast();
  return (
    <div className="code-block">
      <pre>{children}</pre>
      <button className="btn sm" onClick={() => navigator.clipboard?.writeText(children).then(() => toast('Copied'))}>
        Copy
      </button>
    </div>
  );
}

export function DevelopersPage() {
  const { me, can } = useAuth();
  const origin = window.location.origin;
  const base = `${origin}/api/v1`;
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: () => get<{ items: Json[] }>('/api/v1/webhook-events') });
  const manage = can('developers') || can('channels');
  const downloadSpec = async () => {
    const spec = await get<Json>('/api/v1/openapi.json');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }));
    a.download = `synapse-${me?.tenant.slug ?? 'api'}-openapi.json`;
    a.click();
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Developers</h1>
          <p>Connect your website, Zapier, Make, n8n or your own code to SanchalanOS.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={downloadSpec}>
            Download OpenAPI
          </button>
          {can('users') && (
            <Link className="btn primary" to="/settings#apikeys">
              API keys
            </Link>
          )}
        </div>
      </div>
      <div className="dev-grid">
        <section className="panel panel-body stack">
          <h2>Quick start</h2>
          <Guide id="api_keys" open />
          <p className="small">
            Create an API key in Settings → API keys. A key acts as the person you choose and sees exactly what they can see. Send it as a bearer token.
          </p>
          <Code>{`curl ${base}/records/lead?limit=5 \\\n  -H "Authorization: Bearer syn_${me?.tenant.slug ?? 'workspace'}_…"`}</Code>
          <p className="small">Create a lead from your website’s form handler (it goes through your assignment rules):</p>
          <Code>{`curl -X POST ${base}/records/lead \\\n  -H "Authorization: Bearer syn_…" -H "Content-Type: application/json" \\\n  -d '{"first_name":"Asha","last_name":"Rao","phone":"9876543210","source":"website"}'`}</Code>
          <ul className="small">
            <li>
              Lists page with <code>limit</code> (up to 200) and <code>cursor</code>; filter with <code>filters=[{'{'}"field":"source","op":"eq","value":"website"{'}'}]</code>.
            </li>
            <li>
              Send <code>If-Match: &lt;version&gt;</code> on updates to refuse overwriting someone else’s change (409).
            </li>
            <li>
              Each key has a per-minute limit; watch <code>X-RateLimit-Remaining</code>, and on 429 wait <code>Retry-After</code> seconds.
            </li>
            <li>
              The OpenAPI file lists every object with your own custom fields. Import it into Postman, Insomnia or a code generator.
            </li>
          </ul>
        </section>
        <section className="panel panel-body stack">
          <h2>Verifying webhooks</h2>
          <p className="small">
            Every delivery is a POST with JSON <code>{'{ event, data: { object, recordId, changes, record }, sentAt }'}</code>. Check the signature with the secret shown when you subscribed, and reject deliveries older than five minutes.
          </p>
          <Code>{`// Node.js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(want), Buffer.from(v1));
}
// header: X-Synapse-Signature-V2`}</Code>
          <p className="small muted">Failed deliveries are retried automatically; after 50 failures in a row the subscription is paused.</p>
        </section>
      </div>
      {manage ? <Webhooks events={events.data?.items ?? []} /> : <p className="muted small">Ask an admin with the developers permission to set up webhooks.</p>}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>Events</h2>
        </div>
        <div className="panel-body event-cloud">
          {events.data?.items.map((e) => (
            <code key={e.event} title={e.label}>
              {e.event}
            </code>
          ))}
        </div>
      </section>
    </>
  );
}

function Webhooks({ events }: { events: Json[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hooks'], queryFn: () => get<{ items: Json[] }>('/api/v1/hooks') });
  const [adding, setAdding] = useState<{ name: string; url: string; events: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Json | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['hooks'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>Webhooks</h2>
        <button className="btn" onClick={() => setAdding({ name: '', url: 'https://', events: ['lead.created'] })}>
          Add webhook
        </button>
      </div>
      {!q.data ? (
        <Spinner />
      ) : !q.data.items.length ? (
        <Empty title="No webhooks">Get a POST to your URL whenever a lead, deal, order or any record is created or changed.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {q.data.items.map((w) => (
              <tr key={w.id}>
                <td>
                  <b>{w.name || w.url}</b>
                  <div className="mono small muted">{w.url}</div>
                  <div className="small muted">{w.events.join(', ')}</div>
                </td>
                <td className="small">
                  {w.is_enabled ? <span className="chip good">On</span> : <span className="chip bad">Paused</span>}
                  {w.last_delivery_at && (
                    <div className="muted">
                      Last {relative(w.last_delivery_at)} · {w.last_status ?? 'no answer'}
                    </div>
                  )}
                  {w.failure_count > 0 && <div className="bad-text">{w.failure_count} failures in a row</div>}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => setLog(w)}>
                    Deliveries
                  </button>
                  <button className="btn sm" onClick={() => act(() => post(`/api/v1/hooks/${w.id}/test`), 'Test event sent')}>
                    Send test
                  </button>
                  <button className="btn sm" onClick={() => act(() => patch(`/api/v1/hooks/${w.id}`, { enabled: !w.is_enabled }), w.is_enabled ? 'Paused' : 'Resumed')}>
                    {w.is_enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn sm danger" onClick={() => window.confirm('Remove this webhook?') && act(() => del(`/api/v1/hooks/${w.id}`), 'Removed')}>
                    Remove
                  </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <Modal
          wide
          title="Add webhook"
          onClose={() => setAdding(null)}
          footer={
            <button
              className="btn primary"
              disabled={!adding.url.startsWith('https://') || !adding.events.length}
              onClick={async () => {
                try {
                  const r = await post<{ secret: string }>('/api/v1/hooks', adding);
                  setAdding(null);
                  setSecret(r.secret);
                  qc.invalidateQueries({ queryKey: ['hooks'] });
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Add
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Name
              <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. New leads to Google Sheets" />
            </label>
            <label className="field">
              URL (https)
              <input value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} />
            </label>
            <div className="field wide">
              <span>Events</span>
              <div className="recipient-pick">
                {events.map((e) => (
                  <label key={e.event} className="check small">
                    <input type="checkbox" checked={adding.events.includes(e.event)} onChange={(x) => setAdding({ ...adding, events: x.target.checked ? [...adding.events, e.event] : adding.events.filter((y) => y !== e.event) })} /> {e.event}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {secret && (
        <Modal title="Signing secret" onClose={() => setSecret(null)} footer={<button className="btn primary" onClick={() => setSecret(null)}>I have stored it</button>}>
          <div className="modal-body stack">
            <p className="small">Use this to verify that deliveries come from SanchalanOS. It is shown only once.</p>
            <Code>{secret}</Code>
          </div>
        </Modal>
      )}
      {log && <DeliveryLog hook={log} onClose={() => setLog(null)} />}
    </section>
  );
}

function DeliveryLog({ hook, onClose }: { hook: Json; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hook-deliveries', hook.id], queryFn: () => get<{ items: Json[] }>(`/api/v1/hooks/${hook.id}/deliveries`), refetchInterval: 10_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal wide title={`Deliveries · ${hook.name || hook.url}`} onClose={onClose}>
      <div className="modal-body one">
        {!q.data ? (
          <Spinner />
        ) : !q.data.items.length ? (
          <Empty title="Nothing delivered yet" />
        ) : (
          <table className="data">
            <tbody>
              {q.data.items.map((d) => (
                <Fragment key={d.id}>
                  <tr className="click" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    <td className="mono small">{d.event}</td>
                    <td>{d.ok ? <span className="chip good">{d.status_code}</span> : <span className="chip bad">{d.status_code ?? 'failed'}</span>}</td>
                    <td className="small muted">
                      {dateTime(d.created_at)} · {d.duration_ms} ms{d.redelivery_of ? ' · redelivery' : ''}
                    </td>
                    <td className="small bad-text">{d.error}</td>
                    <td>
                      {!d.ok && (
                        <button
                          className="btn sm"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await post(`/api/v1/webhook-deliveries/${d.id}/redeliver`);
                              toast('Sent again');
                              qc.invalidateQueries({ queryKey: ['hook-deliveries', hook.id] });
                            } catch (x) {
                              toast((x as Error).message, true);
                            }
                          }}
                        >
                          Redeliver
                        </button>
                      )}
                    </td>
                  </tr>
                  {open === d.id && (
                    <tr>
                      <td colSpan={5}>
                        <pre className="payload">{JSON.stringify(d.payload, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
