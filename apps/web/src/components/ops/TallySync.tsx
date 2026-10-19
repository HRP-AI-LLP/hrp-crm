/** Billing & GST → Tally: automatic two-way sync through the connector on the accountant's PC. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { relative } from '../../lib/format';
import { CopyField } from '../admin/IntegrationsAdmin';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const KIND: Record<string, string> = { ledger: 'Customer ledgers', sales: 'Sales invoices', credit_note: 'Credit notes', receipt: 'Receipts' };

export function TallySync() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tally'], queryFn: () => get<Json>('/api/admin/tally'), refetchInterval: 60_000 });
  const [creds, setCreds] = useState<{ token: string; connectorUrl: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['tally'] });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
  if (!q.data) return <Spinner />;
  const d = q.data;
  const connect = async () => {
    const r = (await run(() => post<{ token: string; connectorUrl: string }>('/api/admin/tally/connect'), d.connected ? 'New token created; the old one stops working' : 'Tally connected')) as { token: string; connectorUrl: string } | null;
    if (r) setCreds(r);
  };
  const counts = (kind: string) => Object.fromEntries((d.counts ?? []).filter((c: Json) => c.kind === kind).map((c: Json) => [c.status, c.n]));
  return (
    <div className="panel-body stack">
      <div className="spread">
        <div>
          <h3 style={{ margin: 0 }}>Automatic sync with Tally</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            A small connector on the accountant’s PC sends customer ledgers, invoices, credit notes and receipts into Tally every few minutes, and brings back receipts entered in Tally.
          </p>
        </div>
        {d.connected && d.status !== 'disabled' ? <span className="chip good">Connected</span> : <span className="chip">Not connected</span>}
      </div>
      {!d.connected || d.status === 'disabled' ? (
        <ol className="small steps-list">
          <li>Install Node.js (18 or newer) on the PC that runs Tally.</li>
          <li>
            In Tally: F1 Help → Settings → Connectivity → set TallyPrime to act as <b>Server</b> (or Both) on port 9000.
          </li>
          <li>Click Connect below, download the connector and run the command it shows.</li>
          <li>
            <button className="btn primary" onClick={connect}>
              Connect Tally
            </button>
          </li>
        </ol>
      ) : (
        <>
          <div className="kpis">
            {Object.keys(KIND).map((k) => {
              const c = counts(k);
              return (
                <div key={k} className="panel kpi">
                  <div className="l">{KIND[k]}</div>
                  <div className="v">{c.synced ?? 0}</div>
                  <div className="small muted">
                    in Tally{c.sent ? ` · ${c.sent} on the way` : ''}
                    {c.failed ? <span className="bad-text"> · {c.failed} failed</span> : null}
                    {c.needs_attention ? <span className="warn-text"> · {c.needs_attention} to check</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Connector last asked for work {d.lastPullAt ? relative(d.lastPullAt) : 'never'}
            {d.lastImport ? ` · last receipts from Tally ${relative(d.lastImport.at)}: ${d.lastImport.imported} recorded` : ''}
          </p>
          {d.lastImport?.unmatched?.length > 0 && (
            <div className="small warn-text">Receipts in Tally that matched no customer here (rename the ledger or the account to match): {d.lastImport.unmatched.join('; ')}</div>
          )}
          {d.problems?.length > 0 && (
            <table className="data">
              <tbody>
                {d.problems.map((p: Json) => (
                  <tr key={`${p.kind}-${p.record_id}`}>
                    <td>
                      <b>{p.name}</b>
                      <div className="muted small">{KIND[p.kind] ?? p.kind}</div>
                    </td>
                    <td className="small" style={{ whiteSpace: 'normal' }}>
                      <span className={`chip ${p.status === 'failed' ? 'bad' : 'warn'}`}>{p.status === 'failed' ? 'Tally rejected' : 'Check in Tally'}</span> {p.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => run(() => post('/api/admin/tally/retry', {}), 'Failed items will be sent again')}>
              Retry failed
            </button>
            <button className="btn" onClick={connect}>
              New connector token
            </button>
            <a className="btn" href="/downloads/synapse-tally.mjs" download>
              Download connector
            </a>
            <button className="btn danger" onClick={() => window.confirm('Disconnect Tally? The connector stops working.') && run(() => del('/api/admin/tally'), 'Disconnected')}>
              Disconnect
            </button>
          </div>
          <TallySettings cfg={d.config} onSave={(b) => run(() => patch('/api/admin/tally', b), 'Saved')} />
        </>
      )}
      {creds && (
        <Modal title="Connector details" onClose={() => setCreds(null)}>
          <div className="modal-body stack">
            <p className="small">Copy the token now: it is shown only once. Anyone with it can send receipts into this workspace, so keep it on the accountant’s PC only.</p>
            <CopyField label="Connector URL" value={creds.connectorUrl} />
            <CopyField label="Token" value={creds.token} />
            <CopyField label="Run on the Tally PC (PowerShell)" value={`node synapse-tally.mjs --url ${creds.connectorUrl} --token ${creds.token}`} />
            <a className="btn primary" href="/downloads/synapse-tally.mjs" download>
              Download connector
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TallySettings({ cfg, onSave }: { cfg: Json; onSave: (b: Json) => void }) {
  const [f, setF] = useState({ syncFrom: cfg.syncFrom, pushReceipts: cfg.pushReceipts, importReceipts: cfg.importReceipts, ledgerParent: cfg.ledgerParent, companyName: cfg.companyName ?? '' });
  return (
    <section className="grid2">
      <label className="field">
        Sync documents dated from
        <input type="date" value={f.syncFrom} onChange={(e) => setF({ ...f, syncFrom: e.target.value })} />
      </label>
      <label className="field">
        Customer ledger group in Tally
        <input value={f.ledgerParent} onChange={(e) => setF({ ...f, ledgerParent: e.target.value })} />
      </label>
      <label className="field">
        Tally company name (if several are open)
        <input value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} />
      </label>
      <div className="stack" style={{ gap: 4 }}>
        <label className="check small">
          <input type="checkbox" checked={f.pushReceipts} onChange={(e) => setF({ ...f, pushReceipts: e.target.checked })} /> Send receipts recorded here to Tally
        </label>
        <label className="check small">
          <input type="checkbox" checked={f.importReceipts} onChange={(e) => setF({ ...f, importReceipts: e.target.checked })} /> Record receipts entered in Tally here
        </label>
      </div>
      <div>
        <button className="btn" onClick={() => onSave({ ...f, companyName: f.companyName || null })}>
          Save sync settings
        </button>
      </div>
    </section>
  );
}
