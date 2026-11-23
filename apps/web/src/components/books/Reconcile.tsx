/**
 * Match & reconcile: what SanchalanOS thinks belongs together — receipts and invoices (with the TDS
 * the customer kept), payments and bills, milestones and invoices, milestones and approval emails,
 * documents and projects, claims and bank payments, bank lines — saved only when a person approves.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { Empty, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type Result = { items: Json[]; counts: Record<string, number>; labels: Record<string, string>; errors: string[] };

const conf = (c: number): [string, string] => (c >= 0.9 ? ['sure', 'good'] : c >= 0.7 ? ['likely', 'info'] : c >= 0.5 ? ['possible', 'warn'] : ['a guess', '']);

export function ReconcilePage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Match & reconcile</h1>
          <p>Receipts and invoices, payments and bills, milestones, projects, claims and bank lines — matched for you. Nothing is saved until you approve it.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-body">
          <ReconcilePanel />
        </div>
      </div>
    </div>
  );
}

/** focus: 'payment:<id>', 'project:<id>', 'invoice:<id>'… to show only what concerns one record. */
export function ReconcilePanel({ focus, onDone }: { focus?: string; onDone?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [edits, setEdits] = useState<Record<string, Json>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const key = ['reconcile', focus ?? null];
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: key, queryFn: () => get<Result>(`/api/v1/reconcile${focus ? `?focus=${focus}` : ''}`) });
  const items = useMemo(() => (data?.items ?? []).filter((s) => !kind || s.kind === kind), [data, kind]);
  // one suggestion per thing on the left is shown first; alternatives follow it
  const seen = new Set<string>();
  const ordered: Json[] = items.map((s) => {
    const k = `${s.left.type}:${s.left.id}`;
    const alt = seen.has(k);
    seen.add(k);
    return { ...s, alt };
  });

  const act = (s: Json) => ({ ...s.action, ...(edits[s.key] ?? {}) });
  const apply = async (list: Json[], label: string) => {
    setBusy(label);
    try {
      const r = await post<{ results: { key: string; ok: boolean; error?: string }[] }>('/api/v1/reconcile/apply', { items: list.map((s) => ({ key: s.key, kind: s.kind, action: act(s) })) });
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.filter((x) => !x.ok);
      toast(bad.length ? `${ok} saved; ${bad.length} could not be: ${bad[0]!.error}` : `${ok} saved`, bad.length > 0);
      await refetch();
      for (const k of ['payment', 'invoice', 'record', 'project', 'projects', 'bill', 'vendor_payment', 'expense']) qc.invalidateQueries({ queryKey: [k] });
      onDone?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const reject = async (s: Json) => {
    setBusy(s.key);
    try {
      await post('/api/v1/reconcile/reject', { keys: [s.key] });
      await refetch();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const sure = items.filter((s) => s.confidence >= 0.9 && s.kind !== 'receipt_milestone');

  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={`chip-btn ${kind === '' ? 'on' : ''}`} onClick={() => setKind('')}>
            All {data?.items.length ?? 0}
          </button>
          {Object.entries(data?.counts ?? {}).map(([k, n]) => (
            <button key={k} type="button" className={`chip-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {data?.labels[k] ?? k} {n}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn sm ghost" disabled={isFetching} onClick={() => refetch()}>
            {isFetching ? 'Looking…' : 'Look again'}
          </button>
          {sure.length > 0 && (
            <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => confirm(`Approve the ${sure.length} sure matches?`) && apply(sure, 'all')}>
              Approve {sure.length} sure
            </button>
          )}
        </div>
      </div>
      {data?.errors.length ? <div className="notice small">Some checks could not run: {data.errors.join('; ')}</div> : null}
      {!ordered.length ? (
        <Empty title="Everything is matched">{focus ? 'Nothing waiting for this record.' : 'New receipts, bank lines, bills and finished milestones will show up here.'}</Empty>
      ) : (
        ordered.map((s) => {
          const [cl, ct] = conf(s.confidence);
          const e = edits[s.key] ?? {};
          const set = (p: Json) => setEdits({ ...edits, [s.key]: { ...e, ...p } });
          return (
            <div key={s.key} className={`rc-card ${s.alt ? 'alt' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={`chip ${ct}`} title={`${Math.round(s.confidence * 100)}%`}>
                    {cl}
                  </span>
                  <b>{s.title}</b>
                  {s.alt && <span className="small muted">(another option)</span>}
                </div>
                <span className="small muted">{data?.labels[s.kind]}</span>
              </div>
              <div className="rc-pair">
                <RefBox r={s.left} />
                <span className="rc-arrow" aria-hidden>
                  ⟷
                </span>
                <div className="stack" style={{ gap: 6 }}>
                  {s.right.length ? s.right.map((r: Json, i: number) => <RefBox key={i} r={r} />) : <span className="muted small">{s.kind === 'bank' ? 'see the reasons' : '—'}</span>}
                </div>
              </div>
              {s.reasons.length > 0 && (
                <ul className="small muted rc-reasons">
                  {s.reasons.map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {s.kind === 'receipt_invoice' && (
                <div className="row small" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {(s.action.allocations as Json[]).map((a, i) => (
                    <label key={a.invoiceId} className="row" style={{ gap: 4 }}>
                      Apply to {s.right[i]?.label ?? 'invoice'} ₹
                      <input
                        inputMode="decimal"
                        style={{ width: 110 }}
                        value={(e.allocations?.[i]?.amount ?? a.amount) as number}
                        onChange={(ev) => set({ allocations: (s.action.allocations as Json[]).map((x, j) => ({ ...x, amount: j === i ? Number(ev.target.value) || 0 : Number(e.allocations?.[j]?.amount ?? x.amount) })) })}
                      />
                    </label>
                  ))}
                  {(Number(s.action.tds) > 0 || Number(s.action.gstTds) > 0 || e.tds !== undefined || e.gstTds !== undefined) && (
                    <>
                      <label className="row" style={{ gap: 4 }} title="Income-tax TDS the customer deducted (section 194J / 194C…)">
                        TDS ₹<input inputMode="decimal" style={{ width: 90 }} value={e.tds ?? s.action.tds} onChange={(ev) => set({ tds: Number(ev.target.value) || 0 })} />
                      </label>
                      <label className="row" style={{ gap: 4 }} title="GST TDS deducted by a government buyer (section 51, 2%)">
                        GST TDS ₹<input inputMode="decimal" style={{ width: 90 }} value={e.gstTds ?? s.action.gstTds} onChange={(ev) => set({ gstTds: Number(ev.target.value) || 0 })} />
                      </label>
                    </>
                  )}
                </div>
              )}
              <div className="row" style={{ gap: 6 }}>
                {s.action.open ? (
                  <Link className="btn sm primary" to={String(s.action.open)}>
                    Open the project's billing
                  </Link>
                ) : (
                  <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => apply([s], s.key)}>
                    {busy === s.key ? 'Saving…' : 'Approve'}
                  </button>
                )}
                <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => reject(s)}>
                  Not this
                </button>
                {s.kind === 'bank' && (
                  <Link className="btn sm ghost" to="/books#desk">
                    Change it in the accounts desk
                  </Link>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function RefBox({ r }: { r: Json }) {
  const body = (
    <>
      <b>{r.label}</b>
      <span className="small muted">
        {[r.sub, r.date ? date(r.date) : null].filter(Boolean).join(' · ')}
      </span>
      {r.amount != null && <span className="small">{money2(Number(r.amount))}</span>}
    </>
  );
  return r.link ? (
    <Link className="rc-ref" to={r.link}>
      {body}
    </Link>
  ) : (
    <div className="rc-ref">{body}</div>
  );
}
