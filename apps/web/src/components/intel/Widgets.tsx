/** Building blocks shared by the Copilot workspace, the record Copilot tab and meetings. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post, put } from '../../lib/api';
import { date } from '../../lib/format';
import { Spinner, useToast } from '../ui';
import { type Citation, citeHref, type Json } from './AgentOutput';

// ------------------------------------------------------------------------------- action items
export function ActionItems({ query, relatedObject, relatedId, canAdd, empty }: { query: string; relatedObject?: string; relatedId?: string; canAdd?: boolean; empty?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['action-items', query];
  const q = useQuery({ queryKey: key, queryFn: () => get<{ items: Json[] }>(`/api/v1/intel/action-items?${query}`) });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['action-items'] });
    qc.invalidateQueries({ queryKey: ['copilot'] });
  };
  const setStatus = async (id: string, status: string) => {
    try {
      await patch(`/api/v1/intel/action-items/${id}`, { status });
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await post('/api/v1/intel/action-items', { title, dueAt: due ? new Date(`${due}T18:00:00+05:30`).toISOString() : null, relatedObject: relatedObject ?? null, relatedId: relatedId ?? null });
      setTitle('');
      setDue('');
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  if (!q.data) return <Spinner />;
  const now = Date.now();
  return (
    <div className="stack" style={{ gap: 6 }}>
      {q.data.items.length === 0 && <p className="muted small">{empty ?? 'No action items.'}</p>}
      {q.data.items.map((i) => {
        const overdue = i.due_at && ['open', 'in_progress'].includes(i.status) && new Date(i.due_at).getTime() < now;
        return (
          <div key={i.id} className={`ai-item ${i.status}`}>
            <input type="checkbox" aria-label={`Mark "${i.title}" done`} checked={i.status === 'done'} onChange={(e) => setStatus(i.id, e.target.checked ? 'done' : 'open')} />
            <div className="grow">
              <div className="ai-item-title">
                {i.title} {i.ai_generated && <span className="chip info tiny">AI</span>}
              </div>
              <div className="small muted">
                {i.due_at && <span style={overdue ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{overdue ? 'Overdue · ' : 'Due '}{date(i.due_at)}</span>}
                {i.source !== 'manual' && <span> · from {i.source}</span>}
                {i.related_object && i.related_id && !relatedId && (
                  <>
                    {' · '}
                    <Link to={citeHref({ object: i.related_object, id: i.related_id })}>{i.related_object}</Link>
                  </>
                )}
                {i.owner_name && query.includes('scope=team') && <span> · {i.owner_name}</span>}
              </div>
            </div>
            {i.status === 'open' && (
              <button className="btn ghost sm" onClick={() => setStatus(i.id, 'in_progress')} title="Mark in progress">
                Start
              </button>
            )}
            {['open', 'in_progress'].includes(i.status) && (
              <button className="btn ghost sm" onClick={() => setStatus(i.id, 'dismissed')} title="Not needed">
                ✕
              </button>
            )}
          </div>
        );
      })}
      {canAdd && (
        <form className="row" onSubmit={add} style={{ marginTop: 4 }}>
          <input className="grow" placeholder="Add an action item" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New action item" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" style={{ width: 140 }} />
          <button className="btn sm" disabled={!title.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- insights
const SEV: Record<string, string> = { risk: 'bad', opportunity: 'good', warn: 'warn', info: 'info' };
export function InsightList({ items, compact }: { items: Json[]; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const act = async (id: string, body: Json) => {
    try {
      await patch(`/api/v1/intel/insights/${id}`, body);
      qc.invalidateQueries({ queryKey: ['copilot'] });
      qc.invalidateQueries({ queryKey: ['insights'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (!items.length) return <p className="muted small">Nothing needs your attention right now.</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((i) => (
        <div key={i.id} className={`insight ${i.severity}`}>
          <span className={`chip ${SEV[i.severity] ?? 'info'} tiny`}>{i.severity === 'opportunity' ? 'Opportunity' : i.severity === 'risk' ? 'Risk' : i.severity === 'warn' ? 'Attention' : 'Tip'}</span>
          <div className="grow">
            <div className="insight-title">{i.related_object && i.related_id ? <Link to={citeHref({ object: i.related_object, id: i.related_id })}>{i.title}</Link> : i.title}</div>
            {i.body && !compact && <div className="small muted">{i.body}</div>}
          </div>
          <div className="row" style={{ gap: 2 }}>
            <button className="btn ghost sm" onClick={() => act(i.id, { snoozeDays: 3 })} title="Hide for 3 days">
              Later
            </button>
            <button className="btn ghost sm" onClick={() => act(i.id, { status: 'dismissed' })} title="Dismiss">
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------- suggestions
const fmtVal = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-IN') : String(v));
export function Suggestions({ object, id, labels }: { object: string; id: string; labels: Record<string, string> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['suggestions', object, id], queryFn: () => get<{ items: Json[] }>(`/api/v1/intel/suggestions?object=${object}&id=${id}`) });
  const decide = async (sid: string, action: 'apply' | 'reject') => {
    try {
      await post(`/api/v1/intel/suggestions/${sid}/${action}`);
      qc.invalidateQueries({ queryKey: ['suggestions', object, id] });
      if (action === 'apply') {
        qc.invalidateQueries({ queryKey: ['record', object, id] });
        toast('Updated');
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (!q.data?.items.length) return null;
  return (
    <div className="ai-box">
      <h3>Suggested updates</h3>
      <p className="small muted">From a meeting or call. Nothing changes until you apply it.</p>
      {q.data.items.map((s) => (
        <div key={s.id} className="suggestion">
          <div className="grow">
            <b>{labels[s.field_key] ?? s.field_key.replace(/_id$/, '').replace(/_/g, ' ')}</b>: <span className="muted">{s.field_key === 'stage_id' ? 'current stage' : fmtVal(s.current_value)}</span> → <b>{s.field_key === 'stage_id' ? labels[`stage:${s.proposed_value}`] ?? 'new stage' : fmtVal(s.proposed_value)}</b>
            {s.reason && <div className="small muted">“{s.reason}”</div>}
          </div>
          <button className="btn sm primary" onClick={() => decide(s.id, 'apply')}>
            Apply
          </button>
          <button className="btn sm ghost" onClick={() => decide(s.id, 'reject')}>
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------- competitors on a deal
export function DealCompetitors({ dealId, canEdit }: { dealId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tagged = useQuery({ queryKey: ['deal-competitors', dealId], queryFn: () => get<{ items: Json[] }>(`/api/v1/intel/deals/${dealId}/competitors`) });
  const all = useQuery({ queryKey: ['competitors'], queryFn: () => get<{ items: Json[] }>('/api/v1/intel/competitors'), staleTime: 300_000 });
  const [open, setOpen] = useState<string | null>(null);
  const set = async (cid: string, status: string | null) => {
    try {
      if (status) await put(`/api/v1/intel/deals/${dealId}/competitors/${cid}`, { status });
      else await del(`/api/v1/intel/deals/${dealId}/competitors/${cid}`);
      qc.invalidateQueries({ queryKey: ['deal-competitors', dealId] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const items = tagged.data?.items ?? [];
  const untagged = (all.data?.items ?? []).filter((c) => c.is_active && !items.some((t) => t.competitor_id === c.id));
  return (
    <div>
      <div className="spread">
        <h3>Competitors</h3>
        {canEdit && untagged.length > 0 && (
          <select aria-label="Add competitor" value="" onChange={(e) => e.target.value && set(e.target.value, 'active')} style={{ width: 'auto' }}>
            <option value="">+ Add</option>
            {untagged.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {items.length === 0 && <p className="small muted">{(all.data?.items.length ?? 0) === 0 ? 'Add competitors and their battlecards in Settings → Competitors.' : 'Nobody tagged yet.'}</p>}
      {items.map((c) => (
        <div key={c.competitor_id} className="comp-row">
          <div className="spread">
            <button className="link-btn" onClick={() => setOpen(open === c.competitor_id ? null : c.competitor_id)}>
              <b>{c.name}</b> {c.source === 'ai' && <span className="chip info tiny">from a conversation</span>}
            </button>
            {canEdit ? (
              <select aria-label={`${c.name} status`} value={c.status} onChange={(e) => set(c.competitor_id, e.target.value === 'remove' ? null : e.target.value)} style={{ width: 'auto' }}>
                <option value="active">In play</option>
                <option value="beaten">We beat them</option>
                <option value="lost_to">Lost to them</option>
                <option value="remove">Remove</option>
              </select>
            ) : (
              <span className="small muted">{c.status.replace('_', ' ')}</span>
            )}
          </div>
          {open === c.competitor_id && (
            <div className="small battlecard">
              {c.strengths && (
                <p>
                  <b>Their strengths:</b> {c.strengths}
                </p>
              )}
              {c.weaknesses && (
                <p>
                  <b>Their weaknesses:</b> {c.weaknesses}
                </p>
              )}
              {c.pricing_notes && (
                <p>
                  <b>Pricing:</b> {c.pricing_notes}
                </p>
              )}
              {c.how_we_win && (
                <p>
                  <b>How we win:</b> {c.how_we_win}
                </p>
              )}
              {!c.strengths && !c.weaknesses && !c.how_we_win && <p className="muted">No battlecard written yet.</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------- Ask Synapse
export function AskBox({ object, id, placeholder }: { object?: string; id?: string; placeholder?: string }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState<{ question: string; answer: string | null; citations: Citation[]; matches: Json[]; note?: string } | null>(null);
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await post<Json>('/api/v1/intel/ask', { question: q, ...(object && id ? { object, id } : {}) });
      setAns({ question: q, answer: r.answer, citations: r.citations ?? [], matches: r.matches ?? [], note: r.note });
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask">
      <form className="ask-form" onSubmit={ask}>
        <span className="ask-spark" aria-hidden="true">✦</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? 'Ask Synapse about your customers, deals and conversations…'} aria-label="Ask Synapse" maxLength={800} />
        <button className="btn ai" disabled={busy || q.trim().length < 3}>
          {busy ? 'Thinking…' : 'Ask'}
        </button>
      </form>
      {ans && (
        <div className="ai-box ask-answer">
          <div className="small muted">{ans.question}</div>
          {ans.answer ? <p style={{ margin: '6px 0' }}>{ans.answer}</p> : <p className="small muted">{ans.note}</p>}
          {ans.citations.length > 0 && (
            <div className="small">
              Sources:{' '}
              {ans.citations.map((c) => (
                <Link key={`${c.ref}-${c.id}`} to={citeHref(c)} className="source-link">
                  {c.label}
                </Link>
              ))}
            </div>
          )}
          {!ans.answer && ans.matches.length > 0 && (
            <ul className="small">
              {ans.matches.map((m, i) => (
                <li key={i}>
                  <Link to={citeHref(m as { object: string; id: string })}>{m.label}</Link> — {m.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

