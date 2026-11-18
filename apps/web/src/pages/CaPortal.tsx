/**
 * The CA portal: what the business's chartered accountant sees when they sign in — its filings with
 * the conversation on each, the financial statements, GST and TDS returns, and the audit trail.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuditTrail } from '../components/books/AuditTrail';
import { Compliance } from '../components/books/Compliance';
import { TdsReturns } from '../components/books/TdsReturns';
import { Empty } from '../components/ui';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Reports } from './Books';

type Tab = 'filings' | 'statements' | 'tds' | 'audit' | 'documents';
const TABS: [Tab, string][] = [
  ['filings', 'Filings'],
  ['statements', 'Financial statements & GST'],
  ['tds', 'TDS returns'],
  ['audit', 'Audit trail'],
  ['documents', 'Invoices, bills & payments'],
];

export function CaPortalPage() {
  const { me, can } = useAuth();
  const [tab, setTab] = useState<Tab>(() => (TABS.find(([k]) => k === window.location.hash.slice(1))?.[0] ?? 'filings'));
  useEffect(() => window.history.replaceState(null, '', `#${tab}`), [tab]);
  const today = useQuery({ queryKey: ['ca', 'summary'], queryFn: () => get<Record<string, any>[]>(`/api/v1/books/compliance?from=2000-01-01&to=2999-12-31`), staleTime: 60_000 });
  if (!me) return null;
  if (!can('compliance') && !can('books')) return <Empty title="This portal is for the business's CA">Ask the workspace owner to invite you as their chartered accountant.</Empty>;
  const t = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const open = (today.data ?? []).filter((i) => ['pending', 'in_progress'].includes(i.status));
  const late = open.filter((i) => i.due_date < t).length;
  const week = open.filter((i) => i.due_date >= t && i.due_date <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)).length;
  return (
    <>
      <div className="hero">
        <div>
          <h1>{me.tenant.name}</h1>
          <p>Accountant portal · signed in as {me.user.fullName}</p>
        </div>
        <div className="stats">
          <div>
            <b>{late}</b>
            <span>filings overdue</span>
          </div>
          <div>
            <b>{week}</b>
            <span>due this week</span>
          </div>
          <div>
            <b>{open.filter((i) => i.assignee === me.user.fullName).length}</b>
            <span>assigned to you</span>
          </div>
        </div>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'filings' && <Compliance manage={can('books')} />}
          {tab === 'statements' && <Reports />}
          {tab === 'tds' && <TdsReturns />}
          {tab === 'audit' && <AuditTrail />}
          {tab === 'documents' && (
            <div className="home-grid">
              {[
                ['invoice', 'Sales invoices', 'Every invoice raised, with GST and the payments against it'],
                ['payment', 'Receipts', 'Money received from customers, with TDS and GST TDS deducted'],
                ['bill', 'Purchase bills', 'Vendor bills with input GST and TDS'],
                ['vendor_payment', 'Vendor payments', 'What was paid to vendors'],
                ['expense', 'Expenses', 'Expenses and claims'],
              ].map(([k, l, d]) => (
                <Link key={k} to={`/o/${k}`} className="panel hover" style={{ padding: 16, color: 'inherit' }}>
                  <b>{l}</b>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {d}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
