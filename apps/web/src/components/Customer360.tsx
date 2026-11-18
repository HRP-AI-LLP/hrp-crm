/** Customer 360: the money, the work and one timeline for a customer, at the top of its page. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { money2 } from '../lib/format';
import { inrShort } from './books/BooksDashboard';
import { NI } from './NavIcons';

type Json = Record<string, any>;
const COLORS: Record<string, string> = { invoice: '#0f8dde', payment: '#059669', deal: '#7c3aed', contract: '#0b6d86', activity: '#94a3b8' };
const LINK: Record<string, (id: string) => string> = {
  invoice: (id) => `/o/invoice/${id}`,
  payment: (id) => `/o/payment/${id}`,
  deal: (id) => `/o/deal/${id}`,
  contract: (id) => `/it/contracts?contract=${id}`,
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="panel kpi">
      <div className="l">{label}</div>
      <div className="v" style={{ fontSize: 22, color: tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--good)' : undefined }}>
        {value}
      </div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

export function Customer360({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['c360', id], queryFn: () => get<Json>(`/api/v1/accounts/${id}/360`), retry: false });
  const [all, setAll] = useState(false);
  if (!data) return null;
  const m = data.money as Json | undefined;
  const deals = (data.deals ?? []) as Json[];
  const open = deals.filter((d) => d.category === 'open');
  const won = deals.filter((d) => d.category === 'won');
  const tl = (data.timeline ?? []) as Json[];
  const shown = all ? tl : tl.slice(0, 8);
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="c360">
        {m && <Stat label="Invoiced" value={inrShort(m.invoiced)} sub={`${m.invoices} invoice${m.invoices === 1 ? '' : 's'} · received ${inrShort(m.received)}`} />}
        {m && <Stat label="Outstanding" value={money2(m.outstanding)} tone={m.overdue > 0 ? 'bad' : undefined} sub={m.overdue > 0 ? `${money2(m.overdue)} overdue` : 'nothing overdue'} />}
        <Stat label="Open deals" value={String(open.length)} sub={open.length ? `worth ${inrShort(open.reduce((t, d) => t + Number(d.amount ?? 0), 0))}` : won.length ? `${won.length} won before` : 'none yet'} />
        <Stat
          label="Work"
          value={`${(data.projects ?? []).length + (data.contracts ?? []).length}`}
          sub={`${(data.projects ?? []).length} project(s) · ${(data.contracts ?? []).length} contract(s)${m?.avg_days_to_pay != null ? ` · pays in ~${m.avg_days_to_pay} days` : ''}`}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Timeline</h2>
            {tl.length > 8 && (
              <button className="btn ghost sm" onClick={() => setAll(!all)}>
                {all ? 'Show less' : `Show all ${tl.length}`}
              </button>
            )}
          </div>
          <div className="panel-body">
            {!tl.length ? (
              <p className="muted small">Nothing yet.</p>
            ) : (
              <ul className="tl">
                {shown.map((x) => (
                  <li key={`${x.kind}:${x.id}`} style={{ ['--c' as string]: COLORS[x.kind] }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      {LINK[x.kind] ? <Link to={LINK[x.kind]!(x.id)}>{x.title}</Link> : <span>{x.title}</span>}
                      {x.amount != null && <b className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>{money2(x.amount)}</b>}
                    </div>
                    <div className="small muted">
                      {x.at ? new Date(x.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
                      {x.note ? ` · ${String(x.note).replace(/_/g, ' ')}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Deals, projects and contracts</h2>
          </div>
          <div style={{ padding: '4px 18px 10px' }}>
            {[...deals.map((d) => ({ k: 'deal', id: d.id, name: d.name, sub: d.stage, amt: d.amount, to: `/o/deal/${d.id}`, icon: 'target' })),
              ...(data.projects ?? []).map((p: Json) => ({ k: 'project', id: p.id, name: p.name, sub: p.status, amt: null, to: `/projects/${p.id}`, icon: 'folder' })),
              ...(data.contracts ?? []).map((c: Json) => ({ k: 'contract', id: c.id, name: c.name, sub: `${c.kind.replace(/_/g, ' ')} · ${c.status}${c.end_date ? ` · ends ${c.end_date}` : ''}`, amt: c.value, to: `/it/contracts?contract=${c.id}`, icon: 'contract' })),
            ].map((x) => (
              <div className="attn" key={`${x.k}:${x.id}`}>
                <span style={{ color: 'var(--brand-600)', display: 'inline-flex' }}>
                  <NI name={x.icon} size={16} className="" />
                </span>
                <div className="t">
                  <Link to={x.to}>{x.name}</Link>
                  <div className="meta">{x.sub}</div>
                </div>
                {x.amt ? <span className="amt small">{inrShort(Number(x.amt))}</span> : null}
              </div>
            ))}
            {!deals.length && !(data.projects ?? []).length && !(data.contracts ?? []).length && <p className="muted small">No deals, projects or contracts yet.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>People</h2>
          </div>
          <div style={{ padding: '4px 18px 10px' }}>
            {(data.contacts ?? []).map((c: Json) => (
              <div className="attn" key={c.id}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                  {String(c.name || '?').split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div className="t">
                  <Link to={`/o/contact/${c.id}`}>{c.name || c.email}</Link>
                  <div className="meta">{[c.title, c.email, c.phone].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
            {!(data.contacts ?? []).length && <p className="muted small">No contacts yet.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
