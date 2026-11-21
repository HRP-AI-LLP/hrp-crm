/** Settings → Connectors: Teams / Slack / Google Chat alerts, Jira / Azure DevOps / Asana, SharePoint and ERPs. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put } from '../../lib/api';
import { type Json, label, useAct } from '../industry/kit';
import { Modal, Spinner } from '../ui';
import { Guide } from './ConnectionKeys';

const CARDS: { kind: string; name: string; group: string; blurb: string }[] = [
  { kind: 'teams', name: 'Microsoft Teams', group: 'Alerts', blurb: 'Deal won / lost, big new deals, urgent tickets, orders and payments posted to a channel.' },
  { kind: 'slack', name: 'Slack', group: 'Alerts', blurb: 'The same alerts in a Slack channel.' },
  { kind: 'gchat', name: 'Google Chat', group: 'Alerts', blurb: 'The same alerts in a Google Chat space.' },
  { kind: 'jira', name: 'Jira', group: 'Work tracking', blurb: 'Push project tasks as Jira issues; done in Jira closes the task here.' },
  { kind: 'azure_devops', name: 'Azure DevOps', group: 'Work tracking', blurb: 'Push tasks as work items; their state comes back.' },
  { kind: 'asana', name: 'Asana', group: 'Work tracking', blurb: 'Push tasks into an Asana project; completion comes back.' },
  { kind: 'sharepoint', name: 'SharePoint', group: 'Documents', blurb: 'Copy record files into a SharePoint document library.' },
  { kind: 'dynamics_bc', name: 'Dynamics 365 Business Central', group: 'ERP', blurb: 'Pull customers and items, push confirmed sales orders.' },
  { kind: 'sap_b1', name: 'SAP Business One', group: 'ERP', blurb: 'Service Layer: business partners and items in, orders out.' },
  { kind: 'netsuite', name: 'Oracle NetSuite', group: 'ERP', blurb: 'Token-based auth: customers and items in, sales orders out.' },
];
const ALERT_LABEL: Record<string, string> = { deal_won: 'Deal won', deal_lost: 'Deal lost', big_deal: 'Big new deal', urgent_ticket: 'Urgent / high ticket', order_confirmed: 'Order confirmed', payment_received: 'Payment received' };

export function ConnectorsTab() {
  const { data } = useQuery({ queryKey: ['connectors'], queryFn: () => get<Json>('/api/v1/connectors') });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['connectors']]);
  if (!data) return <Spinner />;
  const groups = [...new Set(CARDS.map((c) => c.group))];
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Credentials are encrypted and never shown again. Tally, Gmail / Outlook, Razorpay and lead ads are under Integrations. Tally is the ERP most Indian companies use and is connected there.
      </p>
      {groups.map((g) => (
        <section key={g}>
          <h3 style={{ fontSize: 14, margin: '8px 0' }}>{g}</h3>
          <div className="integ">
            {CARDS.filter((c) => c.group === g).map((c) => {
              const mine = (data.items as Json[]).filter((i) => i.kind === c.kind);
              return (
                <div key={c.kind} className="panel integ-card" style={{ padding: 12 }}>
                  <div className="spread">
                    <b>{c.name}</b>
                    <button className="btn sm" onClick={() => setEdit({ kind: c.kind, name: c.name, values: {}, alerts: ['deal_won', 'urgent_ticket'], minDeal: 500000 })}>
                      {mine.length ? 'Add another' : 'Connect'}
                    </button>
                  </div>
                  <p className="muted small" style={{ margin: '4px 0 6px' }}>
                    {c.blurb}
                  </p>
                  {mine.map((i) => (
                    <div key={i.id} className="spread small" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
                      <span>
                        <span className={`dot-status ${i.status === 'active' ? 'good' : 'bad'}`} /> {i.label}
                        {i.lastError ? <span className="bad-text" title={i.lastError}> · error</span> : null}
                      </span>
                      <span className="row" style={{ gap: 4 }}>
                        <button className="btn sm ghost" onClick={() => act(() => post<{ ok: boolean; error?: string }>(`/api/v1/connectors/${i.id}/test`)).then((r) => r && window.alert(r.ok ? 'Connected ✓' : `Failed: ${r.error}`))}>
                          Test
                        </button>
                        {['dynamics_bc', 'sap_b1', 'netsuite'].includes(c.kind) && (
                          <button className="btn sm ghost" onClick={() => act(() => post<Json>(`/api/v1/connectors/${i.id}/erp-pull`, {})).then((r) => r && window.alert(`Customers: ${r.customers.created} new, ${r.customers.linked} linked\nProducts: ${r.items.created} new, ${r.items.linked} linked, ${r.items.priced} prices updated`))}>
                            Pull customers & items
                          </button>
                        )}
                        <button className="btn sm ghost" onClick={() => setEdit({ id: i.id, kind: c.kind, name: c.name, label: i.label, values: Object.fromEntries(Object.entries(i.config ?? {}).filter(([, v]) => typeof v === 'string')), alerts: i.config?.alerts ?? [], minDeal: i.config?.minDeal ?? 500000 })}>
                          Edit
                        </button>
                        <button className="btn sm ghost" onClick={() => window.confirm(`Disconnect ${i.label}?`) && act(() => del(`/api/v1/connectors/${i.id}`), 'Disconnected')}>
                          Remove
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {edit && (
        <Modal
          title={`${edit.id ? 'Edit' : 'Connect'} ${edit.name}`}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                const body = { label: edit.label || null, values: edit.values, alerts: edit.alerts, minDeal: Number(edit.minDeal) || 0 };
                if (await act(() => (edit.id ? put(`/api/v1/connectors/${edit.kind}/${edit.id}`, body) : post(`/api/v1/connectors/${edit.kind}`, body)), 'Saved — use Test to check it')) setEdit(null);
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body stack">
            <Guide id={edit.kind} open={!edit.id} />
            <label className="field">
              Name it (optional)
              <input value={edit.label ?? ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} placeholder={edit.name} />
            </label>
            {(data.fields[edit.kind] as Json[]).map((f) => (
              <label key={f.key} className="field">
                {f.label}
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={f.secret && edit.id ? 'Leave blank to keep' : (f.placeholder ?? '')}
                  value={edit.values[f.key] ?? ''}
                  onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [f.key]: e.target.value } })}
                />
              </label>
            ))}
            {['teams', 'slack', 'gchat'].includes(edit.kind) && (
              <>
                <div className="field">
                  Post when
                  {(data.alerts as string[]).map((a) => (
                    <label key={a} className="check-row">
                      <input type="checkbox" checked={edit.alerts.includes(a)} onChange={(e) => setEdit({ ...edit, alerts: e.target.checked ? [...edit.alerts, a] : edit.alerts.filter((x: string) => x !== a) })} /> {ALERT_LABEL[a] ?? label(a)}
                    </label>
                  ))}
                </div>
                {edit.alerts.includes('big_deal') && (
                  <label className="field">
                    A "big" deal is at least (₹)
                    <input type="number" min={0} value={edit.minDeal} onChange={(e) => setEdit({ ...edit, minDeal: e.target.value })} />
                  </label>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
