/** Books → Audit trail: every change to invoices, bills, payments, entries, bank lines, payroll and filings — who, when, what. Append-only. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download, get } from '../../lib/api';
import { Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const OBJECTS: [string, string][] = [
  ['', 'Everything'], ['invoice', 'Invoices'], ['invoice_line', 'Invoice lines'], ['payment', 'Receipts'], ['bill', 'Bills'], ['bill_line', 'Bill lines'], ['vendor_payment', 'Vendor payments'],
  ['expense', 'Expenses'], ['journal', 'Journal entries'], ['gl_account', 'Chart of accounts'], ['bank_transaction', 'Bank lines'], ['books_config', 'Books settings'], ['employee', 'Employees'],
  ['payroll_run', 'Payroll'], ['payslip', 'Payslips'], ['tds_challan', 'TDS challans'], ['compliance_item', 'Compliance'],
];
const LINK: Record<string, string> = { invoice: '/o/invoice/', bill: '/o/bill/', payment: '/o/payment/', vendor_payment: '/o/vendor_payment/', expense: '/o/expense/' };

function summary(changes: Json | null, action: string) {
  if (!changes) return '';
  if (action !== 'update') {
    const pick = ['invoice_number', 'bill_number', 'number', 'name', 'description', 'grand_total', 'amount', 'total', 'status'];
    return pick
      .filter((k) => changes[k] != null && changes[k] !== '')
      .slice(0, 4)
      .map((k) => `${k.replace(/_/g, ' ')}: ${String(changes[k]).slice(0, 60)}`)
      .join(' · ');
  }
  return Object.entries(changes)
    .slice(0, 6)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${JSON.stringify((v as unknown[])[0] ?? null).slice(0, 40)} → ${JSON.stringify((v as unknown[])[1] ?? null).slice(0, 40)}`)
    .join(' · ');
}

export function AuditTrail() {
  const toast = useToast();
  const [obj, setObj] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const qs = `from=${from}&to=${to}${obj ? `&object=${obj}` : ''}${action ? `&action=${action}` : ''}`;
  const { data, isLoading } = useQuery({ queryKey: ['books', 'audit', qs], queryFn: () => get<Json[]>(`/api/v1/books/audit-trail?${qs}&limit=500`) });
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Every change to the books is recorded with who made it and when, and the record cannot be edited or switched off — the edit log the Companies (Accounts) Rules and the LLP rules ask for. Your auditor can export it.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={obj} onChange={(e) => setObj(e.target.value)} style={{ width: 'auto' }} aria-label="Record type">
          {OBJECTS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 'auto' }} aria-label="Change">
          <option value="">Created, changed and deleted</option>
          <option value="create">Created</option>
          <option value="update">Changed</option>
          <option value="delete">Deleted</option>
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} aria-label="To" />
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => download(`/api/v1/books/audit-trail?${qs}&limit=5000&format=csv`, 'books-audit-trail.csv').catch((e) => toast((e as Error).message, true))}>
          Export CSV
        </button>
      </div>
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '65vh' }}>
          <table className="data" data-export-title="Books audit trail">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="small">{r.actor}</td>
                  <td className="small">
                    <span className={`pill ${r.action === 'delete' ? 'bad' : r.action === 'create' ? 'good' : 'info'}`}>{r.action}</span>{' '}
                    {LINK[r.object_key] ? <a href={`${LINK[r.object_key]}${r.record_id}`}>{(OBJECTS.find(([k]) => k === r.object_key)?.[1] ?? r.object_key).replace(/s$/, '')}</a> : (OBJECTS.find(([k]) => k === r.object_key)?.[1] ?? r.object_key).replace(/s$/, '')}
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal', maxWidth: 640 }}>
                    {summary(r.changes, r.action)}
                  </td>
                </tr>
              ))}
              {!data.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No changes in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
