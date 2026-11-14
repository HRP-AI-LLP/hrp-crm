/** Settings → AI agents (switches, auto-run, budgets, thresholds) and Settings → Competitors (battlecards). */
import { AGENT_CATEGORIES, type AgentCategory } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post, put } from '../../lib/api';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

export function AgentsAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-agents'], queryFn: () => get<{ items: Json[] }>('/api/admin/intel/agents') });
  const save = async (key: string, body: Json) => {
    try {
      await put(`/api/admin/intel/agents/${key}`, body);
      qc.invalidateQueries({ queryKey: ['admin-agents'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (!q.data) return <Spinner />;
  const byCat = new Map<AgentCategory, Json[]>();
  for (const a of q.data.items) byCat.set(a.category, [...(byCat.get(a.category) ?? []), a]);
  const risk = q.data.items.find((a) => a.key === 'deal_risk');
  const focus = q.data.items.find((a) => a.key === 'rep_focus');
  return (
    <section className="stack">
      <div>
        <p className="muted small" style={{ margin: 0 }}>
          Agents work on what each person can see and cite the records behind every point. Scores, insights and focus lists are rule-based and free; agents use your AI models (Settings → AI models) for language and judgement, and fall back to the rule-based result when AI is unavailable.
        </p>
      </div>
      {[...byCat.entries()].map(([cat, list]) => (
        <div key={cat} className="panel">
          <div className="panel-head">
            <h3>{AGENT_CATEGORIES[cat]}</h3>
          </div>
          <table className="data">
            <tbody>
              {list.map((a) => (
                <tr key={a.key}>
                  <td style={{ width: '55%', whiteSpace: 'normal' }}>
                    <b>{a.label}</b>
                    <div className="small muted">{a.description}</div>
                  </td>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    {a.runs30d} run{a.runs30d === 1 ? '' : 's'} in 30 days
                    {a.runs30d ? ` · ${Math.round((a.aiRuns30d / a.runs30d) * 100)}% with AI` : ''}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {a.autoRun && (
                      <label className="row small" title={a.autoRun} style={{ whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={a.autoRunOn} disabled={!a.enabled} onChange={(e) => save(a.key, { autoRun: e.target.checked })} /> Run on its own
                      </label>
                    )}
                    {a.autoRun && a.autoRunOn && (
                      <label className="row small">
                        up to <input type="number" min={0} max={1000} style={{ width: 70 }} defaultValue={a.dailyBudget} onBlur={(e) => Number(e.target.value) !== a.dailyBudget && save(a.key, { dailyBudget: Number(e.target.value) })} aria-label={`${a.label} daily budget`} /> a day
                      </label>
                    )}
                  </td>
                  <td>
                    <label className="switch" title={a.enabled ? 'On' : 'Off'}>
                      <input type="checkbox" checked={a.enabled} onChange={(e) => save(a.key, { enabled: e.target.checked })} aria-label={`${a.label} on`} />
                      <span />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="panel panel-body">
        <h3>Thresholds</h3>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label className="field">
            <span>A deal counts as stalled after (days without contact)</span>
            <input type="number" min={3} max={90} defaultValue={risk?.settings?.stalledDays ?? 14} onBlur={(e) => save('deal_risk', { settings: { stalledDays: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>Flag a new lead nobody answered after (hours)</span>
            <input type="number" min={1} max={72} defaultValue={focus?.settings?.leadWaitHours ?? 4} onBlur={(e) => save('rep_focus', { settings: { leadWaitHours: Number(e.target.value) } })} />
          </label>
        </div>
      </div>
    </section>
  );
}

const EMPTY = { name: '', website: '', aliases: '', description: '', strengths: '', weaknesses: '', pricingNotes: '', howWeWin: '', isActive: true };

export function CompetitorsAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['competitors'], queryFn: () => get<{ items: Json[] }>('/api/v1/intel/competitors') });
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const save = async () => {
    if (!edit) return;
    const body = { ...edit, aliases: edit.aliases.split(',').map((s) => s.trim()).filter(Boolean), website: edit.website || null };
    delete (body as Json).id;
    try {
      if (edit.id) await patch(`/api/admin/intel/competitors/${edit.id}`, body);
      else await post('/api/admin/intel/competitors', body);
      qc.invalidateQueries({ queryKey: ['competitors'] });
      setEdit(null);
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this competitor and its tags on deals?')) return;
    await del(`/api/admin/intel/competitors/${id}`).catch((e) => toast((e as Error).message, true));
    qc.invalidateQueries({ queryKey: ['competitors'] });
  };
  if (!q.data) return <Spinner />;
  return (
    <section className="stack">
      <div className="spread">
        <div>
          <p className="muted small" style={{ margin: 0 }}>
            Battlecards for who you meet in deals. Reps tag them on deals; meeting and call debriefs tag them when a customer mentions them. The competitive coach and meeting briefs use what you write here.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ ...EMPTY })}>
          Add competitor
        </button>
      </div>
      {q.data.items.length === 0 ? (
        <p className="muted">No competitors yet.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>In play</th>
              <th>Won against</th>
              <th>Lost to</th>
              <th>Win rate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((c) => (
              <tr key={c.id} style={c.is_active ? undefined : { opacity: 0.6 }}>
                <td>
                  <b>{c.name}</b>
                  {c.aliases?.length > 0 && <div className="small muted">also: {c.aliases.join(', ')}</div>}
                </td>
                <td>{c.active_deals}</td>
                <td>{c.beaten}</td>
                <td>{c.lost_to}</td>
                <td>{c.beaten + c.lost_to ? `${Math.round((c.beaten / (c.beaten + c.lost_to)) * 100)}%` : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => setEdit({ id: c.id, name: c.name, website: c.website ?? '', aliases: (c.aliases ?? []).join(', '), description: c.description ?? '', strengths: c.strengths ?? '', weaknesses: c.weaknesses ?? '', pricingNotes: c.pricing_notes ?? '', howWeWin: c.how_we_win ?? '', isActive: c.is_active })}>
                    Edit
                  </button>{' '}
                  <button className="btn sm ghost" onClick={() => remove(c.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal
          wide
          title={edit.id ? `Edit ${edit.name}` : 'New competitor'}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" disabled={!edit.name.trim()} onClick={save}>
              Save
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              <span>Name</span>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Website</span>
              <input value={edit.website} onChange={(e) => setEdit({ ...edit, website: e.target.value })} placeholder="https://" />
            </label>
            <label className="field wide">
              <span>Other names customers use (comma separated)</span>
              <input value={edit.aliases} onChange={(e) => setEdit({ ...edit, aliases: e.target.value })} />
            </label>
            {(
              [
                ['strengths', 'Their strengths'],
                ['weaknesses', 'Their weaknesses'],
                ['pricingNotes', 'Pricing'],
                ['howWeWin', 'How we win'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="field">
                <span>{l}</span>
                <textarea rows={3} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
              </label>
            ))}
            <label className="row small wide">
              <input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
    </section>
  );
}
