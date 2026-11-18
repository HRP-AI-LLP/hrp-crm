/** No-sign-in pages: the dealer portal and the public help centre. */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/ui';

type Json = Record<string, any>;
const inr = (v: unknown) => `₹${Math.round(Number(v ?? 0)).toLocaleString('en-IN')}`;
const d = (v: unknown) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? 'Something went wrong');
  return j as T;
}

export function DealerPortalPage() {
  const { token = '' } = useParams();
  const [r, setR] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'orders' | 'invoices' | 'deals' | 'prices' | 'lead'>('orders');
  const [f, setF] = useState({ name: '', company: '', phone: '', email: '', city: '', requirement: '' });
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    call<Json>(`/api/public/dealer/${encodeURIComponent(token)}`)
      .then((j) => {
        setR(j);
        document.title = `${j.dealer.name} — ${j.company} dealer portal`;
      })
      .catch(() => setErr('This portal link is not active.'));
  }, [token]);
  if (err) return <div className="public-wrap"><p>{err}</p></div>;
  if (!r) return <div className="public-wrap"><Spinner /></div>;
  const s = r.summary;
  return (
    <div className="public-wrap customer-page" style={{ maxWidth: 1000 }}>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="muted small">{r.company} · dealer portal</div>
          <h1 style={{ margin: '2px 0' }}>{r.dealer.name}</h1>
          <div className="small muted">
            {r.dealer.tier ? `${r.dealer.tier[0].toUpperCase()}${r.dealer.tier.slice(1)} dealer` : 'Dealer'}
            {r.dealer.territory ? ` · ${r.dealer.territory}` : ''}
          </div>
        </div>
      </div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        {[
          ['Your purchases (this year)', inr(s.purchases)],
          ['Won from your leads', inr(s.wonValue)],
          ['In the pipeline', inr(s.openValue)],
          ['You owe', inr(s.outstanding)],
        ].map(([l, v]) => (
          <div key={l} className="panel kpi">
            <div className="l">{l}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>
      {r.schemes.length > 0 && (
        <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
          <b>Your schemes</b>
          {r.schemes.map((x: Json) => (
            <div key={x.name} className="spread small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <span>
                {x.name} — {x.ratePct}% of {x.basis === 'won_deals' ? 'won deals you bring' : 'your purchases'} until {d(x.endsOn)}
              </span>
              <span>{x.earned ? <b>Earned {inr(x.earned)}</b> : `${inr(x.gap)} more to qualify`}</span>
            </div>
          ))}
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['orders', `Orders (${r.orders.length})`],
            ['invoices', `Invoices (${r.invoices.length})`],
            ['deals', `Your leads & deals (${r.deals.length})`],
            ['prices', 'Price list'],
            ['lead', '+ Register a lead'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="panel" style={{ padding: 12 }}>
        {tab === 'orders' && (
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Status</th>
                <th>Expected</th>
                <th className="num">Value</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {r.orders.map((o: Json) => (
                <tr key={o.order_number}>
                  <td>{o.order_number}</td>
                  <td>{d(o.order_date)}</td>
                  <td>{String(o.status).replace(/_/g, ' ')}</td>
                  <td>{d(o.expected_delivery_date)}</td>
                  <td className="num">{inr(o.grand_total)}</td>
                  <td className="num">{inr(o.balance_due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'invoices' && (
          <table className="data">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Due</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {r.invoices.map((i: Json) => (
                <tr key={i.invoice_number}>
                  <td>{i.invoice_number}</td>
                  <td>{d(i.invoice_date)}</td>
                  <td>{d(i.due_date)}</td>
                  <td className="num">{inr(i.grand_total)}</td>
                  <td className="num">{i.balance_due ? <b>{inr(i.balance_due)}</b> : 'Paid'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'deals' && (
          <table className="data">
            <thead>
              <tr>
                <th>Deal</th>
                <th>Stage</th>
                <th className="num">Value</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {r.deals.map((x: Json, i: number) => (
                <tr key={i}>
                  <td>{x.name}</td>
                  <td>
                    <span className={`chip${x.category === 'won' ? ' good' : x.category === 'lost' ? ' bad' : ''}`}>{x.stage}</span>
                  </td>
                  <td className="num">{x.amount ? inr(x.amount) : '—'}</td>
                  <td>{d(x.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'prices' &&
          (r.prices.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Code</th>
                  <th className="num">From qty</th>
                  <th className="num">Your price</th>
                </tr>
              </thead>
              <tbody>
                {r.prices.map((p: Json, i: number) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td>{p.sku ?? ''}</td>
                    <td className="num">{p.min_qty > 1 ? `${p.min_qty}+` : ''}</td>
                    <td className="num">
                      {inr(p.unit_price)}
                      {p.unit ? ` / ${p.unit}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No price list shared yet.</p>
          ))}
        {tab === 'lead' &&
          (sent ? (
            <div className="stack">
              <p>✅ {sent}</p>
              <button className="btn" onClick={() => setSent(null)}>
                Register another
              </button>
            </div>
          ) : (
            <form
              className="grid2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await call(`/api/public/dealer/${encodeURIComponent(token)}/leads`, { ...f, company: f.company || null, phone: f.phone || null, email: f.email || null, city: f.city || null, requirement: f.requirement || null });
                  setSent(`${f.name} is registered and credited to you. Our team will be in touch with them.`);
                  setF({ name: '', company: '', phone: '', email: '', city: '', requirement: '' });
                } catch (er) {
                  window.alert((er as Error).message);
                }
              }}
            >
              {(
                [
                  ['name', 'Customer name *'],
                  ['company', 'Company'],
                  ['phone', 'Phone'],
                  ['email', 'Email'],
                  ['city', 'City'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="field">
                  {l}
                  <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={k === 'name'} />
                </label>
              ))}
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                What they need
                <textarea rows={3} value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} />
              </label>
              <div>
                <button className="btn primary" disabled={!f.name.trim() || (!f.phone.trim() && !f.email.trim())}>
                  Register lead
                </button>
              </div>
            </form>
          ))}
      </div>
    </div>
  );
}

export function HelpCentrePage() {
  const { token = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const article = params.get('article');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [r, setR] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams({ ...(article ? { article } : {}), ...(params.get('q') ? { q: params.get('q')! } : {}) }).toString();
    setR(null);
    call<Json>(`/api/public/help/${encodeURIComponent(token)}${qs ? `?${qs}` : ''}`)
      .then((j) => {
        setR(j);
        document.title = `${j.article?.title ? `${j.article.title} — ` : ''}${j.title} · ${j.company}`;
      })
      .catch(() => setErr('This help centre is not available.'));
  }, [token, article, params]);
  if (err) return <div className="public-wrap"><p>{err}</p></div>;
  return (
    <div className="public-wrap customer-page" style={{ maxWidth: 860 }}>
      <div style={{ marginBottom: 16 }}>
        <div className="muted small">{r?.company}</div>
        <h1 style={{ margin: '2px 0 10px', cursor: 'pointer' }} onClick={() => setParams({})}>
          {r?.title ?? 'Help centre'}
        </h1>
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            setParams(q.trim() ? { q: q.trim() } : {});
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for answers…" aria-label="Search" />
          <button className="btn primary">Search</button>
        </form>
      </div>
      {!r ? (
        <Spinner />
      ) : r.article ? (
        <article className="panel" style={{ padding: 18 }}>
          <button className="link-btn small" onClick={() => setParams({})}>
            ← All articles
          </button>
          <h2 style={{ marginTop: 8 }}>{r.article.title}</h2>
          <div className="muted small">{r.article.category ?? 'General'}</div>
          <div className="md" style={{ marginTop: 12 }}>
            <Markdown source={r.article.content ?? ''} />
          </div>
        </article>
      ) : r.categories.length ? (
        r.categories.map((c: Json) => (
          <section key={c.name} style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 15 }}>{c.name}</h3>
            {c.items.map((a: Json) => (
              <button key={a.id} className="panel" style={{ display: 'block', width: '100%', textAlign: 'left', padding: 12, marginBottom: 6, cursor: 'pointer' }} onClick={() => setParams({ article: a.id })}>
                <b>{a.title}</b>
                <div className="muted small" style={{ marginTop: 2 }}>
                  {a.excerpt}
                  {a.excerpt?.length >= 220 ? '…' : ''}
                </div>
              </button>
            ))}
          </section>
        ))
      ) : (
        <p className="muted">{r.search ? `Nothing found for "${r.search}".` : 'No articles yet.'}</p>
      )}
    </div>
  );
}
