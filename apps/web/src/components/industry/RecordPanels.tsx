/** Industry panels on record pages: account (group, credit, profitability, client IT, dealer), quote, order, ticket, deal. */
import type { RecordDto } from '@synapse/shared';
import { hasAdmin } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CapaModal } from '../../pages/AfterSales';
import { ProfitTable } from '../../pages/SalesOps';
import { del, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { LookupPicker } from '../fields';
import { SideTabs } from '../SideTabs';
import { Modal, useToast } from '../ui';
import { ClientAssets, ClientVault, TechDocs } from './ClientIt';
import { d, fyStart, inr, inrShort, type Json, Kpis, label, NoRows, pct, today, useAct } from './kit';

/* ───────────── account ───────────── */

type AccSec = 'group' | 'credit' | 'profit' | 'assets' | 'vault' | 'docs' | 'dealer';

export function AccountPanels({ id, rec, apps }: { id: string; rec: RecordDto; apps: Set<string> }) {
  const { me } = useAuth();
  const dealer = ['dealer', 'distributor', 'partner'].includes(String(rec.account_type ?? ''));
  const it = apps.has('projects');
  const items: { key: AccSec; label: string; icon: string; group?: string }[] = [
    { key: 'group', label: 'Group companies', icon: 'org', group: 'Customer' },
    { key: 'credit', label: 'Credit', icon: 'card', group: 'Customer' },
    { key: 'profit', label: 'Profitability', icon: 'gauge', group: 'Customer' },
    ...(it
      ? ([
          { key: 'assets', label: 'IT assets', icon: 'box', group: 'Client IT' },
          { key: 'vault', label: 'Credentials', icon: 'wallet', group: 'Client IT' },
          { key: 'docs', label: 'Tech docs', icon: 'book', group: 'Client IT' },
        ] as const)
      : []),
    ...(dealer ? ([{ key: 'dealer', label: 'Dealer', icon: 'users', group: 'Channel' }] as const) : []),
  ];
  const [sec, setSec] = useState<AccSec>('group');
  return (
    <div style={{ marginBottom: 16 }}>
      <SideTabs id="acc-industry" title="Customer" items={items} value={sec} onChange={setSec} defaultOpen={false}>
        <div style={{ padding: 14 }}>
          {sec === 'group' && <Family id={id} />}
          {sec === 'credit' && <CreditCard id={id} />}
          {sec === 'profit' && <AccountProfit id={id} canSee={!!me && ['books', 'billing', 'projects', 'manufacturing', 'operations', 'margins'].some((a) => hasAdmin(me.permissions, a))} />}
          {sec === 'assets' && <ClientAssets accountId={id} />}
          {sec === 'vault' && <ClientVault accountId={id} />}
          {sec === 'docs' && <TechDocs accountId={id} />}
          {sec === 'dealer' && <DealerCard id={id} rec={rec} />}
        </div>
      </SideTabs>
    </div>
  );
}

function Family({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['family', id], queryFn: () => get<Json>(`/api/v1/accounts/${id}/family`) });
  if (!data) return null;
  if (data.nodes.length <= 1) return <NoRows>No parent company or branches. Set "Parent company" on a plant, branch or subsidiary to group them here.</NoRows>;
  const top = data.nodes[0];
  return (
    <>
      <Kpis
        items={[
          { l: 'Group pipeline', v: inrShort(top.group.openPipeline) },
          { l: 'Group won (this FY)', v: inrShort(top.group.wonFy) },
          { l: 'Group billed (this FY)', v: inrShort(top.group.billedFy) },
          { l: 'Group owes', v: inrShort(top.group.outstanding), tone: top.group.outstanding ? 'warn' : undefined },
        ]}
      />
      <table className="data">
        <thead>
          <tr>
            <th>Company</th>
            <th className="num">Pipeline</th>
            <th className="num">Won FY</th>
            <th className="num">Billed FY</th>
            <th className="num">Owes</th>
            <th className="num">Contacts</th>
          </tr>
        </thead>
        <tbody>
          {data.nodes.map((n: Json) => (
            <tr key={n.id} className={n.id === id ? 'row-highlight' : undefined}>
              <td style={{ paddingLeft: 8 + n.depth * 18 }}>
                {n.depth > 0 && <span className="muted">└ </span>}
                {n.id === id ? <b>{n.name}</b> : <Link to={`/o/account/${n.id}`}>{n.name}</Link>}
                {n.city && <span className="muted small"> · {n.city}</span>}
              </td>
              <td className="num">{inrShort(n.openPipeline)}</td>
              <td className="num">{inrShort(n.wonFy)}</td>
              <td className="num">{inrShort(n.billedFy)}</td>
              <td className="num">{n.outstanding ? inrShort(n.outstanding) : '—'}</td>
              <td className="num">{n.contacts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function CreditCard({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['credit', id], queryFn: () => get<Json>(`/api/v1/accounts/${id}/credit`) });
  if (!data) return null;
  const used = data.limit ? Math.min(100, (data.exposure / data.limit) * 100) : 0;
  return (
    <>
      {data.limitAccountName && <p className="small">The group limit of {data.limitAccountName} applies (shared by its companies).</p>}
      <Kpis
        items={[
          { l: 'Credit limit', v: data.limit != null ? inr(data.limit) : 'None', sub: data.hold ? 'ON HOLD' : undefined, tone: data.hold ? 'bad' : undefined },
          { l: 'Owed', v: inr(data.receivables), sub: data.overdue ? `${inr(data.overdue)} overdue` : undefined, tone: data.overdue ? 'warn' : undefined },
          { l: 'Open orders', v: inr(data.openOrders), sub: 'not yet invoiced' },
          { l: 'Available', v: data.available != null ? inr(data.available) : '—', tone: data.available != null && data.available < 0 ? 'bad' : 'good' },
        ]}
      />
      {data.limit != null && (
        <div className="progress" style={{ height: 10 }} title={`${used.toFixed(0)}% used`}>
          <span style={{ width: `${used}%`, background: used >= 100 ? 'var(--bad)' : used > 80 ? 'var(--warn)' : undefined }} />
        </div>
      )}
      <p className="muted small">Set "Credit limit" or "Credit hold" in the details. Orders past the limit need approval before they can be confirmed.</p>
    </>
  );
}

function AccountProfit({ id, canSee }: { id: string; canSee: boolean }) {
  const [from, setFrom] = useState(fyStart());
  const { data } = useQuery({ queryKey: ['acc-profit', id, from], queryFn: () => get<Json>(`/api/v1/accounts/${id}/profitability?from=${from}&to=${today()}`), enabled: canSee });
  if (!canSee) return <NoRows>Margins are visible to finance (the "See costs & margins" permission).</NoRows>;
  if (!data) return null;
  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <span className="small muted">Since</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
        <span className="small muted">· includes its plants and branches</span>
      </div>
      <Kpis
        items={[
          { l: 'Revenue', v: inrShort(data.totals.revenue) },
          { l: 'Cost to serve', v: inrShort(data.totals.cost) },
          { l: 'Margin', v: inrShort(data.totals.margin), sub: pct(data.totals.marginPct), tone: data.totals.margin < 0 ? 'bad' : 'good' },
        ]}
      />
      {data.rows.length ? <ProfitTable rows={data.rows} /> : <NoRows>No billing in this period.</NoRows>}
    </>
  );
}

function DealerCard({ id, rec }: { id: string; rec: RecordDto }) {
  const act = useAct([['record', 'account', id]]);
  const tok = useQuery({ queryKey: ['dealer-portal', id], queryFn: () => get<{ token: string | null }>(`/api/v1/accounts/${id}/dealer-portal`) });
  const [linkState, setLink] = useState<string | null | undefined>(undefined);
  const link = linkState !== undefined ? linkState : tok.data?.token ? `${window.location.origin}/dealer/${tok.data.token}` : null;
  return (
    <div className="stack">
      <p className="small">
        Tier: <b>{rec.dealer_tier ? label(rec.dealer_tier) : 'not set'}</b> · Territory: <b>{String(rec.territory ?? 'not set')}</b> · Performance and schemes are under <Link to="/sales-ops?s_salesops=dealers">Sales operations → Dealers</Link>.
      </p>
      {link ? (
        <div className="row" style={{ gap: 6 }}>
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(link)}>
            Copy
          </button>
          <button className="btn sm danger" onClick={async () => (await act(() => post(`/api/v1/accounts/${id}/dealer-portal`, { on: false }), 'Portal closed')) && setLink(null)}>
            Close portal
          </button>
        </div>
      ) : (
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={async () => {
          const r = await act(() => post<{ token: string }>(`/api/v1/accounts/${id}/dealer-portal`, { on: true }), 'Dealer portal opened');
          if (r) setLink(`${window.location.origin}/dealer/${r.token}`);
        }}>
          Open a dealer portal
        </button>
      )}
      <p className="muted small">The dealer sees their orders, invoices, deals they referred, scheme earnings and price list, and can register leads (credited to them).</p>
    </div>
  );
}

/* ───────────── quote ───────────── */

export function QuotePanels({ id, rec, canEdit }: { id: string; rec: RecordDto; canEdit: boolean }) {
  const { me } = useAuth();
  const act = useAct([['quote', id], ['quote-costing', id], ['record', 'quote', id]]);
  const toast = useToast();
  const margins = !!me && ['books', 'billing', 'projects', 'manufacturing', 'operations', 'margins'].some((a) => hasAdmin(me.permissions, a));
  const cost = useQuery({ queryKey: ['quote-costing', id], queryFn: () => get<Json>(`/api/v1/quotes/${id}/costing`), enabled: margins });
  const status = String(rec.status);
  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {status === 'rfq' && (
        <div className="notice spread" style={{ alignItems: 'center' }}>
          <span>
            <b>RFQ{rec.rfq_number ? ` ${rec.rfq_number}` : ''}</b> from the customer{rec.rfq_due_on ? ` · quote due by ${d(rec.rfq_due_on)}` : ''}. Add the lines, apply their prices, then make it a quote.
          </span>
          {canEdit && (
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/quotes/${id}/rfq-to-quote`), 'Now a draft quote — send it when ready')}>
              Priced — make it a quote
            </button>
          )}
        </div>
      )}
      {['draft', 'rfq'].includes(status) && canEdit && (
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await act(() => post<{ changed: number }>(`/api/v1/quotes/${id}/reprice`));
              if (r) toast(r.changed ? `${r.changed} line${r.changed > 1 ? 's' : ''} re-priced` : 'Prices already match');
            }}
          >
            Apply customer prices & quantity tiers
          </button>
        </div>
      )}
      {margins && cost.data && cost.data.lines.length > 0 && (
        <details className="panel" style={{ padding: 10 }} open={cost.data.belowFloor}>
          <summary className="spread">
            <span>
              <b>Cost and margin</b> <span className="muted small">(internal — not on the quote)</span>
            </span>
            <span className={cost.data.belowFloor ? 'bad-text' : 'good-text'}>
              {inr(cost.data.margin)} · {pct(cost.data.marginPct)}
              {cost.data.belowFloor ? ` — below the ${cost.data.minMarginPct}% floor` : ''}
            </span>
          </summary>
          <table className="data" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Qty</th>
                <th className="num">Net price</th>
                <th className="num">Unit cost</th>
                <th>Cost from</th>
                <th className="num">Margin</th>
                <th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              {cost.data.lines.map((l: Json) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{inr(l.net)}</td>
                  <td className="num">{l.unitCost ? inr(l.unitCost) : '—'}</td>
                  <td className="small">{{ bom: 'BOM roll-up', average: 'average / purchase cost', none: 'no cost known' }[l.basis as string]}</td>
                  <td className={`num ${l.margin < 0 ? 'bad-text' : ''}`}>{inr(l.margin)}</td>
                  <td className="num">{pct(l.marginPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cost.data.uncosted > 0 && <p className="small warn-text">{cost.data.uncosted} line(s) have no cost — the margin is overstated.</p>}
        </details>
      )}
    </div>
  );
}

/* ───────────── sales order ───────────── */

export function OrderPanels({ id, rec, canEdit }: { id: string; rec: RecordDto; canEdit: boolean }) {
  const credit = useQuery({ queryKey: ['credit', 'order', id], queryFn: () => get<Json>(`/api/v1/sales-orders/${id}/credit`) });
  const promise = useQuery({ queryKey: ['promise', id], queryFn: () => get<Json>(`/api/v1/sales-orders/${id}/promise`) });
  const act = useAct([['promise', id], ['credit'], ['record', 'sales_order', id], ['order', id]]);
  const c = credit.data;
  const approved = !!c?.approvedAt;
  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {c && (c.needsApproval || approved) && rec.status === 'draft' && (
        <div className={`notice ${approved ? '' : 'warn'} spread`} style={{ alignItems: 'center' }}>
          <span>
            {approved ? (
              <>✅ Approved on credit{c.note ? ` — ${c.note}` : ''}.</>
            ) : c.hold ? (
              <>
                <b>Credit hold.</b> {c.limitAccountName ?? 'This customer'} is on hold; the order needs finance's approval to be confirmed.
              </>
            ) : (
              <>
                <b>Over the credit limit.</b> Limit {inr(c.limit)}
                {c.limitAccountName ? ` (${c.limitAccountName} group)` : ''}; owed and on order {inr(c.exposure)}; this order {inr(c.orderTotal)}.
              </>
            )}
          </span>
          {!approved &&
            (c.canApprove ? (
              <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/sales-orders/${id}/credit-approve`, { note: window.prompt('Why is it OK? (optional)') || null }), 'Approved on credit')}>
                Approve on credit
              </button>
            ) : (
              <button className="btn sm" onClick={() => act(() => post(`/api/v1/sales-orders/${id}/credit-request`, {}), 'Finance has been asked')}>
                Ask finance to approve
              </button>
            ))}
        </div>
      )}
      {promise.data && promise.data.lines.some((l: Json) => l.open > 0) && rec.status !== 'cancelled' && (
        <details className="panel" style={{ padding: 10 }}>
          <summary className="spread">
            <b>Promise dates</b>
            <span className="small">
              Everything by <b>{d(promise.data.promiseDate)}</b>
            </span>
          </summary>
          <table className="data" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">To deliver</th>
                <th>Can promise</th>
                <th>From</th>
                <th>Promised now</th>
              </tr>
            </thead>
            <tbody>
              {promise.data.lines.map((l: Json) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="num">{l.open}</td>
                  <td>{d(l.promiseDate)}</td>
                  <td className="small">
                    {{ stock: 'stock', purchase: 'incoming purchase', production: 'production', lead_time: 'lead time' }[l.from as string] ?? l.from}
                    {l.shortBy > 0 ? <span className="warn-text"> · short {l.shortBy}</span> : null}
                  </td>
                  <td>{d(l.current)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => act(() => post(`/api/v1/sales-orders/${id}/promise`), 'Promise dates saved on the lines')}>
              Save these promise dates
            </button>
          )}
        </details>
      )}
    </div>
  );
}

/* ───────────── ticket ───────────── */

export function TicketPanels({ id, rec, canEdit }: { id: string; rec: RecordDto; canEdit: boolean }) {
  const w = useQuery({ queryKey: ['ticket-warranty', id], queryFn: () => get<Json>(`/api/v1/tickets/${id}/warranty`) });
  const parts = useQuery({ queryKey: ['ticket-parts', id], queryFn: () => get<{ items: Json[] }>(`/api/v1/tickets/${id}/parts`) });
  const capas = useQuery({ queryKey: ['capas', 'ticket', id], queryFn: () => get<{ items: Json[] }>(`/api/v1/capas?ticket=${id}`) });
  const act = useAct([['ticket-parts', id], ['capas'], ['record', 'ticket', id]]);
  const [issuing, setIssuing] = useState(false);
  const [capa, setCapa] = useState<Json | null>(null);
  const nav = useNavigate();
  const level = Number(rec.escalation_level ?? 0);
  const chargeable = (parts.data?.items ?? []).filter((p) => p.chargeable);
  return (
    <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {w.data &&
            (w.data.covered ? (
              <span className="chip good">Under warranty until {d(w.data.warranty.ends_on)}</span>
            ) : (
              <span className="chip" title={w.data.reason ?? undefined}>
                {w.data.warranty ? `Warranty ended ${d(w.data.warranty.ends_on)}` : 'No warranty on record'}
              </span>
            ))}
          {level > 0 && <span className="chip bad">Escalated · level {level}</span>}
        </div>
        {canEdit && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setIssuing(true)}>
              Issue spare part
            </button>
            <button className="btn sm" onClick={() => setCapa({ title: String(rec.name ?? ''), ticket_id: id, account_id: rec.account_id, product_id: rec.product_id, severity: rec.priority === 'urgent' ? 'major' : 'minor', status: 'open' })}>
              Raise CAPA
            </button>
            <button className="btn sm danger" onClick={() => act(() => post(`/api/v1/tickets/${id}/escalate`, { note: window.prompt('Why escalate? (optional)') || null }), 'Escalated')}>
              Escalate
            </button>
          </div>
        )}
      </div>
      {(parts.data?.items.length ?? 0) > 0 && (
        <table className="data" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Spare part</th>
              <th className="num">Qty</th>
              <th>Charged</th>
              <th className="num">Price</th>
              <th>Issued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {parts.data!.items.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name} <span className="muted small">{p.sku}</span>
                </td>
                <td className="num">{p.quantity}</td>
                <td>{p.chargeable ? <span className="chip">chargeable</span> : <span className="chip good">{p.under_warranty ? 'free (warranty)' : 'free'}</span>}</td>
                <td className="num">{p.chargeable ? inr(p.unit_price * p.quantity) : '—'}</td>
                <td className="small">
                  {d(p.issued_at)} · {p.issued_by ?? ''}
                </td>
                <td>
                  {canEdit && (
                    <button className="btn sm ghost" onClick={() => window.confirm('Return this part to stock?') && act(() => del(`/api/v1/tickets/${id}/parts/${p.id}`), 'Returned to stock')}>
                      Return
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {chargeable.length > 0 && canEdit && (
        <button
          className="btn sm"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const r = await act(() => post<{ invoiceId: string }>(`/api/v1/tickets/${id}/bill-parts`), 'Draft invoice raised for the parts');
            if (r) nav(`/o/invoice/${r.invoiceId}`);
          }}
        >
          Bill chargeable parts
        </button>
      )}
      {(capas.data?.items.length ?? 0) > 0 && (
        <div style={{ marginTop: 10 }} className="small">
          CAPA:{' '}
          {capas.data!.items.map((c) => (
            <button key={c.id} className="link-btn" onClick={() => setCapa(c)}>
              {c.number} ({label(c.status)})
            </button>
          ))}
        </div>
      )}
      {issuing && <IssuePart ticketId={id} productId={(rec.product_id as string | null) ?? null} covered={!!w.data?.covered} onClose={() => setIssuing(false)} />}
      {capa && <CapaModal capa={capa} onClose={() => setCapa(null)} />}
    </div>
  );
}

function IssuePart({ ticketId, productId, covered, onClose }: { ticketId: string; productId: string | null; covered: boolean; onClose: () => void }) {
  const spares = useQuery({ queryKey: ['spares', productId], queryFn: () => get<{ items: Json[] }>(`/api/v1/spares${productId ? `?for=${productId}` : ''}`) });
  const [f, setF] = useState({ productId: '', quantity: '1', chargeable: !covered });
  const act = useAct([['ticket-parts', ticketId], ['after-sales']]);
  return (
    <Modal
      title="Issue a spare part"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!f.productId || !(Number(f.quantity) > 0)} onClick={async () => (await act(() => post(`/api/v1/tickets/${ticketId}/parts`, { productId: f.productId, quantity: Number(f.quantity), chargeable: f.chargeable }), 'Part issued from stock')) && onClose()}>
          Issue
        </button>
      }
    >
      <div className="modal-body stack">
        {(spares.data?.items.length ?? 0) > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {spares.data!.items.map((s) => (
              <button key={s.id} className={`btn sm${f.productId === s.id ? ' primary' : ''}`} onClick={() => setF({ ...f, productId: s.id })}>
                {s.name} · {s.available} in stock
              </button>
            ))}
          </div>
        )}
        <div className="field">
          Or any product
          <LookupPicker id="part-prod" objectKey="product" value={f.productId} onChange={(v) => setF({ ...f, productId: String(v ?? '') })} />
        </div>
        <label className="field">
          Quantity
          <input type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={f.chargeable} onChange={(e) => setF({ ...f, chargeable: e.target.checked })} /> Charge the customer {covered ? '(the product is under warranty)' : '(out of warranty)'}
        </label>
      </div>
    </Modal>
  );
}

/* ───────────── deal ───────────── */

export function LossModal({ dealId, onClose, onDone }: { dealId: string; onClose: () => void; onDone?: () => void }) {
  const reasons = useQuery({ queryKey: ['loss-reasons'], queryFn: () => get<{ items: { value: string; label: string }[] }>('/api/v1/deals-loss-reasons'), staleTime: 300_000 });
  const [f, setF] = useState({ reason: '', lostTo: '', note: '' });
  const act = useAct([['record', 'deal', dealId], ['board']]);
  return (
    <Modal
      title="Why was it lost?"
      onClose={onClose}
      footer={
        <button
          className="btn danger"
          disabled={!f.reason}
          onClick={async () => {
            if (await act(() => post(`/api/v1/deals/${dealId}/lost`, { reason: f.reason, lostTo: f.lostTo || null, note: f.note || null }), 'Marked lost')) {
              onDone?.();
              onClose();
            }
          }}
        >
          Mark lost
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {(reasons.data?.items ?? []).map((r) => (
            <button key={r.value} className={`btn sm${f.reason === r.value ? ' primary' : ''}`} onClick={() => setF({ ...f, reason: r.value })}>
              {r.label}
            </button>
          ))}
        </div>
        <label className="field">
          Lost to (competitor)
          <input value={f.lostTo} onChange={(e) => setF({ ...f, lostTo: e.target.value })} placeholder="e.g. Siemens" />
        </label>
        <label className="field">
          What we learned
          <textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          This feeds the win / loss report.
        </p>
      </div>
    </Modal>
  );
}

export function DealActions({ id, rec, canEdit, lost, won }: { id: string; rec: RecordDto; canEdit: boolean; lost: boolean; won: boolean }) {
  const [losing, setLosing] = useState(false);
  const act = useAct([['record', 'deal', id]]);
  const nav = useNavigate();
  if (!canEdit) return null;
  return (
    <>
      {!lost && !won && (
        <button className="btn" onClick={() => setLosing(true)}>
          Mark lost…
        </button>
      )}
      {won && (
        <button
          className="btn"
          onClick={async () => {
            const r = await act(() => post<{ id: string }>(`/api/v1/deals/${id}/contract`));
            if (r) nav(`/it/contracts?contract=${r.id}`);
          }}
        >
          Contract & documents
        </button>
      )}
      {losing && <LossModal dealId={id} onClose={() => setLosing(false)} />}
      {lost && rec.loss_reason ? <span className="chip bad" title={String(rec.loss_note ?? '')}>Lost: {label(rec.loss_reason)}{rec.lost_to ? ` → ${rec.lost_to}` : ''}</span> : null}
    </>
  );
}

/* ───────────── project: Jira / Azure DevOps / Asana ───────────── */

export function ProjectTracker({ id, rec }: { id: string; rec: RecordDto }) {
  const { me } = useAuth();
  const can = !!me && (hasAdmin(me.permissions, 'projects') || hasAdmin(me.permissions, 'developers'));
  const extQ = useQuery({ queryKey: ['project', id, 'tracker'], queryFn: () => get<{ provider: string; integrationId: string; key: string } | null>(`/api/v1/projects/${id}/tracker`), enabled: can });
  const ext = extQ.data;
  const conns = useQuery({ queryKey: ['connectors'], queryFn: () => get<Json>('/api/v1/connectors'), enabled: can && !ext, retry: false });
  const [f, setF] = useState({ integrationId: '', key: '' });
  const act = useAct([['record', 'project', id], ['project', id]]);
  void rec;
  if (!can) return null;
  const trackers = ((conns.data?.items ?? []) as Json[]).filter((i) => ['jira', 'azure_devops', 'asana'].includes(i.kind));
  const name = (p: string) => ({ jira: 'Jira', azure_devops: 'Azure DevOps', asana: 'Asana' })[p] ?? p;
  if (ext)
    return (
      <div className="notice spread" style={{ marginBottom: 12, alignItems: 'center' }}>
        <span>
          Linked to <b>{name(ext.provider)}</b> {ext.key}. Tasks are pushed there; when they are done there, they close here.
        </span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" onClick={() => act(() => post<{ pushed: number; completed: number }>(`/api/v1/projects/${id}/tracker-sync`)).then((r) => r && window.alert(`${r.pushed} task(s) pushed, ${r.completed} closed from ${name(ext.provider)}`))}>
            Sync now
          </button>
          <button className="btn sm ghost" onClick={() => window.confirm('Unlink the tracker?') && act(() => put(`/api/v1/projects/${id}/tracker`, null), 'Unlinked')}>
            Unlink
          </button>
        </span>
      </div>
    );
  if (!trackers.length) return null;
  return (
    <details className="panel" style={{ padding: 10, marginBottom: 12 }}>
      <summary className="small">Link this project to Jira / Azure DevOps / Asana</summary>
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <select value={f.integrationId} onChange={(e) => setF({ ...f, integrationId: e.target.value })} style={{ width: 'auto' }} aria-label="Connection">
          <option value="">Connection…</option>
          {trackers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="Project key / name / gid" style={{ width: 220 }} />
        <button className="btn sm primary" disabled={!f.integrationId || !f.key.trim()} onClick={() => act(() => put(`/api/v1/projects/${id}/tracker`, { integrationId: f.integrationId, key: f.key.trim() }), 'Linked')}>
          Link
        </button>
      </div>
    </details>
  );
}
