/** Books → TDS returns: the quarter's 26Q / 24Q worksheet, challans deposited, and the Form 16A register. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, download, get, post } from '../../lib/api';
import { money2 } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const fyNow = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};
const qNow = () => {
  const m = new Date(Date.now() + 5.5 * 3_600_000).getUTCMonth() + 1;
  return m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
};
const mName = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function TdsReturns() {
  const qc = useQueryClient();
  const toast = useToast();
  const [fy, setFy] = useState(fyNow());
  const [q, setQ] = useState(qNow());
  const [form, setForm] = useState<'26Q' | '24Q'>('26Q');
  const [adding, setAdding] = useState(false);
  const key = ['books', 'tds-return', fy, q, form];
  const { data } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/books/tds/return?fy=${fy}&q=${q}&form=${form}`) });
  const reg = useQuery({ queryKey: ['books', 'form16a', fy, q], queryFn: () => get<Json[]>(`/api/v1/books/tds/form16a?fy=${fy}&q=${q}`), enabled: form === '26Q' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', 'tds-return'] });
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={fy} onChange={(e) => setFy(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Financial year">
          {[fyNow() - 1, fyNow()].map((y) => (
            <option key={y} value={y}>
              FY {y}-{String((y + 1) % 100).padStart(2, '0')}
            </option>
          ))}
        </select>
        <div className="row" style={{ gap: 0 }}>
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className={`btn sm${q === n ? ' primary' : ''}`} onClick={() => setQ(n)}>
              Q{n}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 0 }}>
          <button className={`btn sm${form === '26Q' ? ' primary' : ''}`} onClick={() => setForm('26Q')} title="TDS on payments other than salary">
            26Q · vendors
          </button>
          <button className={`btn sm${form === '24Q' ? ' primary' : ''}`} onClick={() => setForm('24Q')} title="TDS on salaries">
            24Q · salaries
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setAdding(true)}>
          + Record a challan
        </button>
        <button className="btn sm" onClick={() => download(`/api/v1/books/tds/return?fy=${fy}&q=${q}&form=${form}&format=csv`, `${form}-Q${q}.csv`).catch((e) => toast((e as Error).message, true))}>
          Export for the return
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div className="panel kpi">
              <div className="l">Deducted</div>
              <div className="v" style={{ fontSize: 20 }}>{money2(data.totals.tds)}</div>
              <div className="small muted">on {money2(data.totals.paid)} paid</div>
            </div>
            <div className="panel kpi">
              <div className="l">Deposited</div>
              <div className="v" style={{ fontSize: 20, color: data.totals.deposited + 0.5 < data.totals.tds ? 'var(--bad)' : 'var(--good)' }}>{money2(data.totals.deposited)}</div>
              <div className="small muted">{data.challans.length} challan(s)</div>
            </div>
            <div className="panel kpi">
              <div className="l">Return due</div>
              <div className="v" style={{ fontSize: 20 }}>{new Date(`${data.returnDue}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</div>
              <div className="small muted">
                {data.form} · {data.quarter} {data.fy}
              </div>
            </div>
            <div className="panel kpi">
              <div className="l">By section</div>
              <div className="small" style={{ marginTop: 4 }}>
                {data.bySection.length ? data.bySection.map((s: Json) => `${s.section}: ${money2(s.tds)}`).join(' · ') : '—'}
              </div>
            </div>
          </div>
          {data.warnings.length > 0 && (
            <div className="notice" style={{ display: 'block' }}>
              {data.warnings.map((w: string) => (
                <div key={w}>⚠ {w}</div>
              ))}
            </div>
          )}
          <div className="panel">
            <div className="panel-head">
              <h2>Month by month</h2>
            </div>
            <table className="data" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Deposit due</th>
                  <th className="num">Deducted</th>
                  <th className="num">Deposited</th>
                  <th className="num">Short</th>
                  <th>Deposited on</th>
                  <th className="num">Interest due</th>
                </tr>
              </thead>
              <tbody>
                {data.byMonth.map((m: Json) => (
                  <tr key={m.month}>
                    <td>{mName(m.month)}</td>
                    <td>{m.due}</td>
                    <td className="num">{money2(m.deducted)}</td>
                    <td className="num">{money2(m.deposited)}</td>
                    <td className="num" style={{ color: m.short > 0 ? 'var(--bad)' : undefined }}>
                      {money2(m.short)}
                    </td>
                    <td>{m.lastDeposit ?? '—'}</td>
                    <td className="num">{m.interestDue > m.interestPaid ? <span style={{ color: 'var(--bad)' }}>{money2(m.interestDue - m.interestPaid)}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>Deductions ({data.rows.length})</h2>
            </div>
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="data" style={{ margin: 0 }} data-export-title={`${data.form} ${data.quarter} ${data.fy}`}>
                <thead>
                  <tr>
                    <th>Deductee</th>
                    <th>PAN</th>
                    <th>Section</th>
                    <th>Date</th>
                    <th className="num">Paid / credited</th>
                    <th className="num">Rate</th>
                    <th className="num">TDS</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r: Json) => (
                    <tr key={r.id}>
                      <td>{r.party}</td>
                      <td>{r.pan ?? <span className="pill bad">no PAN</span>}</td>
                      <td>{r.section ?? '—'}</td>
                      <td>{r.date}</td>
                      <td className="num">{money2(r.paid)}</td>
                      <td className="num">{r.rate}%</td>
                      <td className="num">{money2(r.tds)}</td>
                      <td>{r.ref ?? ''}</td>
                    </tr>
                  ))}
                  {!data.rows.length && (
                    <tr>
                      <td colSpan={8} className="muted">
                        No TDS deducted in this quarter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>Challans</h2>
            </div>
            <table className="data" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>For month</th>
                  <th>Section</th>
                  <th>Deposited on</th>
                  <th>BSR · serial</th>
                  <th className="num">Tax</th>
                  <th className="num">Interest</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.challans.map((c: Json) => (
                  <tr key={c.id}>
                    <td>{mName(c.period)}</td>
                    <td>{c.section ?? '—'}</td>
                    <td>{c.deposited_on}</td>
                    <td>{[c.bsr_code, c.challan_no].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="num">{money2(c.tax)}</td>
                    <td className="num">{money2(Number(c.interest) + Number(c.late_fee))}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          if (!confirm('Remove this challan? Its bank entry is reversed.')) return;
                          await del(`/api/v1/books/tds/challans/${c.id}`).catch((e) => toast((e as Error).message, true));
                          refresh();
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {!data.challans.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No challans recorded for this quarter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {form === '26Q' && (reg.data?.length ?? 0) > 0 && (
            <div className="panel">
              <div className="panel-head">
                <h2>Form 16A register</h2>
                <span className="small muted">Download each certificate from TRACES after the return is processed</span>
              </div>
              <table className="data" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>PAN</th>
                    <th>Sections</th>
                    <th className="num">Entries</th>
                    <th className="num">Paid</th>
                    <th className="num">TDS</th>
                  </tr>
                </thead>
                <tbody>
                  {reg.data!.map((r) => (
                    <tr key={`${r.party}${r.pan}`}>
                      <td>{r.party}</td>
                      <td>{r.pan ?? '—'}</td>
                      <td>{r.sections}</td>
                      <td className="num">{r.count}</td>
                      <td className="num">{money2(r.paid)}</td>
                      <td className="num">{money2(r.tds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {adding && <ChallanModal form={form} onClose={() => setAdding(false)} onSaved={refresh} />}
    </div>
  );
}

function ChallanModal({ form, onClose, onSaved }: { form: '26Q' | '24Q'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const banks = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts') });
  const last = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 7);
  const [f, setF] = useState({ nature: form === '24Q' ? 'salary' : 'non_salary', section: form === '24Q' ? '192' : '', period: last, depositedOn: new Date().toISOString().slice(0, 10), tax: '', interest: '0', lateFee: '0', bsrCode: '', challanNo: '', cin: '', bankAccountId: '' });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <Modal
      title="Record a TDS challan"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.tax}
          onClick={async () => {
            try {
              await post('/api/v1/books/tds/challans', { ...f, section: f.section || null, tax: Number(f.tax), interest: Number(f.interest) || 0, lateFee: Number(f.lateFee) || 0, bankAccountId: f.bankAccountId || null, cin: f.cin || null });
              toast('Challan recorded');
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          For
          <select value={f.nature} onChange={(e) => set('nature', e.target.value)}>
            <option value="non_salary">Vendors (26Q)</option>
            <option value="salary">Salaries (24Q)</option>
          </select>
        </label>
        <label className="field">
          Section
          <input value={f.section} onChange={(e) => set('section', e.target.value.toUpperCase())} placeholder="194J" />
        </label>
        <label className="field">
          Tax deducted in
          <input type="month" value={f.period} onChange={(e) => set('period', e.target.value)} />
        </label>
        <label className="field">
          Deposited on
          <input type="date" value={f.depositedOn} onChange={(e) => set('depositedOn', e.target.value)} />
        </label>
        <label className="field">
          Tax (₹)
          <input type="number" min={0} value={f.tax} onChange={(e) => set('tax', e.target.value)} />
        </label>
        <label className="field">
          Interest (₹)
          <input type="number" min={0} value={f.interest} onChange={(e) => set('interest', e.target.value)} />
        </label>
        <label className="field">
          BSR code
          <input value={f.bsrCode} onChange={(e) => set('bsrCode', e.target.value)} placeholder="7 digits" />
        </label>
        <label className="field">
          Challan serial no.
          <input value={f.challanNo} onChange={(e) => set('challanNo', e.target.value)} />
        </label>
        <label className="field">
          CIN
          <input value={f.cin} onChange={(e) => set('cin', e.target.value)} />
        </label>
        <label className="field">
          Paid from (posts the entry)
          <select value={f.bankAccountId} onChange={(e) => set('bankAccountId', e.target.value)}>
            <option value="">Do not post (already in the books)</option>
            {(banks.data ?? [])
              .filter((b) => b.kind !== 'credit_card')
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
