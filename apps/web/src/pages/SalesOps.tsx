/**
 * Sales operations: quote-to-order (RFQs, price lists with tiers and customer lists, credit control,
 * available-to-promise), the dealer channel (performance, schemes, rebates), management analytics
 * (product, region, fulfilment, repeat, seasonality, forecast vs actual, profitability, win / loss)
 * and engagement (email sequences, the public help centre).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Chart } from '../components/charts';
import { LookupPicker } from '../components/fields';
import { d, Head, inr, inrShort, type Json, Kpis, label, NoRows, pct, today, useAct, usePeriod } from '../components/industry/kit';
import { SideTabs } from '../components/SideTabs';
import { Modal, Spinner } from '../components/ui';
import { del, get, post, put } from '../lib/api';

type Sec = 'rfqs' | 'prices' | 'credit' | 'atp' | 'dealers' | 'schemes' | 'rebates' | 'products' | 'regions' | 'fulfilment' | 'repeat' | 'seasonal' | 'forecast' | 'profit' | 'winloss' | 'sequences' | 'help';

const ITEMS: { key: Sec; label: string; icon: string; group: string }[] = [
  { key: 'rfqs', label: 'RFQs', icon: 'inbox', group: 'Quote to order' },
  { key: 'prices', label: 'Price lists & tiers', icon: 'rupee', group: 'Quote to order' },
  { key: 'credit', label: 'Credit control', icon: 'card', group: 'Quote to order' },
  { key: 'atp', label: 'Stock & promise dates', icon: 'box', group: 'Quote to order' },
  { key: 'dealers', label: 'Dealers & territories', icon: 'users', group: 'Channel' },
  { key: 'schemes', label: 'Dealer schemes', icon: 'spark', group: 'Channel' },
  { key: 'rebates', label: 'Rebates', icon: 'repeat', group: 'Channel' },
  { key: 'products', label: 'Sales by product', icon: 'chart', group: 'Analytics' },
  { key: 'regions', label: 'Sales by region', icon: 'grid', group: 'Analytics' },
  { key: 'fulfilment', label: 'Order fulfilment', icon: 'truck', group: 'Analytics' },
  { key: 'repeat', label: 'Repeat orders', icon: 'repeat', group: 'Analytics' },
  { key: 'seasonal', label: 'Seasonality', icon: 'calendar', group: 'Analytics' },
  { key: 'forecast', label: 'Forecast vs actual', icon: 'trend', group: 'Analytics' },
  { key: 'profit', label: 'Customer profitability', icon: 'gauge', group: 'Analytics' },
  { key: 'winloss', label: 'Win / loss', icon: 'target', group: 'Analytics' },
  { key: 'sequences', label: 'Email sequences', icon: 'mail', group: 'Engagement' },
  { key: 'help', label: 'Help centre', icon: 'book', group: 'Engagement' },
];

export function SalesOpsPage() {
  const [sec, setSec] = useState<Sec>('rfqs');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales operations</h1>
          <p className="muted small" style={{ margin: 0 }}>
            RFQs to orders, pricing, credit, the dealer channel and the numbers management asks for
          </p>
        </div>
      </div>
      <SideTabs id="salesops" title="Sales operations" items={ITEMS} value={sec} onChange={setSec}>
        {sec === 'rfqs' && <Rfqs />}
        {sec === 'prices' && <Prices />}
        {sec === 'credit' && <Credit />}
        {sec === 'atp' && <Atp />}
        {sec === 'dealers' && <Dealers />}
        {sec === 'schemes' && <Schemes />}
        {sec === 'rebates' && <Rebates />}
        {sec === 'products' && <ByProduct />}
        {sec === 'regions' && <ByRegion />}
        {sec === 'fulfilment' && <Fulfilment />}
        {sec === 'repeat' && <Repeat />}
        {sec === 'seasonal' && <Seasonal />}
        {sec === 'forecast' && <Forecast />}
        {sec === 'profit' && <Profitability />}
        {sec === 'winloss' && <WinLoss />}
        {sec === 'sequences' && <Sequences />}
        {sec === 'help' && <HelpCentre />}
      </SideTabs>
    </div>
  );
}

/* ───────────── RFQs ───────────── */

function Rfqs() {
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ['rfqs', all], queryFn: () => get<{ items: Json[] }>(`/api/v1/rfqs${all ? '' : '?open=1'}`) });
  const items = data?.items ?? [];
  return (
    <>
      <Head title="Requests for quotation" sub="Log the customer's RFQ, price it (their price list and quantity tiers apply), then send it as a quote.">
        <label className="check-row">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show answered RFQs
        </label>
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          New RFQ
        </button>
      </Head>
      <Kpis
        items={[
          { l: 'Open RFQs', v: items.filter((x) => x.status === 'rfq').length },
          { l: 'Overdue', v: items.filter((x) => x.overdue).length, tone: items.some((x) => x.overdue) ? 'bad' : undefined },
          { l: 'Due this week', v: items.filter((x) => x.status === 'rfq' && x.rfq_due_on && x.rfq_due_on <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)).length },
        ]}
      />
      {items.length ? (
        <div className="table-wrap">
          <table className="data" data-export-title="RFQs">
            <thead>
              <tr>
                <th>RFQ</th>
                <th>Customer</th>
                <th>Received</th>
                <th>Due</th>
                <th className="num">Lines</th>
                <th className="num">Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={r.overdue ? 'row-highlight' : undefined}>
                  <td>
                    <Link to={`/o/quote/${r.id}`}>{r.name}</Link>
                    <div className="muted small">{[r.rfq_number, r.quote_number].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>{r.account}</td>
                  <td>{d(r.rfq_received_on)}</td>
                  <td>{r.overdue ? <span className="chip bad">{d(r.rfq_due_on)}</span> : d(r.rfq_due_on)}</td>
                  <td className="num">{r.lines}</td>
                  <td className="num">{r.grand_total ? inr(r.grand_total) : '—'}</td>
                  <td>
                    <span className={`chip${r.status === 'rfq' ? ' warn' : r.status === 'accepted' ? ' good' : ''}`}>{r.status === 'rfq' ? 'to price' : label(r.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <NoRows>No open RFQs. Log one when a customer asks for a price.</NoRows>
      )}
      {adding && <RfqModal onClose={() => setAdding(false)} />}
    </>
  );
}

function RfqModal({ onClose }: { onClose: () => void }) {
  const act = useAct([['rfqs']]);
  const [f, setF] = useState({ name: '', accountId: '', rfqNumber: '', receivedOn: today(), dueOn: '', customerRef: '', notes: '' });
  return (
    <Modal
      title="New RFQ"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || !f.accountId}
          onClick={async () => {
            const r = await act(() => post<{ id: string }>('/api/v1/rfqs', { ...f, dueOn: f.dueOn || null, rfqNumber: f.rfqNumber || null, customerRef: f.customerRef || null, notes: f.notes || null }), 'RFQ logged');
            if (r) window.location.assign(`/o/quote/${r.id}`);
          }}
        >
          Create and add lines
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          What they asked for
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="e.g. 12 × 5HP motors for line 4" />
        </label>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          Customer
          <LookupPicker id="rfq-acc" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </div>
        <label className="field">
          Their RFQ number
          <input value={f.rfqNumber} onChange={(e) => setF({ ...f, rfqNumber: e.target.value })} />
        </label>
        <label className="field">
          Their reference / enquiry
          <input value={f.customerRef} onChange={(e) => setF({ ...f, customerRef: e.target.value })} />
        </label>
        <label className="field">
          Received on
          <input type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} />
        </label>
        <label className="field">
          Quote due by
          <input type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────── price lists ───────────── */

function Prices() {
  const { data } = useQuery({ queryKey: ['price-lists'], queryFn: () => get<{ items: Json[] }>('/api/v1/price-lists') });
  const [scope, setScope] = useState<Json | null>(null);
  const [tiers, setTiers] = useState<{ book: Json } | null>(null);
  return (
    <>
      <Head title="Price lists" sub="The default list, lists for one customer (and its plants), and quantity tiers. Quotes pick the customer's list; 'Apply customer prices' on a quote re-prices it.">
        <Link className="btn sm" to="/settings?tab=sales">
          Edit list prices
        </Link>
      </Head>
      {data?.items.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Price list</th>
              <th>For</th>
              <th>Valid</th>
              <th className="num">Products</th>
              <th className="num">Quantity tiers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((b) => (
              <tr key={b.id}>
                <td>
                  <b>{b.name}</b> {b.is_default && <span className="chip">default</span>} {!b.is_active && <span className="chip">inactive</span>}
                </td>
                <td>{b.account ?? <span className="muted">Everyone{b.customers ? ` · assigned to ${b.customers}` : ''}</span>}</td>
                <td className="small">{b.valid_from || b.valid_to ? `${d(b.valid_from)} – ${d(b.valid_to)}` : '—'}</td>
                <td className="num">{b.products}</td>
                <td className="num">{b.tiers}</td>
                <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => setTiers({ book: b })}>
                    Tiers
                  </button>
                  <button className="btn sm" onClick={() => setScope(b)}>
                    Customer & dates
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No price lists yet. Create one under Settings → Sales.</NoRows>
      )}
      {scope && <ScopeModal book={scope} onClose={() => setScope(null)} />}
      {tiers && <TiersModal book={tiers.book} onClose={() => setTiers(null)} />}
    </>
  );
}

function ScopeModal({ book, onClose }: { book: Json; onClose: () => void }) {
  const act = useAct([['price-lists']]);
  const [f, setF] = useState({ accountId: book.account_id ?? '', validFrom: book.valid_from ?? '', validTo: book.valid_to ?? '' });
  return (
    <Modal
      title={`${book.name}: who and when`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={async () => (await act(() => put(`/api/v1/price-lists/${book.id}/scope`, { accountId: f.accountId || null, validFrom: f.validFrom || null, validTo: f.validTo || null }), 'Saved')) && onClose()}>
          Save
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="field">
          Only for this customer (and its plants / branches) — leave empty for everyone
          <LookupPicker id="pl-acc" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </div>
        <div className="grid2">
          <label className="field">
            Valid from
            <input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />
          </label>
          <label className="field">
            Valid until
            <input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} />
          </label>
        </div>
      </div>
    </Modal>
  );
}

function TiersModal({ book, onClose }: { book: Json; onClose: () => void }) {
  const [productId, setProductId] = useState('');
  const act = useAct([['price-lists'], ['tiers', productId]]);
  const tiers = useQuery({ queryKey: ['tiers', productId], queryFn: () => get<{ items: Json[] }>(`/api/v1/products/${productId}/tiers`), enabled: !!productId });
  const mine = (tiers.data?.items ?? []).filter((t) => t.price_book_id === book.id);
  const [rows, setRows] = useState<{ minQty: string; unitPrice: string }[] | null>(null);
  const shown = rows ?? (mine.length ? mine.map((t) => ({ minQty: String(t.min_qty), unitPrice: String(t.unit_price) })) : [{ minQty: '1', unitPrice: '' }]);
  return (
    <Modal
      title={`Quantity tiers · ${book.name}`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!productId}
          onClick={async () => {
            const clean = shown.filter((r) => r.minQty && r.unitPrice).map((r) => ({ minQty: Number(r.minQty), unitPrice: Number(r.unitPrice) }));
            if (await act(() => put(`/api/v1/price-lists/${book.id}/tiers/${productId}`, { tiers: clean }), 'Tiers saved')) setRows(null);
          }}
        >
          Save tiers
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="field">
          Product
          <LookupPicker
            id="tier-prod"
            objectKey="product"
            value={productId}
            onChange={(v) => {
              setProductId(String(v ?? ''));
              setRows(null);
            }}
          />
        </div>
        {productId && (
          <>
            <table className="data">
              <thead>
                <tr>
                  <th>From quantity</th>
                  <th>Unit price (₹)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input type="number" min={1} value={r.minQty} onChange={(e) => setRows(shown.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)))} />
                    </td>
                    <td>
                      <input type="number" min={0} value={r.unitPrice} onChange={(e) => setRows(shown.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
                    </td>
                    <td>
                      <button className="btn sm ghost" aria-label="Remove tier" onClick={() => setRows(shown.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn sm" onClick={() => setRows([...shown, { minQty: '', unitPrice: '' }])}>
              Add a tier
            </button>
            <p className="muted small" style={{ margin: 0 }}>
              The highest tier the quantity reaches applies, e.g. 1+ at ₹19,000 and 10+ at ₹17,500.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ───────────── credit control ───────────── */

function Credit() {
  const { data } = useQuery({ queryKey: ['credit-watch'], queryFn: () => get<Json>('/api/v1/credit-watch') });
  const act = useAct([['credit-watch']]);
  if (!data) return <Spinner />;
  return (
    <>
      <Head title="Credit control" sub="Customers with a credit limit or on hold. An order that takes a customer (or its group) past the limit waits here for approval before it can be confirmed." />
      {data.draftOrders.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h3 className="small" style={{ margin: '0 0 6px' }}>
            Orders waiting for credit approval
          </h3>
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th className="num">Order value</th>
                <th className="num">Owed + on order</th>
                <th className="num">Limit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.draftOrders.map((o: Json) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/o/sales_order/${o.id}`}>{o.order_number}</Link>
                  </td>
                  <td>
                    {o.account} {o.hold && <span className="chip bad">on hold</span>}
                  </td>
                  <td className="num">{inr(o.grand_total)}</td>
                  <td className="num">{inr(o.exposure)}</td>
                  <td className="num">{o.limit != null ? inr(o.limit) : '—'}</td>
                  <td>
                    {data.canApprove ? (
                      <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/sales-orders/${o.id}/credit-approve`, { note: window.prompt('Note for the approval (optional)') || null }), 'Approved on credit')}>
                        Approve on credit
                      </button>
                    ) : (
                      <button className="btn sm" onClick={() => act(() => post(`/api/v1/sales-orders/${o.id}/credit-request`, {}), 'Finance has been asked')}>
                        Ask finance
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.accounts.length ? (
        <table className="data" data-export-title="Credit limits">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="num">Limit</th>
              <th className="num">Receivables</th>
              <th className="num">Overdue</th>
              <th className="num">Open orders</th>
              <th className="num">Available</th>
              <th style={{ width: 160 }}>Used</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a: Json) => {
              const used = a.limit ? Math.min(100, (a.exposure / a.limit) * 100) : 0;
              return (
                <tr key={a.accountId}>
                  <td>
                    <Link to={`/o/account/${a.accountId}`}>{a.name}</Link> {a.hold && <span className="chip bad">on hold</span>}
                  </td>
                  <td className="num">{a.limit != null ? inr(a.limit) : '—'}</td>
                  <td className="num">{inr(a.receivables)}</td>
                  <td className="num">{a.overdue ? <span className="bad-text">{inr(a.overdue)}</span> : '—'}</td>
                  <td className="num">{inr(a.openOrders)}</td>
                  <td className="num">{a.available != null ? <span className={a.available < 0 ? 'bad-text' : undefined}>{inr(a.available)}</span> : '—'}</td>
                  <td>
                    <div className="progress" title={`${used.toFixed(0)}% used`}>
                      <span style={{ width: `${used}%`, background: used >= 100 ? 'var(--bad)' : used > 80 ? 'var(--warn)' : undefined }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <NoRows>No credit limits set. Set "Credit limit" or "Credit hold" on a customer (a parent company's limit covers its plants).</NoRows>
      )}
    </>
  );
}

/* ───────────── availability ───────────── */

function Atp() {
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const q = useQuery({ queryKey: ['atp', productId, qty], queryFn: () => get<Json>(`/api/v1/products/${productId}/availability?qty=${Number(qty) || 1}`), enabled: !!productId });
  const a = q.data;
  return (
    <>
      <Head title="Stock and promise dates" sub="What is on the shelf, what is reserved, what is coming in (purchase orders, production) and the earliest date you can promise." />
      <div className="row" style={{ gap: 8, marginBottom: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 280, margin: 0 }}>
          Product
          <LookupPicker id="atp-prod" objectKey="product" value={productId} onChange={(v) => setProductId(String(v ?? ''))} />
        </div>
        <label className="field" style={{ width: 120, margin: 0 }}>
          Quantity
          <input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>
      {a && (
        <>
          <Kpis
            items={[
              { l: 'On hand', v: a.onHand ?? '—' },
              { l: 'Reserved', v: a.reserved ?? '—' },
              { l: 'Free now', v: a.free ?? '—', tone: a.free != null && a.free < Number(qty) ? 'warn' : 'good' },
              { l: 'Can promise', v: d(a.promiseDate), sub: { stock: 'from stock', purchase: 'when the purchase arrives', production: 'when production finishes', lead_time: 'after the lead time', not_stocked: 'not stocked' }[a.from as string] },
            ]}
          />
          {a.supply.length > 0 && (
            <table className="data">
              <thead>
                <tr>
                  <th>Coming in</th>
                  <th>Reference</th>
                  <th>Expected</th>
                  <th className="num">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {a.supply.map((s: Json) => (
                  <tr key={s.id}>
                    <td>{s.kind === 'purchase' ? 'Purchase order' : 'Work order'}</td>
                    <td>
                      <Link to={`/o/${s.kind === 'purchase' ? 'purchase_order' : 'work_order'}/${s.id}`}>{s.ref}</Link>
                    </td>
                    <td>{d(s.date)}</td>
                    <td className="num">{s.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

/* ───────────── dealers ───────────── */

function Dealers() {
  const p = usePeriod();
  const { data } = useQuery({ queryKey: ['channel', p.qs], queryFn: () => get<Json>(`/api/v1/channel/overview?${p.qs}`) });
  const act = useAct([['channel']]);
  const [link, setLink] = useState<string | null>(null);
  return (
    <>
      <Head title="Dealers and distributors" sub="Accounts of type dealer, distributor or partner: deals they bring, what they buy, what they owe and the incentive they earn.">
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Kpis
            items={[
              { l: 'Dealers', v: data.totals.dealers, sub: `${data.totals.active} active in the period` },
              { l: 'Won through dealers', v: inrShort(data.totals.wonValue) },
              { l: 'Dealer purchases', v: inrShort(data.totals.purchases) },
              { l: 'Incentives earned', v: inrShort(data.totals.incentive) },
              { l: 'Dealers owe', v: inrShort(data.totals.outstanding), tone: data.totals.outstanding > 0 ? 'warn' : undefined },
            ]}
          />
          {data.byTerritory.length > 1 && (
            <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
              <Chart id="channel-territory" initial="bar" fmt={inrShort} data={{ categories: data.byTerritory.map((t: Json) => t.territory), series: [{ label: 'Won deals', values: data.byTerritory.map((t: Json) => t.wonValue) }, { label: 'Purchases', values: data.byTerritory.map((t: Json) => t.purchases) }] }} />
            </div>
          )}
          {data.dealers.length ? (
            <div className="table-wrap">
              <table className="data" data-export-title="Dealer performance">
                <thead>
                  <tr>
                    <th>Dealer</th>
                    <th>Tier</th>
                    <th>Territory</th>
                    <th className="num">Leads</th>
                    <th className="num">Deals</th>
                    <th className="num">Won</th>
                    <th className="num">Conversion</th>
                    <th className="num">Purchases</th>
                    <th className="num">Owes</th>
                    <th className="num">Incentive</th>
                    <th>Portal</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dealers.map((x: Json) => (
                    <tr key={x.id}>
                      <td>
                        <Link to={`/o/account/${x.id}`}>{x.name}</Link>
                        <div className="muted small">
                          {label(x.type)}
                          {x.city ? ` · ${x.city}` : ''}
                        </div>
                      </td>
                      <td>{x.tier ? <span className="chip">{label(x.tier)}</span> : '—'}</td>
                      <td>{x.territory ?? '—'}</td>
                      <td className="num">{x.leads}</td>
                      <td className="num">{x.referred}</td>
                      <td className="num">{x.won ? `${x.won} · ${inrShort(x.wonValue)}` : '—'}</td>
                      <td className="num">{pct(x.conversion)}</td>
                      <td className="num">{x.purchases ? inrShort(x.purchases) : '—'}</td>
                      <td className="num">{x.outstanding ? inrShort(x.outstanding) : '—'}</td>
                      <td className="num">{x.incentive ? inr(x.incentive) : '—'}</td>
                      <td>
                        {x.portal ? (
                          <button className="btn sm" onClick={() => act(() => post<{ token: string }>(`/api/v1/accounts/${x.id}/dealer-portal`, { on: true })).then((r) => r && setLink(`${window.location.origin}/dealer/${r.token}`))}>
                            Link
                          </button>
                        ) : (
                          <button className="btn sm ghost" onClick={() => act(() => post<{ token: string }>(`/api/v1/accounts/${x.id}/dealer-portal`, { on: true }), 'Portal opened').then((r) => r && setLink(`${window.location.origin}/dealer/${r.token}`))}>
                            Open portal
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <NoRows>No dealers yet. Set an account's type to dealer, distributor or partner; tag deals with "Referred by".</NoRows>
          )}
        </>
      )}
      {link && (
        <Modal title="Dealer portal link" onClose={() => setLink(null)}>
          <div className="modal-body stack">
            <p className="small">The dealer sees their orders, invoices, the deals they referred, scheme earnings and their price list, and can register new leads. Anyone with the link can open it.</p>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => navigator.clipboard?.writeText(link)}>
              Copy link
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Schemes() {
  const { data } = useQuery({ queryKey: ['schemes'], queryFn: () => get<{ items: Json[] }>('/api/v1/channel/schemes') });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['schemes'], ['channel']]);
  return (
    <>
      <Head title="Dealer schemes" sub="Pay dealers a percentage of the deals they bring (won) or what they buy, above a minimum, for a period and tier.">
        <button className="btn sm primary" onClick={() => setEdit({ name: '', startsOn: today(), endsOn: '', basis: 'won_deals', dealerTier: '', ratePct: 2, minValue: 0 })}>
          New scheme
        </button>
      </Head>
      {data?.items.length ? (
        data.items.map((s) => (
          <div key={s.id} className="panel" style={{ padding: 12, marginBottom: 10 }}>
            <div className="spread">
              <div>
                <b>{s.name}</b> <span className={`chip${s.status === 'active' ? ' good' : ''}`}>{s.status}</span>
                <div className="muted small">
                  {s.rate_pct}% of {s.basis === 'won_deals' ? 'won referred deals' : 'their purchases'}
                  {s.min_value ? ` above ${inr(s.min_value)}` : ''} · {s.dealer_tier ? `${label(s.dealer_tier)} dealers` : 'all dealers'} · {d(s.starts_on)} – {d(s.ends_on)}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <b>{inr(s.total)}</b>
                <button className="btn sm" onClick={() => setEdit({ id: s.id, name: s.name, startsOn: s.starts_on, endsOn: s.ends_on, basis: s.basis, dealerTier: s.dealer_tier ?? '', ratePct: s.rate_pct, minValue: s.min_value, status: s.status })}>
                  Edit
                </button>
                <button className="btn sm ghost" onClick={() => window.confirm('Delete this scheme?') && act(() => del(`/api/v1/channel/schemes/${s.id}`), 'Deleted')}>
                  Delete
                </button>
              </div>
            </div>
            {s.payouts.length > 0 && (
              <table className="data" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Dealer</th>
                    <th className="num">Base</th>
                    <th className="num">Payout</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {s.payouts.map((p: Json) => (
                    <tr key={p.dealerId}>
                      <td>{p.dealer}</td>
                      <td className="num">{inr(p.base)}</td>
                      <td className="num">{p.payout ? inr(p.payout) : '—'}</td>
                      <td className="small">{p.qualifies ? <span className="chip good">qualifies</span> : `needs ${inr(p.gap)} more`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      ) : (
        <NoRows>No schemes yet.</NoRows>
      )}
      {edit && (
        <Modal
          title={edit.id ? 'Edit scheme' : 'New scheme'}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              disabled={!edit.name || !edit.startsOn || !edit.endsOn}
              onClick={async () => {
                const body = { name: edit.name, startsOn: edit.startsOn, endsOn: edit.endsOn, basis: edit.basis, dealerTier: edit.dealerTier || null, ratePct: Number(edit.ratePct), minValue: Number(edit.minValue) || 0, status: edit.status };
                if (await act(() => (edit.id ? put(`/api/v1/channel/schemes/${edit.id}`, body) : post('/api/v1/channel/schemes', body)), 'Scheme saved')) setEdit(null);
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <label className="field">
              From
              <input type="date" value={edit.startsOn} onChange={(e) => setEdit({ ...edit, startsOn: e.target.value })} />
            </label>
            <label className="field">
              To
              <input type="date" value={edit.endsOn} onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} />
            </label>
            <label className="field">
              Pays on
              <select value={edit.basis} onChange={(e) => setEdit({ ...edit, basis: e.target.value })}>
                <option value="won_deals">Won deals they referred</option>
                <option value="invoices">Their purchases (invoiced)</option>
              </select>
            </label>
            <label className="field">
              For tier
              <select value={edit.dealerTier} onChange={(e) => setEdit({ ...edit, dealerTier: e.target.value })}>
                <option value="">All dealers</option>
                {['platinum', 'gold', 'silver', 'bronze'].map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Rate %
              <input type="number" min={0} max={100} step={0.1} value={edit.ratePct} onChange={(e) => setEdit({ ...edit, ratePct: e.target.value })} />
            </label>
            <label className="field">
              Minimum to qualify (₹)
              <input type="number" min={0} value={edit.minValue} onChange={(e) => setEdit({ ...edit, minValue: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

function Rebates() {
  const { data } = useQuery({ queryKey: ['rebates'], queryFn: () => get<Json>('/api/v1/rebates') });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['rebates']]);
  return (
    <>
      <Head title="Rebate agreements" sub="Volume agreements with a customer: slabs on value or quantity; the highest slab reached applies to the whole period's purchases (the customer's plants count too).">
        <button className="btn sm primary" onClick={() => setEdit({ accountId: '', name: '', startsOn: today(), endsOn: '', basis: 'value', productId: '', slabs: [{ from: '', pct: '' }], notes: '' })}>
          New agreement
        </button>
      </Head>
      {data && <Kpis items={[{ l: 'Rebate earned so far (active)', v: inr(data.accrued), sub: 'accrue this as a liability' }]} />}
      {data?.items.length ? (
        <table className="data" data-export-title="Rebates">
          <thead>
            <tr>
              <th>Customer / agreement</th>
              <th>Period</th>
              <th className="num">Achieved</th>
              <th className="num">Rate</th>
              <th className="num">Earned</th>
              <th>Next slab</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((r: Json) => (
              <tr key={r.id}>
                <td>
                  <b>{r.account}</b>
                  <div className="muted small">
                    {r.name}
                    {r.product ? ` · ${r.product}` : ''} <span className="chip">{r.status}</span>
                  </div>
                </td>
                <td className="small">
                  {d(r.starts_on)} – {d(r.ends_on)}
                  {r.status === 'active' ? <div className="muted">{r.daysLeft} days left</div> : null}
                </td>
                <td className="num">{r.basis === 'value' ? inr(r.achieved) : r.achieved}</td>
                <td className="num">{r.ratePct}%</td>
                <td className="num">{inr(r.earned)}</td>
                <td className="small">{r.next ? `${r.basis === 'value' ? inr(r.next.gap) : r.next.gap} more → ${r.next.pct}% (${inr(r.next.earnedThen)}+)` : 'Top slab reached'}</td>
                <td className="row" style={{ gap: 4 }}>
                  <button className="btn sm" onClick={() => setEdit({ id: r.id, accountId: r.account_id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, basis: r.basis, productId: r.product_id ?? '', slabs: r.slabs, status: r.status, notes: r.notes ?? '' })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No rebate agreements.</NoRows>
      )}
      {edit && (
        <Modal
          title={edit.id ? 'Edit rebate agreement' : 'New rebate agreement'}
          wide
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this agreement?') && (await act(() => del(`/api/v1/rebates/${edit.id}`), 'Deleted')) && setEdit(null)}>
                  Delete
                </button>
              )}
              <button
                className="btn primary"
                disabled={!edit.accountId || !edit.name || !edit.endsOn}
                onClick={async () => {
                  const body = { accountId: edit.accountId, name: edit.name, startsOn: edit.startsOn, endsOn: edit.endsOn, basis: edit.basis, productId: edit.productId || null, slabs: edit.slabs.filter((s: Json) => s.from !== '' && s.pct !== '').map((s: Json) => ({ from: Number(s.from), pct: Number(s.pct) })), status: edit.status, notes: edit.notes || null };
                  if (await act(() => (edit.id ? put(`/api/v1/rebates/${edit.id}`, body) : post('/api/v1/rebates', body)), 'Agreement saved')) setEdit(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="modal-body grid2">
            <div className="field">
              Customer
              <LookupPicker id="rb-acc" objectKey="account" value={edit.accountId} onChange={(v) => setEdit({ ...edit, accountId: String(v ?? '') })} />
            </div>
            <label className="field">
              Agreement
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="FY 26-27 volume rebate" />
            </label>
            <label className="field">
              From
              <input type="date" value={edit.startsOn} onChange={(e) => setEdit({ ...edit, startsOn: e.target.value })} />
            </label>
            <label className="field">
              To
              <input type="date" value={edit.endsOn} onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} />
            </label>
            <label className="field">
              Slabs on
              <select value={edit.basis} onChange={(e) => setEdit({ ...edit, basis: e.target.value })}>
                <option value="value">Purchase value (₹, before GST)</option>
                <option value="quantity">Quantity</option>
              </select>
            </label>
            <div className="field">
              Only this product (optional)
              <LookupPicker id="rb-prod" objectKey="product" value={edit.productId} onChange={(v) => setEdit({ ...edit, productId: String(v ?? '') })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="small" style={{ marginBottom: 4 }}>
                Slabs
              </div>
              {edit.slabs.map((s: Json, i: number) => (
                <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
                  <input type="number" placeholder={edit.basis === 'value' ? 'From ₹' : 'From qty'} value={s.from} onChange={(e) => setEdit({ ...edit, slabs: edit.slabs.map((x: Json, j: number) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                  <input type="number" placeholder="Rebate %" value={s.pct} onChange={(e) => setEdit({ ...edit, slabs: edit.slabs.map((x: Json, j: number) => (j === i ? { ...x, pct: e.target.value } : x)) })} />
                  <button className="btn sm ghost" onClick={() => setEdit({ ...edit, slabs: edit.slabs.filter((_: Json, j: number) => j !== i) })} aria-label="Remove slab">
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn sm" onClick={() => setEdit({ ...edit, slabs: [...edit.slabs, { from: '', pct: '' }] })}>
                Add slab
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────── analytics ───────────── */

function ByProduct() {
  const p = usePeriod();
  const { data } = useQuery({ queryKey: ['an-products', p.qs], queryFn: () => get<Json>(`/api/v1/analytics/products?${p.qs}`) });
  return (
    <>
      <Head title="Sales by product" sub="Invoiced value before GST, net of credit notes.">
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : data.rows.length ? (
        <>
          <Kpis items={[{ l: 'Total', v: inrShort(data.total) }, { l: 'Products sold', v: data.rows.length }, { l: 'Top product share', v: pct(data.rows[0]?.share) }]} />
          <div className="two-col" style={{ marginBottom: 14 }}>
            <div className="panel" style={{ padding: 12 }}>
              <Chart id="an-products" initial="hbar" fmt={inrShort} data={{ categories: data.rows.slice(0, 12).map((r: Json) => r.product), series: [{ label: 'Sales', values: data.rows.slice(0, 12).map((r: Json) => r.value) }] }} />
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <Chart id="an-families" initial="donut" fmt={inrShort} data={{ categories: data.byFamily.slice(0, 8).map((r: Json) => r.family), series: [{ label: 'Sales', values: data.byFamily.slice(0, 8).map((r: Json) => r.value) }] }} />
            </div>
          </div>
          <table className="data" data-export-title="Sales by product">
            <thead>
              <tr>
                <th>Product</th>
                <th>Family</th>
                <th className="num">Quantity</th>
                <th className="num">Sales</th>
                <th className="num">Share</th>
                <th className="num">Customers</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: Json) => (
                <tr key={r.product}>
                  <td>{r.product}</td>
                  <td>{r.family ?? '—'}</td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{inr(r.value)}</td>
                  <td className="num">{pct(r.share)}</td>
                  <td className="num">{r.customers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <NoRows>No sales in this period.</NoRows>
      )}
    </>
  );
}

function ByRegion() {
  const p = usePeriod();
  const [by, setBy] = useState<'state' | 'city' | 'territory'>('state');
  const { data } = useQuery({ queryKey: ['an-regions', p.qs, by], queryFn: () => get<Json>(`/api/v1/analytics/regions?${p.qs}&by=${by}`) });
  return (
    <>
      <Head title="Sales by region" sub="By the place of supply (state), the customer's city, or the territory you assign.">
        <select value={by} onChange={(e) => setBy(e.target.value as 'state')} style={{ width: 'auto' }} aria-label="Group by">
          <option value="state">State</option>
          <option value="city">City</option>
          <option value="territory">Territory</option>
        </select>
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : data.rows.length ? (
        <>
          <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
            <Chart id="an-regions" initial="bar" fmt={inrShort} data={{ categories: data.rows.slice(0, 15).map((r: Json) => r.region), series: [{ label: 'Sales', values: data.rows.slice(0, 15).map((r: Json) => r.value) }] }} />
          </div>
          <table className="data" data-export-title="Sales by region">
            <thead>
              <tr>
                <th>{label(by)}</th>
                <th className="num">Sales</th>
                <th className="num">Share</th>
                <th className="num">Customers</th>
                <th className="num">Invoices</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: Json) => (
                <tr key={r.region}>
                  <td>{r.region}</td>
                  <td className="num">{inr(r.value)}</td>
                  <td className="num">{pct(r.share)}</td>
                  <td className="num">{r.customers}</td>
                  <td className="num">{r.invoices}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <NoRows>No sales in this period.</NoRows>
      )}
    </>
  );
}

function Fulfilment() {
  const p = usePeriod();
  const { data } = useQuery({ queryKey: ['an-fulfil', p.qs], queryFn: () => get<Json>(`/api/v1/analytics/fulfilment?${p.qs}`) });
  return (
    <>
      <Head title="Order fulfilment" sub="On time = delivered by the promised date; in full = every line delivered; OTIF = both.">
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Kpis
            items={[
              { l: 'Orders', v: data.orders, sub: `${data.measured} with a promised date` },
              { l: 'On time', v: pct(data.onTimePct), tone: (data.onTimePct ?? 100) < 85 ? 'warn' : 'good' },
              { l: 'In full', v: pct(data.inFullPct) },
              { l: 'OTIF', v: pct(data.otifPct) },
              { l: 'Fill rate', v: pct(data.fillRatePct), sub: 'quantity delivered of ordered' },
              { l: 'Order to delivery', v: data.avgLeadDays != null ? `${data.avgLeadDays} days` : '—' },
            ]}
          />
          {data.lateOpen.length > 0 ? (
            <>
              <h3 className="small">Late and still open</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Promised</th>
                    <th className="num">Days late</th>
                    <th className="num">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lateOpen.map((o: Json) => (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/o/sales_order/${o.id}`}>{o.number}</Link>
                      </td>
                      <td>{o.account}</td>
                      <td>{d(o.expected)}</td>
                      <td className="num bad-text">{o.daysLate}</td>
                      <td className="num">{o.fillPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <NoRows>Nothing late. 🎯</NoRows>
          )}
        </>
      )}
    </>
  );
}

function Repeat() {
  const p = usePeriod({ from: new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10) });
  const { data } = useQuery({ queryKey: ['an-repeat', p.qs], queryFn: () => get<Json>(`/api/v1/analytics/repeat?${p.qs}`) });
  return (
    <>
      <Head title="Repeat orders" sub="How many customers come back, how often, and who usually would have ordered again by now.">
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Kpis
            items={[
              { l: 'Customers billed', v: data.customers },
              { l: 'Repeat customers', v: data.repeatCustomers, sub: pct(data.repeatRatePct) },
              { l: 'Revenue from repeat', v: pct(data.repeatValueSharePct) },
              { l: 'Usual gap', v: data.avgGapDays != null ? `${data.avgGapDays} days` : '—' },
            ]}
          />
          <div className="two-col" style={{ marginBottom: 14 }}>
            <div className="panel" style={{ padding: 12 }}>
              <Chart id="an-repeat-dist" initial="bar" fmt={(n) => String(n)} data={{ categories: data.distribution.map((b: Json) => `${b.label} invoices`), series: [{ label: 'Customers', values: data.distribution.map((b: Json) => b.n) }] }} />
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <h3 className="small" style={{ marginTop: 0 }}>
                Going quiet
              </h3>
              {data.goingQuiet.length ? (
                <table className="data">
                  <tbody>
                    {data.goingQuiet.map((g: Json) => (
                      <tr key={g.accountId}>
                        <td>
                          <Link to={`/o/account/${g.accountId}`}>{g.name}</Link>
                          <div className="muted small">
                            usually every {g.usualGapDays} days · last {d(g.last)}
                          </div>
                        </td>
                        <td className="num bad-text">{g.daysSince} days</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <NoRows>Every regular customer has ordered on time.</NoRows>
              )}
            </div>
          </div>
          <table className="data" data-export-title="Top repeat customers">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Invoices</th>
                <th className="num">Value</th>
                <th className="num">Usual gap</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {data.top.map((t: Json) => (
                <tr key={t.accountId}>
                  <td>
                    <Link to={`/o/account/${t.accountId}`}>{t.name}</Link>
                  </td>
                  <td className="num">{t.orders}</td>
                  <td className="num">{inr(t.value)}</td>
                  <td className="num">{t.avgGapDays != null ? `${t.avgGapDays} d` : '—'}</td>
                  <td>{d(t.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function Seasonal() {
  const [years, setYears] = useState(3);
  const { data } = useQuery({ queryKey: ['an-season', years], queryFn: () => get<Json>(`/api/v1/analytics/seasonality?years=${years}`) });
  return (
    <>
      <Head title="Seasonality" sub="Month by month for each financial year; the index shows a month against an average month (100).">
        <select value={years} onChange={(e) => setYears(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Years">
          {[2, 3, 4, 5].map((y) => (
            <option key={y} value={y}>
              Last {y} years
            </option>
          ))}
        </select>
      </Head>
      {!data ? (
        <Spinner />
      ) : data.series.length ? (
        <>
          <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
            <Chart id="an-season" initial="line" fmt={inrShort} data={{ categories: data.months, series: data.series.map((s: Json) => ({ label: s.fy, values: s.values })) }} />
          </div>
          <table className="data">
            <thead>
              <tr>
                <th />
                {data.months.map((m: string) => (
                  <th key={m} className="num">
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.series.map((s: Json) => (
                <tr key={s.fy}>
                  <td>{s.fy}</td>
                  {s.values.map((v: number, i: number) => (
                    <td key={i} className="num">
                      {v ? inrShort(v) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>
                  <b>Index</b>
                </td>
                {data.index.map((v: number, i: number) => (
                  <td key={i} className={`num${v >= 120 ? ' good-text' : v && v <= 80 ? ' bad-text' : ''}`}>
                    {v || '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </>
      ) : (
        <NoRows>Not enough invoices yet.</NoRows>
      )}
    </>
  );
}

function Forecast() {
  const { data } = useQuery({ queryKey: ['an-forecast'], queryFn: () => get<Json>('/api/v1/analytics/forecast?months=12') });
  return (
    <>
      <Head title="Forecast vs actual" sub="Each month: the weighted pipeline expected to close then, against what was won and what was billed. The last two months are still forecast." />
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Kpis items={[{ l: 'Forecast accuracy (past months)', v: pct(data.accuracyPct), sub: 'how close won came to the weighted forecast' }]} />
          <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
            <Chart
              id="an-fva"
              initial="bar"
              fmt={inrShort}
              data={{
                categories: data.rows.map((r: Json) => new Date(`${r.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })),
                series: [
                  { label: 'Forecast (weighted)', values: data.rows.map((r: Json) => r.forecast) },
                  { label: 'Won', values: data.rows.map((r: Json) => r.won) },
                  { label: 'Billed', values: data.rows.map((r: Json) => r.billed) },
                ],
              }}
            />
          </div>
          <table className="data" data-export-title="Forecast vs actual">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Forecast</th>
                <th className="num">Best case</th>
                <th className="num">Won</th>
                <th className="num">Billed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: Json) => (
                <tr key={r.month} className={r.future ? 'muted-row' : undefined}>
                  <td>{r.month}</td>
                  <td className="num">{inr(r.forecast)}</td>
                  <td className="num">{inr(r.bestCase)}</td>
                  <td className="num">{r.future ? '—' : inr(r.won)}</td>
                  <td className="num">{r.future ? '—' : inr(r.billed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

export function ProfitTable({ rows }: { rows: Json[] }) {
  return (
    <div className="table-wrap">
      <table className="data" data-export-title="Customer profitability">
        <thead>
          <tr>
            <th>Customer</th>
            <th className="num">Revenue</th>
            <th className="num">Goods</th>
            <th className="num">Labour</th>
            <th className="num">Purchases</th>
            <th className="num">Expenses</th>
            <th className="num">Free spares</th>
            <th className="num">Margin</th>
            <th className="num">Margin %</th>
            <th className="num">Owes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId}>
              <td>
                <Link to={`/o/account/${r.accountId}`}>{r.name}</Link>
              </td>
              <td className="num">{inr(r.revenue)}</td>
              <td className="num">{r.goods ? inr(r.goods) : '—'}</td>
              <td className="num">{r.labour ? inr(r.labour) : '—'}</td>
              <td className="num">{r.purchases ? inr(r.purchases) : '—'}</td>
              <td className="num">{r.expenses ? inr(r.expenses) : '—'}</td>
              <td className="num">{r.service ? inr(r.service) : '—'}</td>
              <td className={`num ${r.margin < 0 ? 'bad-text' : 'good-text'}`}>{inr(r.margin)}</td>
              <td className="num">{pct(r.marginPct)}</td>
              <td className="num">{r.outstanding ? inr(r.outstanding) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Profitability() {
  const p = usePeriod();
  const { data, error } = useQuery({ queryKey: ['an-profit', p.qs], queryFn: () => get<Json>(`/api/v1/insights/profitability?${p.qs}`), retry: false });
  return (
    <>
      <Head title="Customer profitability" sub="Revenue less the goods sold (at cost), project labour (time at cost rate), direct purchases and expenses for the customer, and spare parts given free.">
        {p.picker}
      </Head>
      {error ? (
        <NoRows>{(error as Error).message}</NoRows>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          <Kpis
            items={[
              { l: 'Revenue', v: inrShort(data.totals.revenue) },
              { l: 'Cost to serve', v: inrShort(data.totals.cost) },
              { l: 'Margin', v: inrShort(data.totals.margin), sub: pct(data.totals.marginPct), tone: data.totals.margin < 0 ? 'bad' : 'good' },
              { l: 'Loss-making customers', v: data.totals.lossMaking, tone: data.totals.lossMaking ? 'bad' : undefined },
            ]}
          />
          {data.rows.length > 1 && (
            <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
              <Chart id="an-profit" initial="hbar" fmt={inrShort} data={{ categories: data.rows.slice(0, 12).map((r: Json) => r.name), series: [{ label: 'Margin', values: data.rows.slice(0, 12).map((r: Json) => r.margin) }] }} />
            </div>
          )}
          {data.rows.length ? <ProfitTable rows={data.rows} /> : <NoRows>No billing in this period.</NoRows>}
        </>
      )}
    </>
  );
}

function WinLoss() {
  const p = usePeriod();
  const { data } = useQuery({ queryKey: ['an-winloss', p.qs], queryFn: () => get<Json>(`/api/v1/insights/win-loss?${p.qs}`) });
  const G = ({ title, rows }: { title: string; rows: Json[] }) => (
    <div className="panel" style={{ padding: 12 }}>
      <h3 className="small" style={{ marginTop: 0 }}>
        {title}
      </h3>
      {rows.length ? (
        <table className="data">
          <thead>
            <tr>
              <th />
              <th className="num">Won</th>
              <th className="num">Lost</th>
              <th className="num">Win rate</th>
              <th className="num">Lost value</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.key}>
                <td>{label(r.key)}</td>
                <td className="num">{r.won}</td>
                <td className="num">{r.lost}</td>
                <td className="num">{pct(r.winRate)}</td>
                <td className="num">{r.lostValue ? inrShort(r.lostValue) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>Nothing yet.</NoRows>
      )}
    </div>
  );
  return (
    <>
      <Head title="Win / loss" sub="Closed deals in the period: why we lose, to whom, and who and which sources win.">
        {p.picker}
      </Head>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Kpis
            items={[
              { l: 'Win rate', v: pct(data.winRate), sub: `${data.won} won · ${data.lost} lost` },
              { l: 'Win rate by value', v: pct(data.winRateByValue) },
              { l: 'Won', v: inrShort(data.wonValue), sub: data.avgWon ? `avg ${inrShort(data.avgWon)}` : undefined, tone: 'good' },
              { l: 'Lost', v: inrShort(data.lostValue), sub: data.avgLost ? `avg ${inrShort(data.avgLost)}` : undefined, tone: data.lostValue ? 'bad' : undefined },
              { l: 'Days to win', v: data.cycleWon ?? '—', sub: data.cycleLost != null ? `${data.cycleLost} days to lose` : undefined },
            ]}
          />
          {data.byReason.length > 0 && (
            <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
              <Chart id="winloss-reason" initial="donut" fmt={(n) => String(n)} data={{ categories: data.byReason.map((r: Json) => label(r.key)), series: [{ label: 'Deals lost', values: data.byReason.map((r: Json) => r.lost) }] }} />
            </div>
          )}
          <div className="two-col" style={{ marginBottom: 14 }}>
            <G title="Lost to (competitors)" rows={data.byCompetitor} />
            <G title="By owner" rows={data.byOwner} />
            <G title="By source" rows={data.bySource} />
            <G title="Why we lose" rows={data.byReason} />
          </div>
          {data.recentLost.length > 0 && (
            <table className="data" data-export-title="Lost deals">
              <thead>
                <tr>
                  <th>Lost deal</th>
                  <th>Customer</th>
                  <th className="num">Value</th>
                  <th>Reason</th>
                  <th>Lost to</th>
                </tr>
              </thead>
              <tbody>
                {data.recentLost.map((r: Json) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/o/deal/${r.id}`}>{r.name}</Link>
                    </td>
                    <td>{r.account ?? '—'}</td>
                    <td className="num">{inr(r.amount)}</td>
                    <td>{label(r.reason ?? 'not given')}</td>
                    <td>{r.lostTo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

/* ───────────── sequences ───────────── */

function Sequences() {
  const { data } = useQuery({ queryKey: ['sequences'], queryFn: () => get<{ items: Json[] }>('/api/v1/sequences') });
  const enr = useQuery({ queryKey: ['sequence-enrollments'], queryFn: () => get<{ items: Json[] }>('/api/v1/sequence-enrollments') });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['sequences'], ['sequence-enrollments']]);
  return (
    <>
      <Head title="Email sequences" sub="A few personal follow-ups on a schedule, sent from your own mailbox. A reply stops it. Enrol people from a lead or contact page, or below.">
        <button className="btn sm" onClick={() => act(() => post<Json>('/api/v1/sequences-run'), 'Due emails sent')}>
          Send due emails now
        </button>
        <button className="btn sm primary" onClick={() => setEdit({ name: '', steps: [{ day: 0, subject: '', body: '' }], stopOnReply: true, status: 'active' })}>
          New sequence
        </button>
      </Head>
      {data?.items.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Sequence</th>
              <th className="num">Emails</th>
              <th className="num">Active</th>
              <th className="num">Replied</th>
              <th className="num">Finished</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b> {s.status === 'paused' && <span className="chip">paused</span>}
                  <div className="muted small">Days {(s.steps as Json[]).map((x) => x.day).join(', ')}</div>
                </td>
                <td className="num">{s.steps.length}</td>
                <td className="num">{s.active}</td>
                <td className="num">
                  {s.replied}
                  {s.enrolled ? <span className="muted small"> ({Math.round((s.replied / s.enrolled) * 100)}%)</span> : null}
                </td>
                <td className="num">{s.completed}</td>
                <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                  <EnrolButton sequenceId={s.id} />
                  <button className="btn sm" onClick={() => setEdit({ id: s.id, name: s.name, steps: s.steps, stopOnReply: s.stop_on_reply, status: s.status })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No sequences yet.</NoRows>
      )}
      {(enr.data?.items.length ?? 0) > 0 && (
        <>
          <h3 className="small" style={{ marginTop: 18 }}>
            People on sequences
          </h3>
          <table className="data">
            <thead>
              <tr>
                <th>Person</th>
                <th>Sequence</th>
                <th>Step</th>
                <th>Next</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {enr.data!.items.slice(0, 100).map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/o/${e.object}/${e.record_id}`}>{e.name ?? e.email}</Link>
                    <div className="muted small">{e.email}</div>
                  </td>
                  <td>{e.sequence}</td>
                  <td>
                    {Math.min(e.step, e.steps)} / {e.steps}
                  </td>
                  <td>{e.next_at ? d(e.next_at) : '—'}</td>
                  <td>
                    <span className={`chip${e.status === 'replied' ? ' good' : e.status === 'failed' ? ' bad' : ''}`} title={e.last_error ?? undefined}>
                      {e.status}
                    </span>
                  </td>
                  <td>
                    {e.status === 'active' && (
                      <button className="btn sm ghost" onClick={() => act(() => post(`/api/v1/sequence-enrollments/${e.id}/stop`), 'Stopped')}>
                        Stop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {edit && (
        <Modal
          title={edit.id ? 'Edit sequence' : 'New sequence'}
          wide
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this sequence? People on it stop getting emails.') && (await act(() => del(`/api/v1/sequences/${edit.id}`), 'Deleted')) && setEdit(null)}>
                  Delete
                </button>
              )}
              <button
                className="btn primary"
                disabled={!edit.name || edit.steps.some((s: Json) => !s.subject || !s.body)}
                onClick={async () => {
                  const body = { name: edit.name, steps: edit.steps.map((s: Json) => ({ day: Number(s.day) || 0, subject: s.subject, body: s.body })), stopOnReply: edit.stopOnReply, status: edit.status };
                  if (await act(() => (edit.id ? put(`/api/v1/sequences/${edit.id}`, body) : post('/api/v1/sequences', body)), 'Sequence saved')) setEdit(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="grid2">
              <label className="field">
                Name
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
              <label className="field">
                Status
                <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={edit.stopOnReply} onChange={(e) => setEdit({ ...edit, stopOnReply: e.target.checked })} /> Stop when they reply
            </label>
            <p className="muted small" style={{ margin: 0 }}>
              Use {'{{first_name}}'}, {'{{name}}'}, {'{{company}}'} and {'{{sender}}'} in the subject and text.
            </p>
            {edit.steps.map((s: Json, i: number) => (
              <div key={i} className="panel" style={{ padding: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                  <label className="field" style={{ width: 110, margin: 0 }}>
                    Day
                    <input type="number" min={0} value={s.day} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x: Json, j: number) => (j === i ? { ...x, day: e.target.value } : x)) })} />
                  </label>
                  <label className="field grow" style={{ margin: 0 }}>
                    Subject
                    <input value={s.subject} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x: Json, j: number) => (j === i ? { ...x, subject: e.target.value } : x)) })} />
                  </label>
                  <button className="btn sm ghost" disabled={edit.steps.length === 1} onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_: Json, j: number) => j !== i) })} aria-label="Remove email">
                    ✕
                  </button>
                </div>
                <textarea rows={5} style={{ marginTop: 6 }} value={s.body} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x: Json, j: number) => (j === i ? { ...x, body: e.target.value } : x)) })} />
              </div>
            ))}
            <button className="btn sm" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { day: (Number(edit.steps[edit.steps.length - 1]?.day) || 0) + 3, subject: '', body: '' }] })}>
              Add an email
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function EnrolButton({ sequenceId, object, recordId }: { sequenceId?: string; object?: 'lead' | 'contact'; recordId?: string }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ seq: sequenceId ?? '', object: object ?? 'lead', id: recordId ?? '' });
  const seqs = useQuery({ queryKey: ['sequences'], queryFn: () => get<{ items: Json[] }>('/api/v1/sequences'), enabled: open && !sequenceId });
  const act = useAct([['sequences'], ['sequence-enrollments']]);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        {recordId ? 'Add to sequence' : 'Enrol'}
      </button>
      {open && (
        <Modal
          title="Add to a sequence"
          onClose={() => setOpen(false)}
          footer={
            <button
              className="btn primary"
              disabled={!f.seq || !f.id}
              onClick={async () => {
                const r = await act(() => post<{ added: number; skipped: Json[] }>(`/api/v1/sequences/${f.seq}/enroll`, { object: f.object, ids: [f.id] }));
                if (r) {
                  if (!r.added) window.alert(`Not added: ${r.skipped.map((s) => s.reason).join(', ')}`);
                  setOpen(false);
                }
              }}
            >
              Add
            </button>
          }
        >
          <div className="modal-body stack">
            {!sequenceId && (
              <label className="field">
                Sequence
                <select value={f.seq} onChange={(e) => setF({ ...f, seq: e.target.value })}>
                  <option value="">Choose…</option>
                  {seqs.data?.items
                    .filter((s) => s.status === 'active')
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {!recordId && (
              <>
                <label className="field">
                  Who
                  <select value={f.object} onChange={(e) => setF({ ...f, object: e.target.value as 'lead', id: '' })}>
                    <option value="lead">A lead</option>
                    <option value="contact">A contact</option>
                  </select>
                </label>
                <div className="field">
                  {f.object === 'lead' ? 'Lead' : 'Contact'}
                  <LookupPicker key={f.object} id="enrol-who" objectKey={f.object} value={f.id} onChange={(v) => setF({ ...f, id: String(v ?? '') })} />
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────── help centre ───────────── */

function HelpCentre() {
  const { data } = useQuery({ queryKey: ['help-centre'], queryFn: () => get<Json>('/api/v1/help-centre') });
  const act = useAct([['help-centre']]);
  if (!data) return <Spinner />;
  const url = data.token ? `${window.location.origin}/help/${data.token}` : null;
  return (
    <>
      <Head title="Public help centre" sub="Customers read and search the articles you publish, without signing in. Write and upload articles in Knowledge.">
        <Link className="btn sm" to="/knowledge">
          Open Knowledge
        </Link>
        <button className={`btn sm${data.token ? '' : ' primary'}`} onClick={() => act(() => put('/api/v1/help-centre', { on: !data.token }), data.token ? 'Help centre closed' : 'Help centre is live')}>
          {data.token ? 'Take offline' : 'Publish the help centre'}
        </button>
      </Head>
      {url && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Live at{' '}
          <a href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        </div>
      )}
      <label className="field" style={{ maxWidth: 360 }}>
        Title
        <input defaultValue={data.title} onBlur={(e) => e.target.value !== data.title && act(() => put('/api/v1/help-centre', { title: e.target.value }), 'Saved')} />
      </label>
      {data.docs.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Article</th>
              <th>Category</th>
              <th>Public</th>
            </tr>
          </thead>
          <tbody>
            {data.docs.map((x: Json) => (
              <tr key={x.id}>
                <td>{x.title}</td>
                <td>
                  <input defaultValue={x.category ?? ''} placeholder="General" onBlur={(e) => (e.target.value || null) !== x.category && act(() => put(`/api/v1/help-centre/articles/${x.id}`, { category: e.target.value || null }))} />
                </td>
                <td>
                  <label className="switch">
                    <input type="checkbox" checked={x.is_public} onChange={(e) => act(() => put(`/api/v1/help-centre/articles/${x.id}`, { isPublic: e.target.checked }), e.target.checked ? 'Published' : 'Unpublished')} />
                    <span />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No articles yet. Add documents in Knowledge, then publish them here.</NoRows>
      )}
    </>
  );
}
