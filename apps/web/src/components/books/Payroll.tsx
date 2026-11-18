/** Books → Payroll: employees and their salary, the monthly run (PF / ESI / PT / TDS), posting, payment and payslips. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put } from '../../lib/api';
import { money2 } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const ym = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return d.toISOString().slice(0, 7);
};
const monthName = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function Payroll() {
  const [view, setView] = useState<'runs' | 'people'>('runs');
  const [run, setRun] = useState<string | null>(null);
  if (run) return <RunView id={run} back={() => setRun(null)} />;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 0 }}>
        <button className={`btn sm${view === 'runs' ? ' primary' : ''}`} onClick={() => setView('runs')}>
          Monthly payroll
        </button>
        <button className={`btn sm${view === 'people' ? ' primary' : ''}`} onClick={() => setView('people')}>
          Employees
        </button>
      </div>
      {view === 'runs' ? <Runs open={setRun} /> : <People />}
    </div>
  );
}

function Runs({ open }: { open: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['books', 'payroll'], queryFn: () => get<Json[]>('/api/v1/books/payroll') });
  const [period, setPeriod] = useState(ym());
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <div className="row">
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 180 }} aria-label="Month" />
        <button
          className="btn primary"
          onClick={async () => {
            try {
              const r = await post<Json>('/api/v1/books/payroll', { period });
              qc.invalidateQueries({ queryKey: ['books', 'payroll'] });
              open(r.id);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Run payroll for {monthName(period)}
        </button>
      </div>
      {!data.length ? (
        <Empty title="No payroll yet">Add the employees with their monthly salary, then run the month: PF, ESI, professional tax and TDS are worked out for each person.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              <th>Status</th>
              <th className="num">People</th>
              <th className="num">Gross</th>
              <th className="num">Net paid</th>
              <th className="num">Cost to company</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="click" onClick={() => open(r.id)}>
                <td>
                  <b>{monthName(r.period)}</b>
                </td>
                <td>
                  <span className={`pill ${r.status === 'paid' ? 'good' : r.status === 'posted' ? 'info' : 'warn'}`}>{r.status}</span>
                </td>
                <td className="num">{r.people}</td>
                <td className="num">{money2(r.gross)}</td>
                <td className="num">{money2(r.net)}</td>
                <td className="num">{money2(r.employer_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunView({ id, back }: { id: string; back: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['books', 'payroll', id], queryFn: () => get<Json>(`/api/v1/books/payroll/${id}`) });
  const banks = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts') });
  const [edit, setEdit] = useState<Json | null>(null);
  const [paying, setPaying] = useState(false);
  const [slip, setSlip] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      refetch();
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const slips = data.slips as Json[];
  const sum = (k: string) => slips.reduce((t, s) => t + Number(s[k] ?? 0), 0);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={back}>
          ← All months
        </button>
        <h3 style={{ margin: 0 }}>Payroll · {monthName(data.period)}</h3>
        <span className={`pill ${data.status === 'paid' ? 'good' : data.status === 'posted' ? 'info' : 'warn'}`}>{data.status}</span>
        <span style={{ flex: 1 }} />
        {data.status === 'draft' && (
          <>
            <button
              className="btn sm danger"
              onClick={() =>
                confirm('Delete this draft payroll?') &&
                act(async () => {
                  await del(`/api/v1/books/payroll/${id}`);
                  back();
                }, 'Deleted')
              }
            >
              Delete
            </button>
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/books/payroll/${id}/post`, {}), 'Posted to the ledger')}>
              Post to the books
            </button>
          </>
        )}
        {data.status === 'posted' && (
          <>
            <button className="btn sm" onClick={() => act(() => post(`/api/v1/books/payroll/${id}/reopen`, {}), 'Reopened')}>
              Reopen
            </button>
            <button className="btn sm primary" onClick={() => setPaying(true)}>
              Record salaries paid
            </button>
          </>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {[
          ['Gross', sum('gross')],
          ['PF (both shares)', sum('employee_pf') + sum('employer_pf')],
          ['ESI (both shares)', sum('employee_esi') + sum('employer_esi')],
          ['Professional tax', sum('pt')],
          ['TDS on salary', sum('tds')],
          ['Net to pay', sum('net')],
        ].map(([l, v]) => (
          <div key={l as string} className="panel kpi">
            <div className="l">{l}</div>
            <div className="v" style={{ fontSize: 19 }}>
              {money2(v)}
            </div>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="num">Days</th>
              <th className="num">Gross</th>
              <th className="num">PF</th>
              <th className="num">ESI</th>
              <th className="num">PT</th>
              <th className="num">TDS</th>
              <th className="num">Other</th>
              <th className="num">Net</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {slips.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  <div className="small muted">{[s.designation, s.pan].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="num">
                  {s.paid_days}/{s.days_in_month}
                </td>
                <td className="num">{money2(s.gross)}</td>
                <td className="num">{money2(s.employee_pf)}</td>
                <td className="num">{money2(s.employee_esi)}</td>
                <td className="num">{money2(s.pt)}</td>
                <td className="num">{money2(s.tds)}</td>
                <td className="num">{money2(s.other_deductions)}</td>
                <td className="num">
                  <b>{money2(s.net)}</b>
                </td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {data.status === 'draft' && (
                    <button className="btn ghost sm" onClick={() => setEdit(s)}>
                      Adjust
                    </button>
                  )}
                  <button className="btn ghost sm" onClick={() => setSlip(s)}>
                    Payslip
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <AdjustModal
          slip={edit}
          onClose={() => setEdit(null)}
          onSave={(b) =>
            act(async () => {
              await put(`/api/v1/books/payroll/${id}/slips/${edit.id}`, b);
              setEdit(null);
            }, 'Updated')
          }
        />
      )}
      {paying && <PayModal banks={(banks.data ?? []).filter((b) => b.kind !== 'credit_card')} net={sum('net')} onClose={() => setPaying(false)} onPay={(b) => act(async () => {
        await post(`/api/v1/books/payroll/${id}/pay`, b);
        setPaying(false);
      }, 'Salaries recorded as paid')} />}
      {slip && <Payslip slip={slip} period={data.period} onClose={() => setSlip(null)} />}
    </div>
  );
}

function AdjustModal({ slip, onClose, onSave }: { slip: Json; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({ paidDays: String(slip.paid_days), tds: String(slip.tds), other: String(slip.other_deductions ?? 0), note: slip.note ?? '' });
  return (
    <Modal
      title={`Adjust · ${slip.name}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={() => onSave({ paidDays: Number(f.paidDays), tds: f.tds === '' ? null : Number(f.tds), otherDeductions: Number(f.other) || 0, note: f.note || null })}>
          Save
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          Paid days (of {slip.days_in_month})
          <input type="number" min={0} max={slip.days_in_month} step={0.5} value={f.paidDays} onChange={(e) => setF({ ...f, paidDays: e.target.value })} />
        </label>
        <label className="field">
          TDS this month (blank = work it out)
          <input type="number" min={0} value={f.tds} onChange={(e) => setF({ ...f, tds: e.target.value })} />
        </label>
        <label className="field">
          Other deductions (advance, loan)
          <input type="number" min={0} value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })} />
        </label>
        <label className="field">
          Note on the payslip
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

function PayModal({ banks, net, onClose, onPay }: { banks: Json[]; net: number; onClose: () => void; onPay: (b: Json) => void }) {
  const [bank, setBank] = useState(banks[0]?.id ?? '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <Modal
      title={`Salaries paid · ${money2(net)}`}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!bank} onClick={() => onPay({ bankAccountId: bank, date })}>
          Record
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          Paid from
          <select value={bank} onChange={(e) => setBank(e.target.value)}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          On
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <p className="small muted wide" style={{ margin: 0 }}>
          The bank lines for the transfers can then be matched to this entry in Banking.
        </p>
      </div>
    </Modal>
  );
}

function Payslip({ slip, period, onClose }: { slip: Json; period: string; onClose: () => void }) {
  const org = useQuery({ queryKey: ['organisation'], queryFn: () => get<Json>('/api/v1/organisation') });
  const p = org.data?.profile ?? {};
  const ded: [string, number][] = [
    ['Provident fund', slip.employee_pf],
    ['ESI', slip.employee_esi],
    ['Professional tax', slip.pt],
    ['Income tax (TDS)', slip.tds],
    ['Other deductions', slip.other_deductions],
  ].filter(([, v]) => Number(v) > 0) as [string, number][];
  const print = () => {
    const el = document.getElementById('payslip-print');
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!el || !w) return;
    w.document.write(`<!doctype html><html><head><title>Payslip ${slip.name} ${period}</title><style>body{font-family:Inter,Arial,sans-serif;color:#0f172a;padding:28px}table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}td.n,th.n{text-align:right}h2{margin:0}.muted{color:#64748b;font-size:13px}</style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <Modal title="Payslip" wide onClose={onClose} footer={<button className="btn primary" onClick={print}>Print / save as PDF</button>}>
      <div className="modal-body" style={{ display: 'block', background: '#fff', color: '#0f172a' }} id="payslip-print">
        <h2>{p.legalName ?? ''}</h2>
        <div className="muted">{[p.address, p.city, p.state].filter(Boolean).join(', ')}</div>
        <h3 style={{ margin: '14px 0 4px' }}>Payslip for {monthName(period)}</h3>
        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr>
              <td>Employee</td>
              <td>
                <b>{slip.name}</b>
              </td>
              <td>Designation</td>
              <td>{slip.designation ?? '—'}</td>
            </tr>
            <tr>
              <td>PAN</td>
              <td>{slip.pan ?? '—'}</td>
              <td>UAN</td>
              <td>{slip.uan ?? '—'}</td>
            </tr>
            <tr>
              <td>Paid days</td>
              <td>
                {slip.paid_days} of {slip.days_in_month}
              </td>
              <td>Bank account</td>
              <td>{slip.bank_account ? `••${String(slip.bank_account).slice(-4)}` : '—'}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Earnings</th>
                <th className="n">₹</th>
              </tr>
            </thead>
            <tbody>
              {(slip.earnings as Json[]).map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td>
                  <td className="n">{money2(e.amount)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Gross</b>
                </td>
                <td className="n">
                  <b>{money2(slip.gross)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Deductions</th>
                <th className="n">₹</th>
              </tr>
            </thead>
            <tbody>
              {ded.map(([n, v]) => (
                <tr key={n}>
                  <td>{n}</td>
                  <td className="n">{money2(v)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td className="n">
                  <b>{money2(ded.reduce((t, [, v]) => t + Number(v), 0))}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 style={{ margin: '16px 0 0' }}>Net pay: {money2(slip.net)}</h3>
        {slip.note && <p className="muted">{slip.note}</p>}
        <p className="muted" style={{ marginTop: 18 }}>
          Employer's contribution: PF {money2(slip.employer_pf)}, ESI {money2(slip.employer_esi)}. This is a computer-generated payslip.
        </p>
      </div>
    </Modal>
  );
}

const blank: Json = { name: '', code: '', designation: '', department: '', email: '', phone: '', pan: '', uan: '', esicNo: '', joinedOn: '', state: '', taxRegime: 'new', bankName: '', bankAccount: '', ifsc: '', basic: 0, hra: 0, special: 0, otherAllowances: [], pfEnabled: true, pfOnFullBasic: false, esiEnabled: true, ptEnabled: false, annualDeductions: 0, status: 'active' };
const fromRow = (e: Json): Json => ({
  name: e.name, code: e.code ?? '', designation: e.designation ?? '', department: e.department ?? '', email: e.email ?? '', phone: e.phone ?? '', pan: e.pan ?? '', uan: e.uan ?? '', esicNo: e.esic_no ?? '',
  joinedOn: e.joined_on ?? '', leftOn: e.left_on ?? '', state: e.state ?? '', taxRegime: e.tax_regime, bankName: e.bank_name ?? '', bankAccount: e.bank_account ?? '', ifsc: e.ifsc ?? '', basic: e.basic, hra: e.hra, special: e.special,
  otherAllowances: e.other_allowances ?? [], pfEnabled: e.pf_enabled, pfOnFullBasic: e.pf_on_full_basic, esiEnabled: e.esi_enabled, ptEnabled: e.pt_enabled, annualDeductions: e.annual_deductions, status: e.status,
});

function People() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'employees'], queryFn: () => get<Json[]>('/api/v1/books/employees') });
  const [edit, setEdit] = useState<{ id: string | null; f: Json } | null>(null);
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <div>
        <button className="btn primary sm" onClick={() => setEdit({ id: null, f: { ...blank } })}>
          + Add an employee
        </button>
      </div>
      {!data.length ? (
        <Empty title="No employees yet">Add each person with their monthly basic, HRA and special allowance.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Designation</th>
              <th className="num">Monthly gross</th>
              <th>Statutory</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id} className="click" onClick={() => setEdit({ id: e.id, f: fromRow(e) })}>
                <td>
                  <b>{e.name}</b>
                  <div className="small muted">{[e.code, e.pan].filter(Boolean).join(' · ')}</div>
                </td>
                <td>{e.designation ?? '—'}</td>
                <td className="num">{money2(Number(e.basic) + Number(e.hra) + Number(e.special) + (e.other_allowances ?? []).reduce((t: number, a: Json) => t + Number(a.amount), 0))}</td>
                <td className="small">{[e.pf_enabled && 'PF', e.esi_enabled && Number(e.basic) + Number(e.hra) + Number(e.special) <= 21000 && 'ESI', e.pt_enabled && 'PT', e.tax_regime === 'old' ? 'old regime' : 'new regime'].filter(Boolean).join(' · ')}</td>
                <td>
                  <span className={`pill ${e.status === 'active' ? 'good' : ''}`}>{e.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <EmployeeModal id={edit.id} initial={edit.f} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refetch(); }} />}
    </div>
  );
}

function EmployeeModal({ id, initial, onClose, onSaved }: { id: string | null; initial: Json; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Json>(initial);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const num = (k: string) => <input type="number" min={0} value={f[k]} onChange={(e) => set(k, Number(e.target.value) || 0)} />;
  const txt = (k: string, ph = '') => <input value={f[k] ?? ''} placeholder={ph} onChange={(e) => set(k, e.target.value)} />;
  const gross = Number(f.basic) + Number(f.hra) + Number(f.special) + (f.otherAllowances ?? []).reduce((t: number, a: Json) => t + Number(a.amount), 0);
  return (
    <Modal
      title={id ? `Edit ${initial.name}` : 'Add an employee'}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="small muted" style={{ marginRight: 'auto' }}>
            Monthly gross {money2(gross)} · CTC about {money2(gross * 12)} a year
          </span>
          <button
            className="btn primary"
            disabled={!f.name}
            onClick={async () => {
              try {
                const body = { ...f, joinedOn: f.joinedOn || null, leftOn: f.leftOn || null, otherAllowances: (f.otherAllowances ?? []).filter((a: Json) => a.name && a.amount > 0) };
                if (id) await put(`/api/v1/books/employees/${id}`, body);
                else await post('/api/v1/books/employees', body);
                toast('Saved');
                onSaved();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <label className="field">Name{txt('name')}</label>
        <label className="field">Employee code{txt('code')}</label>
        <label className="field">Designation{txt('designation')}</label>
        <label className="field">Department{txt('department')}</label>
        <label className="field">Email{txt('email')}</label>
        <label className="field">Phone{txt('phone')}</label>
        <label className="field">PAN{txt('pan', 'ABCDE1234F')}</label>
        <label className="field">UAN (PF){txt('uan')}</label>
        <label className="field">ESIC number{txt('esicNo')}</label>
        <label className="field">
          Joined on
          <input type="date" value={f.joinedOn ?? ''} onChange={(e) => set('joinedOn', e.target.value)} />
        </label>
        <label className="field">
          Left on
          <input type="date" value={f.leftOn ?? ''} onChange={(e) => set('leftOn', e.target.value)} />
        </label>
        <label className="field">Works in (state, for PT){txt('state', 'Uttar Pradesh')}</label>
        <div className="wide small" style={{ fontWeight: 700, marginTop: 4 }}>
          Monthly salary
        </div>
        <label className="field">Basic{num('basic')}</label>
        <label className="field">HRA{num('hra')}</label>
        <label className="field">Special allowance{num('special')}</label>
        <div className="wide">
          {(f.otherAllowances ?? []).map((a: Json, i: number) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input value={a.name} placeholder="Allowance" onChange={(e) => set('otherAllowances', f.otherAllowances.map((x: Json, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input type="number" min={0} value={a.amount} style={{ maxWidth: 160 }} onChange={(e) => set('otherAllowances', f.otherAllowances.map((x: Json, j: number) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))} />
              <button className="btn ghost sm" onClick={() => set('otherAllowances', f.otherAllowances.filter((_: Json, j: number) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => set('otherAllowances', [...(f.otherAllowances ?? []), { name: '', amount: 0 }])}>
            + Another allowance
          </button>
        </div>
        <div className="wide small" style={{ fontWeight: 700, marginTop: 4 }}>
          Statutory
        </div>
        <label className="row small">
          <input type="checkbox" checked={f.pfEnabled} onChange={(e) => set('pfEnabled', e.target.checked)} /> PF
        </label>
        <label className="row small">
          <input type="checkbox" checked={f.pfOnFullBasic} onChange={(e) => set('pfOnFullBasic', e.target.checked)} /> PF on full basic (not capped at ₹15,000)
        </label>
        <label className="row small">
          <input type="checkbox" checked={f.esiEnabled} onChange={(e) => set('esiEnabled', e.target.checked)} /> ESI (while gross ≤ ₹21,000)
        </label>
        <label className="row small">
          <input type="checkbox" checked={f.ptEnabled} onChange={(e) => set('ptEnabled', e.target.checked)} /> Professional tax
        </label>
        <label className="field">
          Tax regime
          <select value={f.taxRegime} onChange={(e) => set('taxRegime', e.target.value)}>
            <option value="new">New regime</option>
            <option value="old">Old regime</option>
          </select>
        </label>
        {f.taxRegime === 'old' && <label className="field">Declared deductions a year (80C, 80D …){num('annualDeductions')}</label>}
        <div className="wide small" style={{ fontWeight: 700, marginTop: 4 }}>
          Salary account
        </div>
        <label className="field">Bank{txt('bankName')}</label>
        <label className="field">Account number{txt('bankAccount')}</label>
        <label className="field">IFSC{txt('ifsc')}</label>
        <label className="field">
          Status
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Working</option>
            <option value="left">Left</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
