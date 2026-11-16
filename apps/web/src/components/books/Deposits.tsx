/** Books → Deposits & guarantees: EMD, performance security (BG / ePBG / FDR …), retention and other deposits. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { Empty, Modal, Spinner } from '../ui';
import { useAct } from './BookPanels';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);

const KINDS: [string, string][] = [
  ['emd', 'EMD (bid security)'],
  ['performance_security', 'Performance security'],
  ['retention', 'Retention money'],
  ['security_deposit', 'Security deposit'],
  ['other', 'Other'],
];
const INSTRUMENTS: [string, string][] = [
  ['online', 'Online transfer (NEFT / RTGS / GeM)'],
  ['epbg', 'ePBG (electronic bank guarantee)'],
  ['bank_guarantee', 'Bank guarantee'],
  ['fdr', 'FDR pledged'],
  ['dd', 'Demand draft'],
  ['insurance_bond', 'Insurance surety bond'],
  ['cash', 'Cash'],
  ['exempt', 'Exempted (MSE / Startup)'],
  ['withheld', 'Withheld from bills (opening)'],
];
const GUARANTEE = new Set(['bank_guarantee', 'epbg', 'insurance_bond']);
const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const instLabel = (k: string) => (k === 'withheld' ? 'Withheld from bills' : (INSTRUMENTS.find(([v]) => v === k)?.[1] ?? k));

function useBanks() {
  return useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts'), staleTime: 30_000 });
}
function BankSelect({ value, onChange, label = 'Bank / cash account' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const { data } = useBanks();
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(data ?? [])
          .filter((b) => b.is_active && b.kind !== 'credit_card')
          .map((b) => (
            <option key={b.gl_account_id} value={b.gl_account_id}>
              {b.name}
              {b.account_last4 ? ` ·${b.account_last4}` : ''}
            </option>
          ))}
      </select>
    </label>
  );
}

export function Deposits() {
  const [status, setStatus] = useState('active');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { data } = useQuery({ queryKey: ['deposits', status], queryFn: () => get<Json[]>(`/api/v1/deposits${status ? `?status=${status}` : ''}`) });
  const held = (data ?? []).filter((d) => d.status === 'active');
  const sum = (f: (d: Json) => boolean) => held.filter(f).reduce((s, d) => s + d.held, 0);
  return (
    <div className="stack">
      <div className="kpis" style={{ margin: 0 }}>
        <div className="panel kpi">
          <div className="l">Money with customers</div>
          <div className="v">{money2(sum((d) => !GUARANTEE.has(d.instrument) && d.instrument !== 'exempt'))}</div>
          <div className="small muted">EMD, deposits and retention</div>
        </div>
        <div className="panel kpi">
          <div className="l">Guarantees outstanding</div>
          <div className="v">{money2(sum((d) => GUARANTEE.has(d.instrument)))}</div>
          <div className="small muted">Contingent liability</div>
        </div>
        <div className="panel kpi">
          <div className="l">Expiring in 30 days</div>
          <div className={`v${held.some((d) => d.days_left != null && d.days_left <= 30) ? ' tone-bad' : ''}`}>{held.filter((d) => d.days_left != null && d.days_left <= 30).length}</div>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <button className="btn primary" onClick={() => setOpen('new')}>
          Record EMD / guarantee / deposit
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="Nothing here">
          Record the EMD you pay for a bid, the performance security (ePBG, bank guarantee, FDR) you give on an award, and any deposit. Retention withheld from a payment is
          added here automatically when you record the receipt.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Customer / project</th>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th className="num">Held</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="click" onClick={() => setOpen(d.id)}>
                  <td>{d.deposit_number}</td>
                  <td>
                    {kindLabel(d.kind)}
                    <div className="small muted">{instLabel(d.instrument)}</div>
                  </td>
                  <td>
                    {d.customer}
                    {d.project && <div className="small muted">{d.project}</div>}
                  </td>
                  <td className="small">
                    {d.reference}
                    {d.issuing_bank && <div className="muted">{d.issuing_bank}</div>}
                  </td>
                  <td className="num">{money2(d.amount)}</td>
                  <td className="num">{money2(d.held)}</td>
                  <td className={d.status === 'active' && d.days_left != null && d.days_left <= 30 ? 'tone-bad' : ''}>
                    {date(d.expiry_date)}
                    {d.status === 'active' && d.days_left != null && <div className="small">{d.days_left < 0 ? 'expired' : `${d.days_left} days`}</div>}
                  </td>
                  <td>
                    <span className={`chip ${d.status === 'active' ? 'info' : d.status === 'closed' ? 'good' : ''}`}>{d.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open === 'new' && <NewDeposit onClose={() => setOpen(null)} onDone={(id) => setOpen(id)} />}
      {open && open !== 'new' && <DepositModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewDeposit({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const act = useAct([['deposits']]);
  const [q, setQ] = useState('');
  const customers = useQuery({ queryKey: ['deposit-customers', q], queryFn: () => get<{ items: Json[] }>(`/api/v1/records/account?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const [f, setF] = useState({
    kind: 'emd', instrument: 'online', accountId: '', projectId: '', reference: '', issuingBank: '', amount: '', marginAmount: '', issueDate: today(), expiryDate: '', claimUntil: '', paidFrom: '', notes: '', opening: false,
  });
  const projects = useQuery({ queryKey: ['deposit-projects', f.accountId], queryFn: () => get<{ items: Json[] }>(`/api/v1/records/project?limit=100`), enabled: !!f.accountId });
  const guarantee = GUARANTEE.has(f.instrument);
  const moves = !['exempt', 'withheld'].includes(f.instrument) && (!guarantee || Number(f.marginAmount) > 0);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Modal
      title="Record EMD, guarantee or deposit"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!f.accountId || !(Number(f.amount) > 0)}
          onClick={async () => {
            const r = (await act(
              () =>
                post<{ id: string }>('/api/v1/deposits', {
                  kind: f.kind, instrument: f.instrument, accountId: f.accountId, projectId: f.projectId || null, reference: f.reference || null, issuingBank: f.issuingBank || null,
                  amount: Number(f.amount), marginAmount: guarantee ? Number(f.marginAmount) || 0 : 0, issueDate: f.issueDate || null, expiryDate: f.expiryDate || null,
                  claimUntil: f.claimUntil || null, paidFrom: f.paidFrom || null, notes: f.notes || null, opening: f.opening || f.instrument === 'withheld',
                }),
              'Recorded',
            )) as { id?: string } | null;
            if (r?.id) onDone(r.id);
          }}
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          What
          <select value={f.kind} onChange={(e) => set({ kind: e.target.value, instrument: e.target.value === 'retention' ? 'withheld' : e.target.value === 'performance_security' ? 'epbg' : f.instrument })}>
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Given as
          <select value={f.instrument} onChange={(e) => set({ instrument: e.target.value })}>
            {INSTRUMENTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Customer
          <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={f.accountId} onChange={(e) => set({ accountId: e.target.value, projectId: '' })}>
            <option value="">Choose…</option>
            {customers.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Project (optional)
          <select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })} disabled={!f.accountId}>
            <option value="">—</option>
            {(projects.data?.items ?? [])
              .filter((p) => (p as Json).account_id === f.accountId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {f.kind === 'emd' ? 'Bid number' : guarantee ? 'Guarantee number' : 'Reference'}
          <input value={f.reference} onChange={(e) => set({ reference: e.target.value })} placeholder={f.kind === 'emd' ? 'GEM/2026/B/…' : ''} />
        </label>
        {(guarantee || f.instrument === 'fdr' || f.instrument === 'dd') && (
          <label className="field">
            Issuing bank / insurer
            <input value={f.issuingBank} onChange={(e) => set({ issuingBank: e.target.value })} />
          </label>
        )}
        <label className="field">
          Amount (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
        </label>
        {guarantee && (
          <label className="field">
            Margin money blocked by your bank (₹)
            <input inputMode="decimal" value={f.marginAmount} onChange={(e) => set({ marginAmount: e.target.value })} placeholder="0 if none" />
          </label>
        )}
        <label className="field">
          Issued / paid on
          <input type="date" value={f.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />
        </label>
        <label className="field">
          Valid until
          <input type="date" value={f.expiryDate} onChange={(e) => set({ expiryDate: e.target.value })} />
        </label>
        {guarantee && (
          <label className="field">
            Claim period ends
            <input type="date" value={f.claimUntil} onChange={(e) => set({ claimUntil: e.target.value })} />
          </label>
        )}
        {moves && !f.opening && <BankSelect value={f.paidFrom} onChange={(v) => set({ paidFrom: v })} label={guarantee ? 'Margin paid from' : 'Paid from'} />}
        {f.instrument !== 'withheld' && moves && (
          <label className="check wide">
            <input type="checkbox" checked={f.opening} onChange={(e) => set({ opening: e.target.checked })} /> Already in the opening balances (don't post it again)
          </label>
        )}
        <label className="field wide">
          Notes
          <textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <p className="small muted wide" style={{ margin: 0 }}>
          {guarantee
            ? 'A guarantee is not money with the customer: only the margin your bank blocks is posted. You are reminded 30 and 7 days before it expires.'
            : f.instrument === 'withheld'
              ? 'Retention withheld from a payment is added automatically when you record the receipt; use this only for amounts from before you started with Synapse.'
              : f.instrument === 'exempt'
                ? 'Recorded for the bid file; nothing is posted.'
                : 'Posted as money with the customer until it is released or forfeited.'}
        </p>
      </div>
    </Modal>
  );
}

function DepositModal({ id, onClose }: { id: string; onClose: () => void }) {
  const key = ['deposit', id];
  const { data } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/deposits/${id}`) });
  const act = useAct([key, ['deposits']]);
  const [mode, setMode] = useState<null | 'release' | 'forfeit' | 'extend'>(null);
  const [f, setF] = useState({ amount: '', date: today(), bank: '', reason: '', expiryDate: '', claimUntil: '', reference: '' });
  if (!data) return null;
  const d = data.deposit;
  const guarantee = GUARANTEE.has(d.instrument);
  const active = d.status === 'active';
  const run = async () => {
    const base = `/api/v1/deposits/${id}`;
    const ok =
      mode === 'release'
        ? await act(() => post(`${base}/release`, { amount: guarantee ? null : Number(f.amount) || null, date: f.date, bankAccountId: f.bank || null, note: f.reason || null }), 'Released')
        : mode === 'forfeit'
          ? await act(() => post(`${base}/forfeit`, { amount: Number(f.amount), date: f.date, bankAccountId: f.bank || null, reason: f.reason }), 'Recorded')
          : await act(() => post(`${base}/extend`, { expiryDate: f.expiryDate, claimUntil: f.claimUntil || null, reference: f.reference || null, note: f.reason || null }), 'Extended');
    if (ok) setMode(null);
  };
  return (
    <Modal
      title={`${d.deposit_number} · ${kindLabel(d.kind)}`}
      onClose={onClose}
      wide
      footer={
        active && !mode ? (
          <>
            {!d.payment_id && Number(d.released_amount) === 0 && Number(d.forfeited_amount) === 0 && (
              <button
                className="btn ghost"
                onClick={() => {
                  const reason = window.prompt('Cancel this entry (it was recorded by mistake)? Reason:');
                  if (reason) act(() => post(`/api/v1/deposits/${id}/cancel`, { reason }), 'Cancelled');
                }}
              >
                Cancel entry
              </button>
            )}
            {guarantee && (
              <button className="btn" onClick={() => setMode('extend')}>
                Extend
              </button>
            )}
            {d.instrument !== 'exempt' && (
              <button className="btn" onClick={() => setMode('forfeit')}>
                Forfeit / invoked
              </button>
            )}
            <button className="btn primary" onClick={() => setMode('release')}>
              Release
            </button>
          </>
        ) : mode ? (
          <>
            <button className="btn ghost" onClick={() => setMode(null)}>
              Back
            </button>
            <button className="btn primary" disabled={mode === 'forfeit' ? !(Number(f.amount) > 0) || !f.reason.trim() : mode === 'extend' ? !f.expiryDate : false} onClick={run}>
              Save
            </button>
          </>
        ) : null
      }
    >
      <div className="modal-body">
        {!mode ? (
          <div className="stack">
            <div className="grid2">
              <div>
                <div className="small muted">Customer</div>
                {d.customer}
                {d.project && (
                  <div className="small">
                    <Link to={`/projects/${d.project_id}`}>{d.project}</Link>
                  </div>
                )}
              </div>
              <div>
                <div className="small muted">Given as</div>
                {instLabel(d.instrument)}
                {d.issuing_bank ? ` · ${d.issuing_bank}` : ''}
              </div>
              <div>
                <div className="small muted">Reference</div>
                {d.reference || '—'}
              </div>
              <div>
                <div className="small muted">Valid</div>
                {date(d.issue_date)} → {date(d.expiry_date) || 'open'}
                {d.claim_until ? ` (claims until ${date(d.claim_until)})` : ''}
              </div>
              <div>
                <div className="small muted">Amount · held</div>
                {money2(d.amount)} · <b>{money2(d.held)}</b>
              </div>
              <div>
                <div className="small muted">Released · forfeited</div>
                {money2(d.released_amount)} · {money2(d.forfeited_amount)}
              </div>
              {guarantee && (
                <div>
                  <div className="small muted">Margin money still blocked</div>
                  {money2(data.marginLeft)}
                </div>
              )}
              {d.notes && (
                <div className="wide">
                  <div className="small muted">Notes</div>
                  {d.notes}
                </div>
              )}
            </div>
            <h3 style={{ margin: '8px 0 0' }}>History</h3>
            <table className="data">
              <tbody>
                {(data.events as Json[]).map((e) => (
                  <tr key={e.id}>
                    <td>{date(e.event_date)}</td>
                    <td>{e.kind}</td>
                    <td className="num">{e.amount ? money2(e.amount) : e.new_expiry ? `to ${date(e.new_expiry)}` : ''}</td>
                    <td className="small">{[e.bank, e.note].filter(Boolean).join(' · ')}</td>
                    <td className="small muted">{e.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : mode === 'extend' ? (
          <div className="grid2">
            <label className="field">
              New expiry
              <input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
            </label>
            <label className="field">
              New claim period end
              <input type="date" value={f.claimUntil} onChange={(e) => setF({ ...f, claimUntil: e.target.value })} />
            </label>
            <label className="field">
              Amendment / new guarantee number
              <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
            </label>
            <label className="field">
              Note
              <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </label>
          </div>
        ) : (
          <div className="grid2">
            {(mode === 'forfeit' || !guarantee) && (
              <label className="field">
                Amount (up to {money2(d.held)})
                <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={mode === 'release' ? 'All of it' : ''} />
              </label>
            )}
            <label className="field">
              Date
              <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </label>
            {(mode === 'release' ? (guarantee ? data.marginLeft > 0 : d.instrument !== 'exempt') : guarantee && Number(f.amount) > data.marginLeft) && (
              <BankSelect value={f.bank} onChange={(v) => setF({ ...f, bank: v })} label={mode === 'release' ? (guarantee ? 'Margin comes back to' : 'Received in') : 'Paid by the bank from'} />
            )}
            <label className="field wide">
              {mode === 'forfeit' ? 'Reason (e.g. liquidated damages for late delivery)' : 'Note'}
              <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </label>
            <p className="small muted wide" style={{ margin: 0 }}>
              {mode === 'release'
                ? guarantee
                  ? 'The guarantee is returned whole; any margin money your bank blocked comes back.'
                  : 'Money returned by the customer. Part of it can come back now and the rest later.'
                : 'What the customer keeps is booked to Liquidated damages and penalties.'}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
