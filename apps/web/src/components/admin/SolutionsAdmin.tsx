/** Settings → Industry modules: ready-made setups for made-to-order businesses. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../../lib/api';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

export function SolutionsPanel() {
  const q = useQuery({ queryKey: ['solutions'], queryFn: () => get<{ items: Json[] }>('/api/admin/solutions') });
  const [open, setOpen] = useState<Json | null>(null);
  if (!q.data) return <Spinner />;
  return (
    <section className="stack">
      <div>
        <h3 style={{ margin: 0 }}>Industry solutions</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          One click sets SanchalanOS up the way your kind of business works: lead fields, the deal pipeline, the apps you need, your usual payment plan, the installation checklist and KPI targets.
        </p>
      </div>
      <div className="solution-grid">
        {q.data.items.map((s) => (
          <article key={s.key} className={`panel solution${s.installed ? ' on' : ''}`}>
            <div className="spread" style={{ alignItems: 'flex-start' }}>
              <b>{s.name}</b>
              {s.installed && <span className="chip good">Installed</span>}
            </div>
            <p className="small">{s.tagline}</p>
            <p className="muted small">{s.forWho}</p>
            <div className="stage-pills">
              {s.pipeline.map((p: string) => (
                <span key={p}>{p}</span>
              ))}
            </div>
            <button className={`btn sm ${s.installed ? '' : 'primary'}`} onClick={() => setOpen(s)}>
              {s.installed ? 'Details' : 'Set up'}
            </button>
          </article>
        ))}
      </div>
      {open && <SolutionModal s={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function SolutionModal({ s, onClose }: { s: Json; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      const r = await post<Json>(`/api/admin/solutions/${s.key}/install`, { overwrite });
      toast(`${s.name} is set up${r.appsSwitchedOn.length ? `; switched on ${r.appsSwitchedOn.length} apps` : ''}`);
      for (const k of [['solutions'], ['meta'], ['admin-modules'], ['admin-apps'], ['kpis']]) qc.invalidateQueries({ queryKey: k });
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={s.name}
      onClose={onClose}
      footer={
        <>
          {s.installed && (
            <label className="check small" style={{ marginRight: 'auto' }}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Reset payment plan, checklist and KPI targets to the defaults
            </label>
          )}
          <button className="btn primary" disabled={busy} onClick={install}>
            {busy ? 'Setting up…' : s.installed ? 'Apply again' : 'Set up'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <p>{s.tagline}</p>
        <ul className="small">
          {s.highlights.map((h: string) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
        <div className="grid2">
          <div>
            <b className="small">Deal stages</b>
            <div className="stage-pills">
              {s.pipeline.map((p: string) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          </div>
          <div>
            <b className="small">New lead fields</b>
            <p className="small muted">{s.leadFields.join(', ')}</p>
          </div>
          <div>
            <b className="small">Payment plan on new orders</b>
            <p className="small">{s.milestonePlan.map((m: Json) => `${m.percent}% ${m.name.toLowerCase()}`).join(' · ')}</p>
          </div>
          <div>
            <b className="small">Apps switched on</b>
            <p className="small muted">{s.apps.join(', ')}</p>
          </div>
        </div>
        <p className="muted small">Nothing is deleted. Your own fields, pipelines and settings stay as they are.</p>
      </div>
    </Modal>
  );
}
