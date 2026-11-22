/**
 * Books: the accounting home. Overview, payables, banking, journals, chart of accounts,
 * reports, recurring transactions, budgets, fixed assets, GST / TDS and settings.
 */
import { BooksDashboard } from '../components/books/BooksDashboard';
import { SideTabs } from '../components/SideTabs';
import { ReminderSettings } from '../components/books/Reminders';
import { Compliance } from '../components/books/Compliance';
import { Payroll } from '../components/books/Payroll';
import { TdsReturns } from '../components/books/TdsReturns';
import { AuditTrail } from '../components/books/AuditTrail';
import { hasAdmin } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { BarChart } from '../components/charts';
import { useAct, VendorPaymentModal } from '../components/books/BookPanels';
import { useApps, useMetaReady } from '../components/ops/OrderPanel';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, download, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money2, moneyShort } from '../lib/format';
import { Deposits } from '../components/books/Deposits';
import { AccountsDesk } from '../components/books/AccountsDesk';
import { combineStatements, PdfPasswordError, readStatementFile, type StatementLine } from '../lib/statement';
import { Guide } from '../components/admin/ConnectionKeys';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const fyStart = (d = today()) => `${Number(d.slice(5, 7)) >= 4 ? d.slice(0, 4) : Number(d.slice(0, 4)) - 1}-04-01`;
const fyLabel = (d = today()) => {
  const y = Number(fyStart(d).slice(0, 4));
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
const SUBTYPES: [string, string, string][] = [
  ['cash', 'Cash', 'Asset'], ['bank', 'Bank', 'Asset'], ['accounts_receivable', 'Accounts receivable', 'Asset'], ['inventory', 'Stock', 'Asset'], ['current_asset', 'Other current asset', 'Asset'],
  ['tax_receivable', 'Tax receivable', 'Asset'], ['fixed_asset', 'Fixed asset', 'Asset'], ['accumulated_depreciation', 'Accumulated depreciation', 'Asset'], ['other_asset', 'Other asset', 'Asset'],
  ['credit_card', 'Credit card', 'Liability'], ['accounts_payable', 'Accounts payable', 'Liability'], ['current_liability', 'Other current liability', 'Liability'], ['tax_payable', 'Tax payable', 'Liability'],
  ['long_term_liability', 'Long-term liability', 'Liability'], ['other_liability', 'Other liability', 'Liability'],
  ['equity', 'Equity', 'Equity'], ['income', 'Income', 'Income'], ['other_income', 'Other income', 'Income'],
  ['cost_of_goods_sold', 'Cost of goods sold', 'Expense'], ['expense', 'Expense', 'Expense'], ['other_expense', 'Other expense', 'Expense'],
];
const subtypeLabel = (s: string) => SUBTYPES.find((x) => x[0] === s)?.[1] ?? s;
const SOURCE_LABEL: Record<string, string> = {
  manual: 'Journal', opening: 'Opening balance', invoice: 'Invoice', credit_note: 'Credit note', payment: 'Receipt', write_off: 'Write-off', bill: 'Bill', vendor_credit: 'Vendor credit',
  vendor_payment: 'Vendor payment', expense: 'Expense', reimbursement: 'Reimbursement', transfer: 'Transfer', bank: 'Bank entry', depreciation: 'Depreciation', asset_disposal: 'Asset disposal',
};
const SOURCE_LINK: Record<string, string> = { invoice: 'invoice', credit_note: 'invoice', write_off: 'invoice', payment: 'payment', bill: 'bill', vendor_credit: 'bill', vendor_payment: 'vendor_payment', expense: 'expense', reimbursement: 'expense' };

type Tab = 'overview' | 'desk' | 'compliance' | 'payables' | 'banking' | 'payroll' | 'journals' | 'accounts' | 'reports' | 'recurring' | 'budgets' | 'assets' | 'deposits' | 'gst' | 'tds' | 'audit' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['desk', 'Accounts desk'], ['compliance', 'Compliance'], ['payables', 'Payables'], ['banking', 'Banking'], ['payroll', 'Payroll'], ['journals', 'Journals'],
  ['accounts', 'Chart of accounts'], ['reports', 'Reports'], ['recurring', 'Recurring'], ['budgets', 'Budgets'], ['assets', 'Fixed assets'], ['deposits', 'Deposits & guarantees'], ['gst', 'GST & TDS'],
  ['tds', 'TDS returns'], ['audit', 'Audit trail'], ['settings', 'Settings'],
];

/** The Books menu, grouped down the left of the page. */
const BOOK_GROUPS: { label: string; items: Tab[] }[] = [
  { label: 'Daily work', items: ['overview', 'desk', 'banking', 'payables'] },
  { label: 'Compliance', items: ['compliance', 'gst', 'tds'] },
  { label: 'Accounting', items: ['journals', 'accounts', 'recurring', 'budgets', 'assets', 'deposits', 'payroll'] },
  { label: 'Reports', items: ['reports', 'audit'] },
  { label: 'Setup', items: ['settings'] },
];
const BOOK_ICON: Record<Tab, string> = {
  overview: 'gauge', desk: 'spark', banking: 'wallet', payables: 'receipt', compliance: 'stamp', gst: 'file', tds: 'rupee', journals: 'book', accounts: 'layers',
  recurring: 'repeat', budgets: 'target', assets: 'building', deposits: 'folder', payroll: 'users', reports: 'chart', audit: 'clock', settings: 'gear',
};

export function BooksPage() {
  const { me } = useAuth();
  const apps = useApps();
  const metaReady = useMetaReady();
  const loc = useLocation();
  // payroll lives in the business's own HRMS unless it chose to run it here
  const compSettings = useQuery({ queryKey: ['books', 'compliance-settings'], queryFn: () => get<Json>('/api/v1/books/compliance/settings'), retry: false, staleTime: 300_000 });
  const tabs = TABS.filter(([k]) => k !== 'payroll' || compSettings.data?.payrollHere);
  const [tab, setTab] = useState<Tab>(() => {
    // "#gst:2026-06" opens GST & TDS on that month
    const [h, arg] = window.location.hash.slice(1).split(':');
    if (h === 'gst' && arg)
      try {
        sessionStorage.setItem('books.gstMonth', arg);
      } catch {
        /* storage unavailable */
      }
    return TABS.find(([k]) => k === h)?.[0] ?? 'overview';
  });
  useEffect(() => {
    const on = () => {
      const h = window.location.hash.slice(1).split(':')[0];
      const t = TABS.find(([k]) => k === h)?.[0];
      setTab(t ?? 'overview');
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    on();
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, [loc.key]);
  if (!me) return null;
  if (!apps.has('books')) return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  if (!hasAdmin(me.permissions, 'books')) {
    return (
      <Empty title="Books needs the books permission">
        You can still file <Link to="/o/expense">expenses and claims</Link>.
      </Empty>
    );
  }
  const go = (t: Tab) => {
    setTab(t);
    if (window.location.hash !== `#${t}`) window.history.pushState(null, '', `#${t}`);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Books</h1>
          <p>Double-entry accounts posted straight from your invoices, receipts, bills and expenses.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/o/bill">
            Bills
          </Link>
          <Link className="btn" to="/o/expense">
            Expenses
          </Link>
        </div>
      </div>
      <SideTabs
        sync={false}
        id="books"
        title="Books"
        value={tab}
        onChange={go}
        items={BOOK_GROUPS.flatMap((g) => g.items.filter((k) => tabs.some(([t]) => t === k)).map((k) => ({ key: k, label: tabs.find(([t]) => t === k)![1], icon: BOOK_ICON[k], group: g.label })))}
      >

        <div className="panel-body">
          {tab === 'overview' && <Overview go={go} />}
          {tab === 'desk' && <AccountsDesk go={(t) => go(t as Tab)} />}
          {tab === 'payables' && <Payables />}
          {tab === 'banking' && <Banking />}
          {tab === 'journals' && <Journals />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'reports' && <Reports />}
          {tab === 'recurring' && <Recurring />}
          {tab === 'budgets' && <Budgets />}
          {tab === 'assets' && <Assets />}
          {tab === 'deposits' && <Deposits />}
          {tab === 'gst' && <GstTds />}
          {tab === 'compliance' && <Compliance />}
          {tab === 'payroll' && <Payroll />}
          {tab === 'tds' && <TdsReturns />}
          {tab === 'audit' && <AuditTrail />}
          {tab === 'settings' && <Settings />}
        </div>
      </SideTabs>
    </>
  );
}

function useAccounts() {
  return useQuery({ queryKey: ['books', 'accounts'], queryFn: () => get<Json[]>('/api/v1/books/accounts'), staleTime: 30_000 });
}

function AccountSelect({ value, onChange, filter, placeholder = 'Choose account', disabled }: { value: string; onChange: (v: string) => void; filter?: (a: Json) => boolean; placeholder?: string; disabled?: boolean }) {
  const { data } = useAccounts();
  const list = (data ?? []).filter((a) => a.is_active && (!filter || filter(a)));
  const groups = ['asset', 'liability', 'equity', 'income', 'expense'];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {groups.map((g) => {
        const xs = list.filter((a) => a.type === g);
        if (!xs.length) return null;
        return (
          <optgroup key={g} label={g[0]!.toUpperCase() + g.slice(1)}>
            {xs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code ? `${a.code} · ` : ''}
                {a.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="panel kpi">
      <div className="l">{label}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

/* ───────────────────────── overview ───────────────────────── */

function Overview({ go }: { go: (t: Tab) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['books', 'overview'], queryFn: () => get<Json>('/api/v1/books/overview') });
  const settings = useQuery({ queryKey: ['books', 'settings'], queryFn: () => get<Json>('/api/v1/books/settings') });
  if (isLoading || !data) return <Spinner />;
  const cfg = settings.data?.config;
  return (
    <div className="stack">
      {cfg && (!cfg.enabled || cfg.books_of_record !== 'synapse') && (
        <div className="notice">
          {!cfg.enabled ? 'Posting is off: documents are not posted to the ledger yet.' : 'Tally is the books of record: SanchalanOS does not post journals; use Tally sync.'}{' '}
          <button className="btn sm" onClick={() => go('settings')}>
            Settings
          </button>
        </div>
      )}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {data.pending.claims > 0 && (
          <Link className="chip warn" to="/o/expense">
            {data.pending.claims} claim(s) waiting for approval
          </Link>
        )}
        {data.pending.unmatched > 0 && (
          <button className="chip info" onClick={() => go('banking')}>
            {data.pending.unmatched} bank line(s) to match
          </button>
        )}
        {data.pending.drafts > 0 && (
          <Link className="chip" to="/o/bill">
            {data.pending.drafts} draft bill(s)
          </Link>
        )}
      </div>
      <BooksDashboard data={data} go={go} fy={fyLabel()} />
    </div>
  );
}

/* ───────────────────────── payables ───────────────────────── */

function Payables() {
  const { data } = useQuery({ queryKey: ['books', 'payables'], queryFn: () => get<Json[]>('/api/v1/books/payables') });
  const [pay, setPay] = useState<string | null>(null);
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const tot = (k: string) => data.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  return (
    <div className="stack">
      <div className="kpis" style={{ margin: 0 }}>
        <Kpi label="Owed to vendors" value={money2(tot('total'))} />
        <Kpi label="Not yet due" value={money2(tot('current'))} />
        <Kpi label="Overdue" value={money2(tot('total') - tot('current'))} tone={tot('total') - tot('current') > 0 ? 'bad' : undefined} />
      </div>
      {!data.length ? (
        <Empty title="Nothing owed">Posted bills with a balance show here, by age.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Vendor</th>
                <th className="num">Current</th>
                <th className="num">1–30</th>
                <th className="num">31–60</th>
                <th className="num">61–90</th>
                <th className="num">90+</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.vendorId}>
                  <td>
                    <Link to={`/o/vendor/${r.vendorId}`}>{r.vendor}</Link>
                  </td>
                  <td className="num">{money2(r.current)}</td>
                  <td className="num">{money2(r.d1_30)}</td>
                  <td className="num">{money2(r.d31_60)}</td>
                  <td className="num">{money2(r.d61_90)}</td>
                  <td className="num">{money2(r.d90)}</td>
                  <td className="num">
                    <b>{money2(r.total)}</b>
                  </td>
                  <td>
                    <button className="btn sm" onClick={() => setPay(r.vendorId)}>
                      Pay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pay && <VendorPaymentModal vendorId={pay} onClose={() => setPay(null)} onDone={() => qc.invalidateQueries({ queryKey: ['books'] })} />}
    </div>
  );
}

/* ───────────────────────── banking ───────────────────────── */

function Banking() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts') });
  const [sel, setSel] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'new' | 'transfer' | 'rules'>(null);
  const [card, setCard] = useState<Json | null>(null);
  const [removing, setRemoving] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const acc = data.find((a) => a.id === sel) ?? null;
  if (acc) return <BankAccountView acc={acc} back={() => { setSel(null); refetch(); }} />;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={() => setModal('new')}>
          Add account
        </button>
        <button className="btn" onClick={() => setModal('transfer')}>
          Transfer money
        </button>
        <button className="btn" onClick={() => setModal('rules')}>
          Bank rules
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              <th>Kind</th>
              <th className="num">In the books</th>
              <th className="num">Statement</th>
              <th className="num">Cleared</th>
              <th>Reconciled to</th>
              <th className="num">To match</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id} className="click" onClick={() => setSel(a.id)}>
                <td>
                  <b>{a.name}</b> {a.account_last4 && <span className="muted small">••{a.account_last4}</span>} {a.has_statement_password && <span className="chip" title="Statement PDF password saved">🔑</span>}
                  {a.kind === 'credit_card' && (
                    <div className="small muted">
                      {[
                        a.holder === 'personal' ? `Personal card of ${a.person_name ?? 'a partner'}` : 'Company card',
                        a.card_network ? a.card_network.toUpperCase() : null,
                        a.credit_limit ? `limit ${money2(a.credit_limit)} (${money2(Math.max(0, a.credit_limit + (a.book_balance || 0)))} free)` : null,
                        a.statement_day ? `statement on the ${a.statement_day}` : null,
                        a.due_day ? `due on the ${a.due_day}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </td>
                <td>
                  {a.kind.replace('_', ' ')}
                  {a.kind !== 'cash' && (
                    <button
                      className="btn sm ghost"
                      style={{ marginLeft: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCard(a);
                      }}
                    >
                      Details
                    </button>
                  )}
                </td>
                <td className="num">{money2(a.kind === 'credit_card' ? -a.book_balance || 0 : a.book_balance)}</td>
                <td className="num">{a.statement_balance == null ? '—' : money2(a.statement_balance)}</td>
                <td className="num">{money2(a.kind === 'credit_card' ? -a.cleared_balance || 0 : a.cleared_balance)}</td>
                <td>{date(a.reconciled_to)}</td>
                <td className="num">{a.unmatched ? <span className="chip warn">{a.unmatched}</span> : '—'}</td>
                <td className="num">
                  <button
                    className="btn sm ghost"
                    title="Remove this account (its history stays in the books)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRemoving(a);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal === 'new' && <NewBankAccount onClose={() => setModal(null)} onDone={() => refetch()} />}
      {card && <CardDetails acc={card} onClose={() => setCard(null)} onDone={() => refetch()} />}
      {modal === 'transfer' && <TransferModal accounts={data} onClose={() => setModal(null)} onDone={() => refetch()} />}
      {modal === 'rules' && <RulesModal accounts={data} onClose={() => setModal(null)} />}
      {removing && <RemoveAccount acc={removing} accounts={data} onClose={() => setRemoving(null)} onDone={() => refetch()} />}
    </div>
  );
}

const FAMILY: Record<string, string> = { bank: 'bank', wallet: 'bank', cash: 'cash', credit_card: 'credit_card' };

/**
 * Removes an account that isn't real or isn't used any more. Its past entries stay in the books;
 * a balance left on it moves to the account chosen (by a transfer entry), and so does its role as
 * the default account for its kind.
 */
function RemoveAccount({ acc, accounts, onClose, onDone }: { acc: Json; accounts: Json[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [moveToId, setMoveToId] = useState('');
  const [busy, setBusy] = useState(false);
  const balance = Math.round((Number(acc.book_balance) || 0) * 100) / 100;
  const shown = acc.kind === 'credit_card' ? -balance : balance;
  const others = accounts.filter((a) => a.id !== acc.id && FAMILY[a.kind] === FAMILY[acc.kind]);
  const needTarget = balance !== 0 || acc.is_default;
  return (
    <Modal
      title={`Remove ${acc.name}`}
      onClose={onClose}
      footer={
        <button
          className="btn danger"
          disabled={busy || (needTarget && !moveToId) || acc.unmatched > 0}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<Json>(`/api/v1/books/bank-accounts/${acc.id}/remove`, { moveToId: moveToId || null });
              toast(r.moved ? `Removed; ${money2(Math.abs(r.moved))} moved to the account chosen` : 'Removed');
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Removing…' : 'Remove the account'}
        </button>
      }
    >
      <div className="modal-body stack">
        <p className="small">
          It disappears from Banking and from the lists you pay from. Entries already posted to it stay in the books as they are (reports for past periods don't change).
        </p>
        {acc.unmatched > 0 && <p className="small" style={{ color: 'var(--bad)' }}>{acc.unmatched} statement line(s) on it are still to match: match or delete them first.</p>}
        {balance !== 0 && (
          <p className="small">
            It holds <b>{money2(shown)}</b> in the books — if those receipts and payments really went through another account, move the balance there. One transfer entry dated today does it.
          </p>
        )}
        {needTarget && (
          <label className="field">
            {balance !== 0 ? 'Move its balance' : 'Make this the default instead'}
            {acc.is_default && balance !== 0 ? ' (and its role as the default account)' : ''} to
            <select value={moveToId} onChange={(e) => setMoveToId(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.account_last4 ? ` ••${a.account_last4}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {acc.is_default && (
          <p className="small muted">
            "{acc.name}" is where the books put money when no account is named (a payment marked "bank", say). The account you choose takes over that role.
          </p>
        )}
      </div>
    </Modal>
  );
}

const NETWORKS: [string, string][] = [
  ['visa', 'Visa'],
  ['mastercard', 'Mastercard'],
  ['rupay', 'RuPay'],
  ['amex', 'American Express'],
  ['diners', 'Diners Club'],
  ['discover', 'Discover'],
  ['other', 'Other'],
];

/** Holder, network, limit and statement / due days of a card (shared by the add and details forms). */
function CardFields({ f, set, persons }: { f: Json; set: (p: Json) => void; persons: Json[] }) {
  return (
    <>
      <label className="field">
        Whose card
        <select value={f.holder} onChange={(e) => set({ holder: e.target.value })}>
          <option value="company">The company's</option>
          <option value="personal">A partner's / director's personal card</option>
        </select>
      </label>
      {f.holder === 'personal' ? (
        <label className="field">
          Card holder
          <select value={f.personId} onChange={(e) => set({ personId: e.target.value })}>
            <option value="">Choose…</option>
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!persons.length && <span className="small muted">Add partners and directors on the accounts desk → Own accounts first.</span>}
        </label>
      ) : (
        <span />
      )}
      <label className="field">
        Network
        <select value={f.network} onChange={(e) => set({ network: e.target.value })}>
          <option value="">—</option>
          {NETWORKS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Credit limit (₹)
        <input inputMode="decimal" value={f.creditLimit} onChange={(e) => set({ creditLimit: e.target.value })} />
      </label>
      <label className="field">
        Statement day (of the month)
        <input inputMode="numeric" value={f.statementDay} maxLength={2} onChange={(e) => set({ statementDay: e.target.value.replace(/\D/g, '') })} />
      </label>
      <label className="field">
        Payment due day
        <input inputMode="numeric" value={f.dueDay} maxLength={2} onChange={(e) => set({ dueDay: e.target.value.replace(/\D/g, '') })} />
      </label>
    </>
  );
}

const cardBody = (f: Json) => ({
  holder: f.holder,
  personId: f.holder === 'personal' ? f.personId || null : null,
  network: f.network || null,
  creditLimit: f.creditLimit ? Number(f.creditLimit) : null,
  statementDay: f.statementDay ? Number(f.statementDay) : null,
  dueDay: f.dueDay ? Number(f.dueDay) : null,
});

function usePersons() {
  const { data } = useQuery({ queryKey: ['books', 'own'], queryFn: () => get<Json>('/api/v1/books/desk/own') });
  return ((data?.persons ?? []) as Json[]).filter((p) => p.is_active !== false);
}

function NewBankAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const persons = usePersons();
  const [f, setF] = useState<Json>({ name: '', kind: 'bank', bankName: '', last4: '', ifsc: '', holder: 'company', personId: '', network: '', creditLimit: '', statementDay: '', dueDay: '' });
  return (
    <Modal
      title="Add bank, cash or card account"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || (f.kind === 'credit_card' && f.holder === 'personal' && !f.personId)}
          onClick={async () => {
            try {
              await post('/api/v1/books/bank-accounts', {
                name: f.name.trim(),
                kind: f.kind,
                bankName: f.bankName || null,
                last4: f.last4 || null,
                ifsc: f.ifsc.toUpperCase() || null,
                ...(f.kind === 'credit_card' ? cardBody(f) : {}),
              });
              toast('Account added');
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Add
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Name in the books
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === 'credit_card' ? 'HDFC Regalia 9814' : 'HDFC current account'} autoFocus />
        </label>
        <label className="field">
          Kind
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
            <option value="credit_card">Credit card</option>
            <option value="wallet">Wallet / gateway</option>
          </select>
        </label>
        <label className="field">
          {f.kind === 'credit_card' ? 'Issuing bank' : 'Bank'}
          <input value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
        </label>
        <label className="field">
          Last 4 digits {f.kind === 'credit_card' && <span className="muted small">(receipts are matched to the card by these)</span>}
          <input value={f.last4} maxLength={4} inputMode="numeric" onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '') })} />
        </label>
        {f.kind === 'credit_card' ? (
          <CardFields f={f} set={(p) => setF({ ...f, ...p })} persons={persons} />
        ) : (
          <label className="field">
            IFSC
            <input value={f.ifsc} maxLength={11} onChange={(e) => setF({ ...f, ifsc: e.target.value })} />
          </label>
        )}
      </div>
      {f.kind === 'credit_card' && (
        <p className="small muted" style={{ margin: '0 16px 12px' }}>
          Spend on a personal card is still the business's: bills paid with it are owed to the card, and when the holder pays the card's bill you settle it to them (it becomes money the business owes them).
        </p>
      )}
    </Modal>
  );
}

function CardDetails({ acc, onClose, onDone }: { acc: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const persons = usePersons();
  const [f, setF] = useState<Json>({
    bankName: acc.bank_name ?? '',
    last4: acc.account_last4 ?? '',
    holder: acc.holder ?? 'company',
    personId: acc.person_id ?? '',
    network: acc.card_network ?? '',
    creditLimit: acc.credit_limit != null ? String(acc.credit_limit) : '',
    statementDay: acc.statement_day ? String(acc.statement_day) : '',
    dueDay: acc.due_day ? String(acc.due_day) : '',
    password: '',
    clearPassword: false,
    senders: acc.statement_senders ?? '',
  });
  const owed = acc.kind === 'credit_card' ? -(acc.book_balance || 0) : 0;
  const [settle, setSettle] = useState({ amount: owed > 0 ? String(owed) : '', date: today() });
  const card = acc.kind === 'credit_card';
  return (
    <Modal
      title={acc.name}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await put(`/api/v1/books/bank-accounts/${acc.id}`, {
                bankName: f.bankName || null,
                last4: f.last4 || null,
                ...(card ? cardBody(f) : {}),
                ...(f.password ? { statementPassword: f.password } : f.clearPassword ? { statementPassword: null } : {}),
                statementSenders: f.senders.trim() || null,
              });
              toast('Saved');
              onDone();
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
      <div className="modal-body grid2">
        <label className="field">
          {card ? 'Issuing bank' : 'Bank'}
          <input value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
        </label>
        <label className="field">
          Last 4 digits
          <input value={f.last4} maxLength={4} inputMode="numeric" onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '') })} />
        </label>
        {card && <CardFields f={f} set={(p) => setF({ ...f, ...p })} persons={persons} />}
        <label className="field">
          Statement PDF password
          <input
            type="password"
            autoComplete="new-password"
            value={f.password}
            placeholder={acc.has_statement_password && !f.clearPassword ? 'Saved — type to change' : 'e.g. first 4 letters of name + DDMM'}
            onChange={(e) => setF({ ...f, password: e.target.value, clearPassword: false })}
          />
          <span className="small muted">
            Kept encrypted; used to open the statements that come by mail.{' '}
            {acc.has_statement_password && !f.clearPassword && (
              <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, password: '', clearPassword: true })}>
                Remove it
              </button>
            )}
          </span>
        </label>
        <label className="field">
          Statement mails come from
          <input value={f.senders} onChange={(e) => setF({ ...f, senders: e.target.value })} placeholder="e.g. hdfcbank.net, cc.statements@axisbank.com" />
          <span className="small muted">Optional: helps pick this account when the mail does not show its last four digits.</span>
        </label>
      </div>
      {card && acc.holder === 'personal' && (
        <div className="panel" style={{ margin: '0 16px 12px', padding: 12 }}>
          <b>{acc.person_name ?? 'The holder'} paid this card's bill</b>
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            The business owes {money2(Math.max(0, owed))} on this card. What the holder paid from their own pocket moves to their account (money the business owes them).
          </p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input inputMode="decimal" style={{ width: 140 }} value={settle.amount} onChange={(e) => setSettle({ ...settle, amount: e.target.value })} aria-label="Amount" />
            <input type="date" style={{ width: 160 }} value={settle.date} onChange={(e) => setSettle({ ...settle, date: e.target.value })} aria-label="Date" />
            <button
              className="btn"
              disabled={!(Number(settle.amount) > 0)}
              onClick={async () => {
                try {
                  await post(`/api/v1/books/bank-accounts/${acc.id}/settle`, { amount: Number(settle.amount), date: settle.date });
                  toast(`Moved to ${acc.person_name ?? 'the holder'}'s account`);
                  onDone();
                  onClose();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Settle to {acc.person_name ?? 'holder'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TransferModal({ accounts, onClose, onDone }: { accounts: Json[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ fromId: '', toId: '', amount: '', date: today(), reference: '' });
  return (
    <Modal
      title="Transfer between accounts"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.fromId || !f.toId || f.fromId === f.toId || !(Number(f.amount) > 0)}
          onClick={async () => {
            try {
              await post('/api/v1/books/transfers', { fromId: f.fromId, toId: f.toId, amount: Number(f.amount), date: f.date, reference: f.reference || null });
              toast('Transfer recorded');
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Record transfer
        </button>
      }
    >
      <div className="modal-body grid2">
        {(['fromId', 'toId'] as const).map((k) => (
          <label className="field" key={k}>
            {k === 'fromId' ? 'From' : 'To'}
            <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
              <option value="">Choose</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.gl_account_id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="field">
          Amount (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field wide">
          Reference
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

function RulesModal({ accounts, onClose }: { accounts: Json[]; onClose: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ['books', 'bank-rules'], queryFn: () => get<Json[]>('/api/v1/books/bank-rules') });
  const toast = useToast();
  const blank = { name: '', contains: '', direction: 'out', accountId: '', bankAccountId: '' };
  const [f, setF] = useState(blank);
  return (
    <Modal title="Bank rules" onClose={onClose} wide>
      <div className="modal-body stack">
        <p className="muted small">When a statement line's description contains the text, it is posted to the account automatically on import (or with “Auto-match &amp; rules”).</p>
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contains</th>
              <th>Direction</th>
              <th>Post to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>“{r.contains}”</td>
                <td>{r.direction === 'in' ? 'Money in' : r.direction === 'out' ? 'Money out' : 'Either'}</td>
                <td>{r.account}</td>
                <td>
                  <button className="btn sm ghost" onClick={async () => { await del(`/api/v1/books/bank-rules/${r.id}`); refetch(); }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid2">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Electricity" />
          </label>
          <label className="field">
            Description contains
            <input value={f.contains} onChange={(e) => setF({ ...f, contains: e.target.value })} placeholder="MSEDCL" />
          </label>
          <label className="field">
            Direction
            <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
              <option value="any">Either</option>
            </select>
          </label>
          <label className="field">
            Post to
            <AccountSelect value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} filter={(a) => !['accounts_receivable', 'accounts_payable'].includes(a.subtype)} />
          </label>
          <label className="field">
            Only for
            <select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
              <option value="">Every account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <button
            className="btn primary"
            disabled={!f.name.trim() || f.contains.trim().length < 2 || !f.accountId}
            onClick={async () => {
              try {
                await post('/api/v1/books/bank-rules', { ...f, bankAccountId: f.bankAccountId || null });
                setF(blank);
                refetch();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Add rule
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BankAccountView({ acc, back }: { acc: Json; back: () => void }) {
  const [status, setStatus] = useState('unmatched');
  const [mode, setMode] = useState<'lines' | 'reconcile'>('lines');
  const toast = useToast();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['books', 'bank-txns', acc.id, status], queryFn: () => get<Json[]>(`/api/v1/books/bank-accounts/${acc.id}/transactions?status=${status}`) });
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['books'] });
  };
  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="row">
          <button className="btn sm ghost" onClick={back}>
            ← Accounts
          </button>
          <h2 style={{ margin: 0 }}>{acc.name}</h2>
        </div>
        <Guide id="bank_statements" label="Statements, feeds and passwords" />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="btn sm">
            Import statements (PDF / Excel / CSV)
            <input
              type="file"
              multiple
              accept=".pdf,.csv,.tsv,.txt,.xls,.xlsx,application/pdf,text/csv"
              hidden
              onChange={async (e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (!list.length) return;
                const read: { name: string; lines: StatementLine[] }[] = [];
                for (const file of list) {
                  let password: string | undefined;
                  for (;;) {
                    try {
                      read.push({ name: file.name, lines: await readStatementFile(file, { password, card: acc.kind === 'credit_card' }) });
                      break;
                    } catch (err) {
                      if (err instanceof PdfPasswordError) {
                        const pw = window.prompt(`${file.name} is password-protected${err.wrong ? ' (that password was wrong)' : ''}. Statement password:`);
                        if (pw) {
                          password = pw;
                          continue;
                        }
                      } else toast(`${file.name}: ${(err as Error).message}`, true);
                      break;
                    }
                  }
                }
                const { lines: rows } = combineStatements(read);
                if (!rows.length) return toast('No lines found. The file needs a header row with Date, Narration / Description and Amount (or Debit / Credit).', true);
                try {
                  let added = 0, skipped = 0, matched = 0, cat = 0;
                  for (let i = 0; i < rows.length; i += 5000) {
                    const r = await post<Json>(`/api/v1/books/bank-accounts/${acc.id}/statement`, { rows: rows.slice(i, i + 5000) });
                    added += r.added; skipped += r.skipped; matched += r.autoMatched; cat += r.autoCategorized;
                  }
                  toast(`${added} line(s) imported from ${read.length} file(s), ${skipped} already there; ${matched} matched and ${cat} categorised automatically`);
                  refresh();
                } catch (err) {
                  toast((err as Error).message, true);
                }
              }}
            />
          </label>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await post<Json>(`/api/v1/books/bank-accounts/${acc.id}/auto`);
              toast(`${r.matched} matched, ${r.categorized} categorised by rules`);
              refresh();
            }}
          >
            Auto-match &amp; rules
          </button>
          <button className={`btn sm${mode === 'reconcile' ? ' primary' : ''}`} onClick={() => setMode(mode === 'reconcile' ? 'lines' : 'reconcile')}>
            Reconcile
          </button>
        </div>
      </div>
      {mode === 'reconcile' ? (
        <Reconcile acc={acc} done={() => { setMode('lines'); refresh(); }} />
      ) : (
        <>
          <div className="row">
            {['unmatched', 'matched', 'categorized', 'excluded', 'all'].map((s) => (
              <button key={s} className={`btn sm${status === s ? ' primary' : ' ghost'}`} onClick={() => setStatus(s)}>
                {s}
              </button>
            ))}
          </div>
          {!data ? (
            <Spinner />
          ) : !data.length ? (
            <Empty title={status === 'unmatched' ? 'All caught up' : 'Nothing here'}>{status === 'unmatched' ? 'Import a statement to match it with the books.' : null}</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th>In the books</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((t) => (
                  <>
                    <tr key={t.id}>
                      <td>{date(t.txn_date)}</td>
                      <td title={t.description}>
                        {t.description} {t.reference && <span className="muted small">{t.reference}</span>}
                      </td>
                      <td className="num">{t.amount > 0 ? money2(t.amount) : ''}</td>
                      <td className="num">{t.amount < 0 ? money2(-t.amount) : ''}</td>
                      <td>{t.journal_number || t.source_type ? <span className="small">{SOURCE_LABEL[t.source_type] ?? t.source_type} {t.journal_number ?? ''}</span> : <span className="muted small">{t.status}</span>}</td>
                      <td>
                        {t.status === 'unmatched' ? (
                          <button className="btn sm" onClick={() => setOpen(open === t.id ? null : t.id)}>
                            {open === t.id ? 'Close' : 'Match / categorise'}
                          </button>
                        ) : (
                          <button
                            className="btn sm ghost"
                            onClick={async () => {
                              try {
                                await post(`/api/v1/books/bank-transactions/${t.id}/undo`);
                                refresh();
                              } catch (e) {
                                toast((e as Error).message, true);
                              }
                            }}
                          >
                            Undo
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === t.id && (
                      <tr key={`${t.id}-x`}>
                        <td colSpan={6} style={{ whiteSpace: 'normal', maxWidth: 'none', background: '#f7fafb' }}>
                          <MatchTxn txn={t} done={() => { setOpen(null); refresh(); }} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function MatchTxn({ txn, done }: { txn: Json; done: () => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['books', 'suggest', txn.id], queryFn: () => get<Json[]>(`/api/v1/books/bank-transactions/${txn.id}/suggestions`) });
  const { data: accts } = useAccounts();
  const [f, setF] = useState({ accountId: '', partyType: '', partyId: '' });
  const party = (accts ?? []).find((a) => a.id === f.accountId);
  const needsParty = party && ['accounts_receivable', 'accounts_payable'].includes(party.subtype);
  const parties = useQuery({
    queryKey: ['books', 'parties', party?.subtype],
    queryFn: () => get<{ items: Json[] }>(`/api/v1/records/${party?.subtype === 'accounts_payable' ? 'vendor' : 'account'}?limit=200&sort=name&dir=asc`),
    enabled: !!needsParty,
  });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      done();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack" style={{ padding: 8 }}>
      <div>
        <b>Matches in the books</b>
        {!data ? (
          <Spinner />
        ) : !data.length ? (
          <p className="muted small">No posted entry with this amount within 15 days.</p>
        ) : (
          <table className="data">
            <tbody>
              {data.map((s) => (
                <tr key={s.line_id}>
                  <td>{date(s.entry_date)}</td>
                  <td>
                    {SOURCE_LABEL[s.source_type] ?? s.source_type} {s.number ?? s.reference ?? ''}
                  </td>
                  <td className="small muted">{s.narration}</td>
                  <td className="num">{money2(s.debit || s.credit)}</td>
                  <td>
                    <button className="btn sm primary" onClick={() => run(() => post(`/api/v1/books/bank-transactions/${txn.id}/match`, { lineId: s.line_id }))}>
                      Match
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 260 }}>
          Or post to
          <AccountSelect value={f.accountId} onChange={(v) => setF({ ...f, accountId: v, partyId: '' })} />
        </label>
        {needsParty && (
          <label className="field" style={{ minWidth: 220 }}>
            {party.subtype === 'accounts_payable' ? 'Vendor' : 'Customer'}
            <select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}>
              <option value="">Choose</option>
              {(parties.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="btn primary"
          disabled={!f.accountId || (needsParty && !f.partyId)}
          onClick={() => run(() => post(`/api/v1/books/bank-transactions/${txn.id}/categorize`, { accountId: f.accountId, partyType: needsParty ? (party.subtype === 'accounts_payable' ? 'vendor' : 'customer') : null, partyId: f.partyId || null }))}
        >
          Categorise
        </button>
        <button className="btn ghost" onClick={() => run(() => post(`/api/v1/books/bank-transactions/${txn.id}/exclude`))}>
          Exclude
        </button>
      </div>
    </div>
  );
}

function Reconcile({ acc, done }: { acc: Json; done: () => void }) {
  const toast = useToast();
  const [upTo, setUpTo] = useState(today());
  const [closing, setClosing] = useState(acc.statement_balance != null ? String(acc.statement_balance) : '');
  const { data } = useQuery({ queryKey: ['books', 'unrec', acc.id, upTo], queryFn: () => get<Json>(`/api/v1/books/bank-accounts/${acc.id}/unreconciled?upTo=${upTo}`) });
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const lines = (data?.lines ?? []) as Json[];
  const sel = ticked ?? new Set(lines.filter((l) => l.bank_txn_id).map((l) => l.id as string));
  const sign = acc.kind === 'credit_card' ? -1 : 1;
  const cleared = Math.round(((data?.clearedBalance ?? 0) + lines.filter((l) => sel.has(l.id)).reduce((s, l) => s + l.debit - l.credit, 0)) * sign * 100) / 100;
  const diff = Math.round((Number(closing || 0) - cleared) * 100) / 100;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          Statement date
          <input type="date" value={upTo} onChange={(e) => { setUpTo(e.target.value); setTicked(null); }} />
        </label>
        <label className="field">
          Closing balance on the statement
          <input inputMode="decimal" value={closing} onChange={(e) => setClosing(e.target.value)} />
        </label>
        <div className="kpi panel" style={{ padding: '8px 14px' }}>
          <div className="l">Cleared</div>
          <div className="v" style={{ fontSize: 18 }}>{money2(cleared)}</div>
        </div>
        <div className="kpi panel" style={{ padding: '8px 14px' }}>
          <div className="l">Difference</div>
          <div className={`v tone-${diff === 0 ? 'good' : 'bad'}`} style={{ fontSize: 18 }}>
            {money2(diff)}
          </div>
        </div>
        <button
          className="btn primary"
          disabled={diff !== 0 || closing === ''}
          onClick={async () => {
            try {
              await post(`/api/v1/books/bank-accounts/${acc.id}/reconcile`, { statementDate: upTo, closingBalance: Number(closing), lineIds: [...sel] });
              toast('Reconciled');
              done();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Finish reconciliation
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            if (!window.confirm('Undo the last reconciliation of this account?')) return;
            try {
              await post(`/api/v1/books/bank-accounts/${acc.id}/undo-reconciliation`);
              toast('Last reconciliation undone');
              done();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Undo last
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th style={{ width: 30 }}>
              <input type="checkbox" checked={lines.length > 0 && sel.size === lines.length} onChange={(e) => setTicked(new Set(e.target.checked ? lines.map((l) => l.id) : []))} aria-label="Select all" />
            </th>
            <th>Date</th>
            <th>Entry</th>
            <th className="num">Deposit</th>
            <th className="num">Withdrawal</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="checkbox"
                  checked={sel.has(l.id)}
                  onChange={(e) => {
                    const n = new Set(sel);
                    if (e.target.checked) n.add(l.id);
                    else n.delete(l.id);
                    setTicked(n);
                  }}
                  aria-label="Cleared"
                />
              </td>
              <td>{date(l.entry_date)}</td>
              <td>
                {SOURCE_LABEL[l.source_type] ?? l.source_type} {l.number ?? l.reference ?? ''} <span className="muted small">{l.narration}</span>
              </td>
              <td className="num">{l.debit ? money2(l.debit) : ''}</td>
              <td className="num">{l.credit ? money2(l.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── journals ───────────────────────── */

function Journals() {
  const [q, setQ] = useState({ from: fyStart(), to: today(), source: '', search: '' });
  const qs = new URLSearchParams({ from: q.from, to: q.to, ...(q.source ? { source: q.source } : {}), ...(q.search ? { q: q.search } : {}), limit: '200' }).toString();
  const { data, refetch } = useQuery({ queryKey: ['books', 'journals', qs], queryFn: () => get<Json[]>(`/api/v1/books/journals?${qs}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState<null | 'journal' | 'opening'>(null);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          From
          <input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        </label>
        <label className="field">
          To
          <input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} />
        </label>
        <label className="field">
          Type
          <select value={q.source} onChange={(e) => setQ({ ...q, source: e.target.value })}>
            <option value="">All</option>
            {Object.entries(SOURCE_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Search
          <input value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} placeholder="Number, reference, narration" />
        </label>
        <button className="btn primary" onClick={() => setCreate('journal')}>
          New journal
        </button>
        <button className="btn" onClick={() => setCreate('opening')}>
          Opening balances
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="No entries in this range" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Number</th>
              <th>Type</th>
              <th>Reference</th>
              <th>Narration</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((j) => (
              <tr key={j.id} className="click" onClick={() => setOpen(j.id)}>
                <td>{date(j.entry_date)}</td>
                <td>{j.number ?? '—'}</td>
                <td>{SOURCE_LABEL[j.source_type] ?? j.source_type}</td>
                <td>{j.reference}</td>
                <td title={j.narration}>{j.narration}</td>
                <td className="num">{money2(j.total)}</td>
                <td>{j.status === 'void' ? <span className="chip bad">void</span> : <span className="chip good">posted</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <JournalModal id={open} onClose={() => { setOpen(null); refetch(); }} />}
      {create === 'journal' && <JournalForm onClose={() => { setCreate(null); refetch(); }} />}
      {create === 'opening' && <OpeningForm onClose={() => { setCreate(null); refetch(); }} />}
    </div>
  );
}

function JournalModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['books', 'journal', id], queryFn: () => get<Json>(`/api/v1/books/journals/${id}`) });
  const act = useAct([['books']]);
  if (!data) return null;
  const own = ['manual', 'opening', 'depreciation'].includes(data.source_type);
  const link = SOURCE_LINK[data.source_type];
  return (
    <Modal
      title={`${SOURCE_LABEL[data.source_type] ?? data.source_type} ${data.number ?? data.reference ?? ''}`}
      onClose={onClose}
      wide
      footer={
        data.status === 'posted' && own ? (
          <>
            {data.source_type === 'manual' && (
              <button className="btn" onClick={async () => { const d = window.prompt('Reverse on which date? (YYYY-MM-DD)', today()); if (d && (await act(() => post(`/api/v1/books/journals/${id}/reverse`, { date: d }), 'Reversal posted'))) onClose(); }}>
                Reverse
              </button>
            )}
            <button className="btn danger" onClick={async () => { const r = window.prompt('Why void this entry?'); if (r && r.trim().length >= 3 && (await act(() => post(`/api/v1/books/journals/${id}/void`, { reason: r.trim() }), 'Voided'))) onClose(); }}>
              Void
            </button>
          </>
        ) : undefined
      }
    >
      <div className="modal-body stack">
        <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
          <span>{date(data.entry_date)}</span>
          {data.status === 'void' && <span className="chip bad">Void: {data.void_reason}</span>}
          {link && data.source_id && <Link to={`/o/${link}/${data.source_id}`}>Open the document</Link>}
          {data.narration && <span className="muted">{data.narration}</span>}
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              <th>Party</th>
              <th>Note</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {(data.lines as Json[]).map((l) => (
              <tr key={l.id}>
                <td>
                  {l.code ? `${l.code} · ` : ''}
                  {l.account} {l.reconciled && <span className="chip good">cleared</span>}
                </td>
                <td>{l.party}</td>
                <td className="small muted">{l.description}</td>
                <td className="num">{l.debit ? money2(l.debit) : ''}</td>
                <td className="num">{l.credit ? money2(l.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

interface JLine {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  partyId: string;
}
const blankLine = (): JLine => ({ accountId: '', debit: '', credit: '', description: '', partyId: '' });

function JournalForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: accts } = useAccounts();
  const [f, setF] = useState({ date: today(), reference: '', narration: '' });
  const [lines, setLines] = useState<JLine[]>([blankLine(), blankLine()]);
  const customers = useQuery({ queryKey: ['books', 'parties', 'accounts_receivable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/account?limit=200&sort=name&dir=asc') });
  const vendors = useQuery({ queryKey: ['books', 'parties', 'accounts_payable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200&sort=name&dir=asc') });
  const d = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const c = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const subtypeOf = (id: string) => (accts ?? []).find((a) => a.id === id)?.subtype;
  return (
    <Modal
      title="New journal"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={Math.abs(d - c) > 0.001 || d === 0}
          onClick={async () => {
            try {
              await post('/api/v1/books/journals', {
                ...f,
                reference: f.reference || null,
                narration: f.narration || null,
                lines: lines
                  .filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)))
                  .map((l) => {
                    const st = subtypeOf(l.accountId);
                    const partyType = st === 'accounts_receivable' ? 'customer' : st === 'accounts_payable' ? 'vendor' : null;
                    return { accountId: l.accountId, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined, description: l.description || null, partyType, partyId: partyType ? l.partyId || null : null };
                  }),
              });
              toast('Journal posted');
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Post journal
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Date
            <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </label>
          <label className="field">
            Reference
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </label>
          <label className="field wide">
            Narration
            <input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} />
          </label>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              <th>Customer / vendor</th>
              <th>Note</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const st = subtypeOf(l.accountId);
              const parties = st === 'accounts_receivable' ? customers.data?.items : st === 'accounts_payable' ? vendors.data?.items : null;
              const set = (p: Partial<JLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <AccountSelect value={l.accountId} onChange={(v) => set({ accountId: v, partyId: '' })} />
                  </td>
                  <td>
                    {parties ? (
                      <select value={l.partyId} onChange={(e) => set({ partyId: e.target.value })}>
                        <option value="">Choose</option>
                        {parties.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <input value={l.description} onChange={(e) => set({ description: e.target.value })} />
                  </td>
                  <td style={{ width: 120 }}>
                    <input inputMode="decimal" value={l.debit} onChange={(e) => set({ debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
                  </td>
                  <td style={{ width: 120 }}>
                    <input inputMode="decimal" value={l.credit} onChange={(e) => set({ credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
                  </td>
                  <td>
                    {lines.length > 2 && (
                      <button className="btn sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={3}>
                <button className="btn sm" onClick={() => setLines([...lines, blankLine()])}>
                  Add line
                </button>
              </td>
              <td className="num">
                <b>{money2(d)}</b>
              </td>
              <td className="num">
                <b>{money2(c)}</b>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
        {Math.abs(d - c) > 0.001 && <p className="small" style={{ color: 'var(--bad)' }}>Debits and credits differ by {money2(Math.abs(d - c))}.</p>}
      </div>
    </Modal>
  );
}

function OpeningForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: accts } = useAccounts();
  const settings = useQuery({ queryKey: ['books', 'settings'], queryFn: () => get<Json>('/api/v1/books/settings') });
  const existing = useQuery({ queryKey: ['books', 'opening'], queryFn: () => get<Json | null>('/api/v1/books/opening-balances') });
  const customers = useQuery({ queryKey: ['books', 'parties', 'accounts_receivable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/account?limit=200&sort=name&dir=asc') });
  const vendors = useQuery({ queryKey: ['books', 'parties', 'accounts_payable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200&sort=name&dir=asc') });
  const bsAccounts = (accts ?? []).filter((a) => a.is_active && ['asset', 'liability', 'equity'].includes(a.type) && !['accounts_receivable', 'accounts_payable'].includes(a.subtype) && a.system_key !== 'opening_equity');
  const initial = useMemo(() => {
    const acc: Record<string, string> = {};
    const cust: Record<string, string> = {};
    const ven: Record<string, string> = {};
    for (const l of (existing.data?.lines ?? []) as Json[]) {
      const a = (accts ?? []).find((x) => x.id === l.account_id);
      if (!a || a.system_key === 'opening_equity') continue;
      const net = l.debit - l.credit;
      if (a.subtype === 'accounts_receivable' && l.party_id) cust[l.party_id] = String(net);
      else if (a.subtype === 'accounts_payable' && l.party_id) ven[l.party_id] = String(-net);
      else acc[l.account_id] = String(a.type === 'asset' ? net : -net);
    }
    return { acc, cust, ven };
  }, [existing.data, accts]);
  const [vals, setVals] = useState<typeof initial | null>(null);
  const v = vals ?? initial;
  if (!accts || existing.isLoading) return null;
  const start = settings.data?.config?.start_date;
  return (
    <Modal
      title="Opening balances"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await put('/api/v1/books/opening-balances', {
                accounts: Object.entries(v.acc)
                  .filter(([, x]) => Number(x))
                  .map(([accountId, x]) => {
                    const a = accts.find((y) => y.id === accountId)!;
                    const n = Number(x);
                    const debitSide = a.type === 'asset' ? n > 0 : n < 0;
                    return { accountId, ...(debitSide ? { debit: Math.abs(n) } : { credit: Math.abs(n) }) };
                  }),
                customers: Object.entries(v.cust).filter(([, x]) => Number(x)).map(([partyId, x]) => ({ partyId, amount: Number(x) })),
                vendors: Object.entries(v.ven).filter(([, x]) => Number(x)).map(([partyId, x]) => ({ partyId, amount: Number(x) })),
              });
              toast('Opening balances saved');
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save opening balances
        </button>
      }
    >
      <div className="modal-body stack">
        <p className="muted small">Balances as at the close of the day before the books start{start ? ` (${date(start)})` : ''}. Any difference goes to Opening balance equity. Saving replaces earlier opening balances.</p>
        <h3 style={{ margin: 0 }}>Accounts</h3>
        <table className="data">
          <tbody>
            {bsAccounts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name} <span className="muted small">{subtypeLabel(a.subtype)}</span>
                </td>
                <td style={{ width: 160 }}>
                  <input inputMode="decimal" value={v.acc[a.id] ?? ''} onChange={(e) => setVals({ ...v, acc: { ...v.acc, [a.id]: e.target.value } })} placeholder="0" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 style={{ margin: 0 }}>Customers who owe you</h3>
        <PartyAmounts items={customers.data?.items ?? []} values={v.cust} onChange={(cust) => setVals({ ...v, cust })} />
        <h3 style={{ margin: 0 }}>Vendors you owe</h3>
        <PartyAmounts items={vendors.data?.items ?? []} values={v.ven} onChange={(ven) => setVals({ ...v, ven })} />
      </div>
    </Modal>
  );
}

function PartyAmounts({ items, values, onChange }: { items: Json[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [filter, setFilter] = useState('');
  const shown = items.filter((p) => values[p.id] || !filter || String(p.title).toLowerCase().includes(filter.toLowerCase())).slice(0, 50);
  return (
    <div className="stack">
      <input placeholder="Find…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
      <table className="data">
        <tbody>
          {shown.map((p) => (
            <tr key={p.id}>
              <td>{p.title}</td>
              <td style={{ width: 160 }}>
                <input inputMode="decimal" value={values[p.id] ?? ''} onChange={(e) => onChange({ ...values, [p.id]: e.target.value })} placeholder="0" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── chart of accounts ───────────────────────── */

function Accounts() {
  const [all, setAll] = useState(false);
  const { data, refetch } = useQuery({ queryKey: ['books', 'accounts', all], queryFn: () => get<Json[]>(`/api/v1/books/accounts${all ? '?all=1' : ''}`) });
  const [edit, setEdit] = useState<Json | null>(null);
  const [filter, setFilter] = useState('');
  const toast = useToast();
  if (!data) return <Spinner />;
  const shown = data.filter((a) => !filter || `${a.code ?? ''} ${a.name}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => setEdit({})}>
          New account
        </button>
        <input placeholder="Find an account" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
        <label className="row small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show inactive
        </label>
      </div>
      {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => {
        const xs = shown.filter((a) => a.type === t);
        if (!xs.length) return null;
        return (
          <div key={t}>
            <h3 style={{ textTransform: 'capitalize', margin: '8px 0' }}>{t === 'liability' ? 'Liabilities' : t === 'equity' ? 'Equity' : `${t}s`}</h3>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="num">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {xs.map((a) => {
                  const bal = ['asset', 'expense'].includes(a.type) ? a.debit - a.credit : a.credit - a.debit;
                  return (
                    <tr key={a.id} style={a.is_active ? undefined : { opacity: 0.5 }}>
                      <td>{a.code}</td>
                      <td>
                        {a.parent_id && <span className="muted">↳ </span>}
                        {a.name} {a.system_key && <span className="chip" title="Used by automatic postings">system</span>}
                      </td>
                      <td>{subtypeLabel(a.subtype)}</td>
                      <td className="num">{money2(bal)}</td>
                      <td>
                        <button className="btn sm ghost" onClick={() => setEdit(a)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      {edit && (
        <AccountForm
          acc={edit}
          accounts={data}
          onClose={() => setEdit(null)}
          onSave={async (body, remove) => {
            try {
              if (remove) await del(`/api/v1/books/accounts/${edit.id}`);
              else if (edit.id) await patch(`/api/v1/books/accounts/${edit.id}`, body);
              else await post('/api/v1/books/accounts', body);
              toast(remove ? 'Account deleted' : 'Saved');
              setEdit(null);
              refetch();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        />
      )}
    </div>
  );
}

function AccountForm({ acc, accounts, onClose, onSave }: { acc: Json; accounts: Json[]; onClose: () => void; onSave: (body: Json, remove?: boolean) => void }) {
  const [f, setF] = useState({ code: acc.code ?? '', name: acc.name ?? '', subtype: acc.subtype ?? 'expense', parentId: acc.parent_id ?? '', description: acc.description ?? '', isActive: acc.is_active ?? true });
  const group = SUBTYPES.find((s) => s[0] === f.subtype)?.[2];
  const sys = !!acc.system_key;
  return (
    <Modal
      title={acc.id ? `Edit ${acc.name}` : 'New account'}
      onClose={onClose}
      footer={
        <>
          {acc.id && !sys && (
            <button className="btn danger" onClick={() => window.confirm('Delete this account? Only unused accounts can be deleted.') && onSave({}, true)}>
              Delete
            </button>
          )}
          <button
            className="btn primary"
            disabled={!f.name.trim()}
            onClick={() =>
              onSave(
                acc.id
                  ? { code: f.code || null, name: f.name.trim(), ...(sys ? {} : { subtype: f.subtype }), parentId: f.parentId || null, description: f.description || null, ...(sys ? {} : { isActive: f.isActive }) }
                  : { code: f.code || null, name: f.name.trim(), subtype: f.subtype, parentId: f.parentId || null, description: f.description || null },
              )
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Code
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </label>
        <label className="field">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          Type
          <select value={f.subtype} disabled={sys} onChange={(e) => setF({ ...f, subtype: e.target.value, parentId: '' })}>
            {SUBTYPES.filter((s) => !acc.id || s[2] === SUBTYPES.find((x) => x[0] === acc.subtype)?.[2]).map(([k, l, g]) => (
              <option key={k} value={k}>
                {g}: {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Sub-account of
          <select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">—</option>
            {accounts
              .filter((a) => a.id !== acc.id && SUBTYPES.find((s) => s[0] === a.subtype)?.[2] === group)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field wide">
          Description
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        {acc.id && !sys && (
          <label className="row small wide">
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── reports ───────────────────────── */

const REPORTS: [string, string, 'range' | 'asof' | 'month' | 'account' | 'customer' | 'vendor'][] = [
  ['profit-and-loss', 'Profit and loss', 'range'],
  ['balance-sheet', 'Balance sheet', 'asof'],
  ['cash-flow', 'Cash flow', 'range'],
  ['trial-balance', 'Trial balance', 'asof'],
  ['general-ledger', 'General ledger', 'account'],
  ['day-book', 'Day book', 'range'],
  ['customer-statement', 'Customer statement', 'customer'],
  ['vendor-statement', 'Vendor statement', 'vendor'],
  ['sales-by-customer', 'Sales by customer', 'range'],
  ['sales-by-item', 'Sales by item', 'range'],
  ['purchases-by-vendor', 'Purchases by vendor', 'range'],
  ['purchases-by-item', 'Purchases by item', 'range'],
  ['expenses-by-category', 'Expenses by category', 'range'],
];

export function Reports() {
  const [r, setR] = useState('profit-and-loss');
  const [p, setP] = useState({ from: fyStart(), to: today(), accountId: '', partyId: '', compare: false });
  const kind = REPORTS.find((x) => x[0] === r)![2];
  const toast = useToast();
  const params = new URLSearchParams({ from: p.from, to: p.to });
  if (kind === 'account' && p.accountId) params.set('accountId', p.accountId);
  if ((kind === 'customer' || kind === 'vendor') && p.partyId) params.set('partyId', p.partyId);
  if (r === 'profit-and-loss' && p.compare) {
    const y = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
    params.set('compareFrom', y(p.from));
    params.set('compareTo', y(p.to));
  }
  const ready = !(kind === 'account' && !p.accountId) && !((kind === 'customer' || kind === 'vendor') && !p.partyId);
  const { data, isFetching, error } = useQuery({ queryKey: ['books', 'report', r, params.toString()], queryFn: () => get<any>(`/api/v1/books/reports/${r}?${params}`), enabled: ready });
  const parties = useQuery({ queryKey: ['books', 'parties', kind], queryFn: () => get<{ items: Json[] }>(`/api/v1/records/${kind === 'vendor' ? 'vendor' : 'account'}?limit=200&sort=name&dir=asc`), enabled: kind === 'customer' || kind === 'vendor' });
  // what a PDF of this report is called, and the period it covers
  const dmy = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const party = (kind === 'customer' || kind === 'vendor') && p.partyId ? parties.data?.items.find((x) => x.id === p.partyId)?.title : null;
  const reportName = [REPORTS.find((x) => x[0] === r)![1], party].filter(Boolean).join(': ');
  const period = kind === 'asof' ? `As of ${dmy(p.to)}` : `${dmy(p.from)} to ${dmy(p.to)}${r === 'profit-and-loss' && p.compare ? ', compared with the year before' : ''}`;
  return (
    <div className="stack" data-export-title={reportName} data-export-note={period}>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          Report
          <select value={r} onChange={(e) => setR(e.target.value)}>
            {REPORTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {kind !== 'asof' && (
          <label className="field">
            From
            <input type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />
          </label>
        )}
        <label className="field">
          {kind === 'asof' ? 'As of' : 'To'}
          <input type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />
        </label>
        {kind === 'account' && (
          <label className="field" style={{ minWidth: 240 }}>
            Account
            <AccountSelect value={p.accountId} onChange={(v) => setP({ ...p, accountId: v })} />
          </label>
        )}
        {(kind === 'customer' || kind === 'vendor') && (
          <label className="field" style={{ minWidth: 240 }}>
            {kind === 'vendor' ? 'Vendor' : 'Customer'}
            <select value={p.partyId} onChange={(e) => setP({ ...p, partyId: e.target.value })}>
              <option value="">Choose</option>
              {(parties.data?.items ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {r === 'profit-and-loss' && (
          <label className="row small">
            <input type="checkbox" checked={p.compare} onChange={(e) => setP({ ...p, compare: e.target.checked })} /> Compare with last year
          </label>
        )}
        <button
          className="btn"
          disabled={!ready}
          onClick={() => download(`/api/v1/books/reports/${r}?${params}&format=csv`, `${r}.csv`).catch((e) => toast((e as Error).message, true))}
        >
          Export CSV
        </button>
        <button className="btn ghost" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {!ready ? (
        <p className="muted">Choose {kind === 'account' ? 'an account' : kind === 'vendor' ? 'a vendor' : 'a customer'}.</p>
      ) : error ? (
        <p style={{ color: 'var(--bad)' }}>{(error as Error).message}</p>
      ) : !data || isFetching ? (
        <Spinner />
      ) : (
        <ReportView report={r} data={data} />
      )}
    </div>
  );
}

function Amount({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">—</span>;
  return <span style={v < 0 ? { color: 'var(--bad)' } : undefined}>{money2(v)}</span>;
}

function ReportView({ report, data }: { report: string; data: any }) {
  if (report === 'profit-and-loss') {
    const cmp = !!data.compare;
    return (
      <table className="data" style={{ maxWidth: 760 }}>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">This period</th>
            {cmp && <th className="num">Last year</th>}
          </tr>
        </thead>
        <tbody>
          {(data.sections as Json[]).map((s, i) => (
            <SectionRows key={s.key} s={s} cmp={cmp} after={i === 1 ? ['Gross profit', data.grossProfit, data.compare?.gross] : i === 2 ? ['Operating profit', data.operatingProfit, data.compare?.operating] : null} />
          ))}
          <tr>
            <td>
              <b>Net profit</b>
            </td>
            <td className="num">
              <b>
                <Amount v={data.netProfit} />
              </b>
            </td>
            {cmp && (
              <td className="num">
                <b>
                  <Amount v={data.compare.net} />
                </b>
              </td>
            )}
          </tr>
        </tbody>
      </table>
    );
  }
  if (report === 'balance-sheet') {
    return (
      <div className="stack" style={{ maxWidth: 760 }}>
        {!data.totals.balanced && <div className="notice">The balance sheet does not balance. Check the trial balance.</div>}
        <table className="data">
          <tbody>
            {(data.groups as Json[]).map((g) => (
              <SectionRows key={g.key} s={g} cmp={false} />
            ))}
            <tr>
              <td>
                <b>Total assets</b>
              </td>
              <td className="num">
                <b>{money2(data.totals.assets)}</b>
              </td>
            </tr>
            <tr>
              <td>
                <b>Total liabilities and equity</b>
              </td>
              <td className="num">
                <b>{money2(data.totals.liabilitiesAndEquity)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  if (report === 'cash-flow') {
    return (
      <table className="data" style={{ maxWidth: 760 }}>
        <tbody>
          {(['operating', 'investing', 'financing'] as const).map((k) => (
            <SectionRows key={k} s={{ label: `${k[0]!.toUpperCase()}${k.slice(1)} activities`, accounts: data[k].lines.map((l: Json, i: number) => ({ id: `${k}${i}`, name: l.label, amount: l.amount })), total: data[k].total }} cmp={false} />
          ))}
          {Math.abs(data.other) >= 0.01 && (
            <tr>
              <td>Other movements</td>
              <td className="num">{money2(data.other)}</td>
            </tr>
          )}
          <tr>
            <td>Opening cash and bank</td>
            <td className="num">{money2(data.openingCash)}</td>
          </tr>
          <tr>
            <td>
              <b>Closing cash and bank</b>
            </td>
            <td className="num">
              <b>{money2(data.closingCash)}</b>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }
  if (report === 'trial-balance') {
    return (
      <table className="data" style={{ maxWidth: 760 }}>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {(data.rows as Json[]).map((r) => (
            <tr key={r.id}>
              <td>
                {r.code ? `${r.code} · ` : ''}
                {r.name}
              </td>
              <td className="num">{r.debit ? money2(r.debit) : ''}</td>
              <td className="num">{r.credit ? money2(r.credit) : ''}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>Total</b> {!data.totals.balanced && <span className="chip bad">does not balance</span>}
            </td>
            <td className="num">
              <b>{money2(data.totals.debit)}</b>
            </td>
            <td className="num">
              <b>{money2(data.totals.credit)}</b>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }
  if (report === 'general-ledger' || report === 'customer-statement' || report === 'vendor-statement') {
    return (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Entry</th>
              <th>Party</th>
              <th>Narration</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{date(data.from)}</td>
              <td colSpan={5}>
                <i>Opening balance</i>
              </td>
              <td className="num">{money2(data.opening)}</td>
            </tr>
            {(data.lines as Json[]).map((l) => (
              <tr key={l.id}>
                <td>{date(l.entry_date)}</td>
                <td>
                  {SOURCE_LINK[l.source_type] && l.source_id ? <Link to={`/o/${SOURCE_LINK[l.source_type]}/${l.source_id}`}>{SOURCE_LABEL[l.source_type]} {l.number ?? l.reference ?? ''}</Link> : `${SOURCE_LABEL[l.source_type] ?? l.source_type} ${l.number ?? l.reference ?? ''}`}
                </td>
                <td>{l.party}</td>
                <td className="small muted" title={l.narration}>
                  {l.description ?? l.narration}
                </td>
                <td className="num">{l.debit ? money2(l.debit) : ''}</td>
                <td className="num">{l.credit ? money2(l.credit) : ''}</td>
                <td className="num">{money2(l.balance)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={6}>
                <b>Closing balance</b>
              </td>
              <td className="num">
                <b>{money2(data.closing)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  if (report === 'day-book') {
    return (
      <div className="stack">
        {(data.journals as Json[]).map((j) => (
          <div key={j.id} className="panel" style={{ padding: 10, opacity: j.status === 'void' ? 0.5 : 1 }}>
            <div className="row small" style={{ gap: 12 }}>
              <b>{date(j.entry_date)}</b>
              <span>
                {SOURCE_LABEL[j.source_type] ?? j.source_type} {j.number ?? j.reference ?? ''}
              </span>
              <span className="muted">{j.narration}</span>
              {j.status === 'void' && <span className="chip bad">void</span>}
            </div>
            <table className="data">
              <tbody>
                {(j.lines as Json[]).map((l, i) => (
                  <tr key={i}>
                    <td style={{ paddingLeft: l.credit ? 40 : 12 }}>{l.account}</td>
                    <td className="num">{l.debit ? money2(l.debit) : ''}</td>
                    <td className="num">{l.credit ? money2(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {!data.journals.length && <Empty title="No entries in this range" />}
      </div>
    );
  }
  // tabular reports
  const rows = data as Json[];
  if (!rows.length) return <Empty title="Nothing in this range" />;
  const cols = Object.keys(rows[0]!).filter((k) => !/(^|_)id$|^key$/.test(k));
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className={typeof rows[0]![c] === 'number' ? 'num' : undefined}>
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>
                  {typeof r[c] === 'number' && !/^(invoices|bills|quantity)$/.test(c) ? money2(r[c]) : String(r[c] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({ s, cmp, after }: { s: Json; cmp: boolean; after?: [string, number, number | undefined] | null }) {
  return (
    <>
      <tr>
        <td colSpan={cmp ? 3 : 2} style={{ background: '#f7fafb' }}>
          <b>{s.label}</b>
        </td>
      </tr>
      {(s.accounts as Json[]).map((a) => (
        <tr key={a.id}>
          <td style={{ paddingLeft: 28 }}>
            {a.code ? `${a.code} · ` : ''}
            {a.name}
          </td>
          <td className="num">
            <Amount v={a.amount} />
          </td>
          {cmp && (
            <td className="num">
              <Amount v={a.compare} />
            </td>
          )}
        </tr>
      ))}
      <tr>
        <td>Total {s.label.toLowerCase()}</td>
        <td className="num">
          <b>
            <Amount v={s.total} />
          </b>
        </td>
        {cmp && (
          <td className="num">
            <Amount v={s.compare} />
          </td>
        )}
      </tr>
      {after && (
        <tr>
          <td>
            <b>{after[0]}</b>
          </td>
          <td className="num">
            <b>
              <Amount v={after[1]} />
            </b>
          </td>
          {cmp && (
            <td className="num">
              <Amount v={after[2]} />
            </td>
          )}
        </tr>
      )}
    </>
  );
}

/* ───────────────────────── recurring ───────────────────────── */

function Recurring() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'recurring'], queryFn: () => get<Json[]>('/api/v1/books/recurring') });
  const act = useAct([['books', 'recurring']]);
  const [form, setForm] = useState(false);
  const nav = useNavigate();
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <p className="muted small">
        Recurring journals (rent, salaries accrual, EMIs) are set up here. To repeat an invoice, bill or expense, open it and choose <b>Make recurring</b> — or create the profile here from a template.
      </p>
      <div>
        <button className="btn primary" onClick={() => setForm(true)}>
          New recurring journal
        </button>
      </div>
      {!data.length ? (
        <Empty title="No recurring transactions" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Every</th>
              <th>Next</th>
              <th>Runs</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name} {p.last_error && <span className="chip bad" title={p.last_error}>last run failed</span>}
                </td>
                <td>{p.kind}</td>
                <td>
                  {p.every > 1 ? `${p.every} × ` : ''}
                  {p.frequency.replace('_', '-')}
                </td>
                <td>{date(p.next_date)}</td>
                <td>{p.runs}</td>
                <td>{p.status}</td>
                <td className="row">
                  {p.status !== 'ended' && (
                    <button className="btn sm ghost" onClick={() => act(() => post(`/api/v1/books/recurring/${p.id}/${p.status === 'active' ? 'pause' : 'resume'}`), p.status === 'active' ? 'Paused' : 'Resumed')}>
                      {p.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const r = (await act(() => post<{ id: string }>(`/api/v1/books/recurring/${p.id}/run`), 'Created')) as { id: string } | null;
                      if (r?.id && p.kind !== 'journal') nav(`/o/${p.kind}/${r.id}`);
                    }}
                  >
                    Create now
                  </button>
                  <button className="btn sm ghost" onClick={() => window.confirm('Delete this recurring profile?') && act(() => del(`/api/v1/books/recurring/${p.id}`), 'Deleted')}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && <RecurringJournalForm onClose={() => { setForm(false); refetch(); }} />}
    </div>
  );
}

function RecurringJournalForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', frequency: 'monthly', startDate: today(), endDate: '', debitId: '', creditId: '', amount: '' });
  return (
    <Modal
      title="New recurring journal"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name || !f.debitId || !f.creditId || !(Number(f.amount) > 0)}
          onClick={async () => {
            try {
              await post('/api/v1/books/recurring', {
                name: f.name,
                kind: 'journal',
                frequency: f.frequency,
                startDate: f.startDate,
                endDate: f.endDate || null,
                template: { narration: f.name, lines: [{ accountId: f.debitId, debit: Number(f.amount) }, { accountId: f.creditId, credit: Number(f.amount) }] },
              });
              toast('Saved');
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
      <div className="modal-body grid2">
        <label className="field wide">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Factory rent" autoFocus />
        </label>
        <label className="field">
          Debit
          <AccountSelect value={f.debitId} onChange={(v) => setF({ ...f, debitId: v })} filter={(a) => !['accounts_receivable', 'accounts_payable'].includes(a.subtype)} />
        </label>
        <label className="field">
          Credit
          <AccountSelect value={f.creditId} onChange={(v) => setF({ ...f, creditId: v })} filter={(a) => !['accounts_receivable', 'accounts_payable'].includes(a.subtype)} />
        </label>
        <label className="field">
          Amount (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Repeats
          <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="half_yearly">Half-yearly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        <label className="field">
          First on
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </label>
        <label className="field">
          Ends (optional)
          <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── budgets ───────────────────────── */

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

function Budgets() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'budgets'], queryFn: () => get<Json[]>('/api/v1/books/budgets') });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  if (open) return <BudgetView id={open} back={() => setOpen(null)} edit={(b) => setEdit(b)} />;
  return (
    <div className="stack">
      <div>
        <button className="btn primary" onClick={() => setEdit({})}>
          New budget
        </button>
      </div>
      {!data.length ? (
        <Empty title="No budgets yet">Set monthly amounts for income and expense accounts and compare them with actuals.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Year</th>
              <th>Accounts</th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
                <td>{b.name}</td>
                <td>FY {b.financial_year}</td>
                <td>{b.lines}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <BudgetForm budget={edit} onClose={() => { setEdit(null); refetch(); }} />}
    </div>
  );
}

function BudgetView({ id, back, edit }: { id: string; back: () => void; edit: (b: Json) => void }) {
  const { data } = useQuery({ queryKey: ['books', 'report', 'bva', id], queryFn: () => get<Json>(`/api/v1/books/reports/budget-vs-actual?budgetId=${id}`) });
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn sm ghost" onClick={back}>
          ← Budgets
        </button>
        <h2 style={{ margin: 0 }}>
          {data.budget.name} · FY {data.budget.financial_year}
        </h2>
        <button className="btn sm" onClick={() => edit({ ...data.budget, rows: data.rows })}>
          Edit
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              {MONTHS.map((m) => (
                <th key={m} className="num">
                  {m}
                </th>
              ))}
              <th className="num">Budget</th>
              <th className="num">Actual</th>
              <th className="num">Variance</th>
            </tr>
          </thead>
          <tbody>
            {(data.rows as Json[]).map((r) => {
              const v = r.actualTotal - r.budgetTotal;
              const bad = r.type === 'income' ? v < 0 : v > 0;
              return (
                <tr key={r.accountId}>
                  <td>{r.name}</td>
                  {r.actual.map((a: number, i: number) => (
                    <td key={i} className="num small" title={`Budget ${money2(r.budget[i])}`}>
                      {moneyShort(a)}
                    </td>
                  ))}
                  <td className="num">{money2(r.budgetTotal)}</td>
                  <td className="num">{money2(r.actualTotal)}</td>
                  <td className="num" style={{ color: bad ? 'var(--bad)' : 'var(--good)' }}>
                    {money2(v)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BudgetForm({ budget, onClose }: { budget: Json; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: budget.name ?? '', financialYear: budget.financial_year ?? fyLabel() });
  const [rows, setRows] = useState<{ accountId: string; months: string[] }[]>(
    (budget.rows as Json[] | undefined)?.map((r) => ({ accountId: r.accountId, months: r.budget.map(String) })) ?? [{ accountId: '', months: Array(12).fill('') }],
  );
  return (
    <Modal
      title={budget.id ? 'Edit budget' : 'New budget'}
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || !/^\d{4}-\d{2}$/.test(f.financialYear)}
          onClick={async () => {
            try {
              const body = { ...f, lines: rows.filter((r) => r.accountId).map((r) => ({ accountId: r.accountId, months: r.months.map((m) => Number(m) || 0) })) };
              if (budget.id) await put(`/api/v1/books/budgets/${budget.id}`, body);
              else await post('/api/v1/books/budgets', body);
              toast('Budget saved');
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
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Financial year
            <input value={f.financialYear} onChange={(e) => setF({ ...f, financialYear: e.target.value })} placeholder="2026-27" />
          </label>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Same every month</th>
                {MONTHS.map((m) => (
                  <th key={m}>{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ minWidth: 200 }}>
                    <AccountSelect value={r.accountId} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, accountId: v } : x)))} filter={(a) => a.type === 'income' || a.type === 'expense'} />
                  </td>
                  <td style={{ width: 100 }}>
                    <input inputMode="decimal" placeholder="fill" onBlur={(e) => e.target.value && setRows(rows.map((x, j) => (j === i ? { ...x, months: Array(12).fill(e.target.value) } : x)))} />
                  </td>
                  {r.months.map((m, k) => (
                    <td key={k} style={{ width: 80 }}>
                      <input inputMode="decimal" value={m} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, months: x.months.map((y, n) => (n === k ? e.target.value : y)) } : x)))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button className="btn sm" onClick={() => setRows([...rows, { accountId: '', months: Array(12).fill('') }])}>
            Add account
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── fixed assets ───────────────────────── */

function Assets() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'assets'], queryFn: () => get<Json[]>('/api/v1/books/assets') });
  const [form, setForm] = useState(false);
  const [dispose, setDispose] = useState<Json | null>(null);
  const act = useAct([['books']]);
  if (!data) return <Spinner />;
  const lastMonthEnd = new Date(new Date().getFullYear(), new Date().getMonth(), 0);
  const upTo = `${lastMonthEnd.getFullYear()}-${String(lastMonthEnd.getMonth() + 1).padStart(2, '0')}-${String(lastMonthEnd.getDate()).padStart(2, '0')}`;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={() => setForm(true)}>
          Add asset
        </button>
        <button
          className="btn"
          onClick={async () => {
            const d = window.prompt('Run depreciation up to the end of which month? (YYYY-MM-DD)', upTo);
            if (!d) return;
            const r = (await act(() => post<Json>('/api/v1/books/assets/depreciate', { upTo: d }), 'Depreciation posted')) as Json | null;
            if (r) refetch();
          }}
        >
          Run depreciation
        </button>
      </div>
      {!data.length ? (
        <Empty title="No fixed assets">Register machines, furniture, computers and vehicles to depreciate them monthly (straight line or written-down value).</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Account</th>
                <th>In service</th>
                <th>Method</th>
                <th className="num">Cost</th>
                <th className="num">Depreciated</th>
                <th className="num">Book value</th>
                <th>Up to</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.asset_number} · {a.name} {a.serial_no && <span className="muted small">{a.serial_no}</span>}
                  </td>
                  <td>{a.asset_account}</td>
                  <td>{date(a.in_service_date)}</td>
                  <td>{a.method === 'wdv' ? `WDV ${a.rate_pct}%` : a.life_months ? `SLM ${Math.round(a.life_months / 12 * 10) / 10} yrs` : `SLM ${a.rate_pct}%`}</td>
                  <td className="num">{money2(a.cost)}</td>
                  <td className="num">{money2(a.accumulated)}</td>
                  <td className="num">{money2(a.book_value)}</td>
                  <td>{date(a.depreciated_to)}</td>
                  <td>{a.status.replace(/_/g, ' ')}</td>
                  <td>
                    {a.status !== 'disposed' && (
                      <button className="btn sm ghost" onClick={() => setDispose(a)}>
                        Sell / scrap
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && <AssetForm onClose={() => { setForm(false); refetch(); }} />}
      {dispose && <DisposeForm asset={dispose} onClose={() => { setDispose(null); refetch(); }} />}
    </div>
  );
}

function AssetForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', assetAccountId: '', purchaseDate: today(), cost: '', salvageValue: '', method: 'slm', lifeYears: '10', ratePct: '15', location: '', serialNo: '', paidThroughId: '' });
  return (
    <Modal
      title="Add fixed asset"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name || !(Number(f.cost) > 0)}
          onClick={async () => {
            try {
              await post('/api/v1/books/assets', {
                name: f.name,
                assetAccountId: f.assetAccountId || null,
                purchaseDate: f.purchaseDate,
                cost: Number(f.cost),
                salvageValue: Number(f.salvageValue) || 0,
                method: f.method,
                lifeMonths: f.method === 'slm' ? Math.round(Number(f.lifeYears) * 12) : null,
                ratePct: f.method === 'wdv' ? Number(f.ratePct) : null,
                location: f.location || null,
                serialNo: f.serialNo || null,
                paidThroughId: f.paidThroughId || null,
              });
              toast('Asset added');
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Add asset
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CNC panel saw" autoFocus />
        </label>
        <label className="field">
          Asset account
          <AccountSelect value={f.assetAccountId} onChange={(v) => setF({ ...f, assetAccountId: v })} filter={(a) => a.subtype === 'fixed_asset'} placeholder="Plant and machinery" />
        </label>
        <label className="field">
          Purchased on
          <input type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} />
        </label>
        <label className="field">
          Cost (₹)
          <input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
        </label>
        <label className="field">
          Salvage value (₹)
          <input inputMode="decimal" value={f.salvageValue} onChange={(e) => setF({ ...f, salvageValue: e.target.value })} />
        </label>
        <label className="field">
          Method
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="slm">Straight line (Companies Act)</option>
            <option value="wdv">Written-down value (Income Tax)</option>
          </select>
        </label>
        {f.method === 'slm' ? (
          <label className="field">
            Useful life (years)
            <input inputMode="decimal" value={f.lifeYears} onChange={(e) => setF({ ...f, lifeYears: e.target.value })} />
          </label>
        ) : (
          <label className="field">
            Rate per year (%)
            <input inputMode="decimal" value={f.ratePct} onChange={(e) => setF({ ...f, ratePct: e.target.value })} />
          </label>
        )}
        <label className="field">
          Serial no.
          <input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} />
        </label>
        <label className="field">
          Location
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </label>
        <label className="field wide">
          Post the purchase from (leave empty if a bill already recorded it)
          <AccountSelect value={f.paidThroughId} onChange={(v) => setF({ ...f, paidThroughId: v })} filter={(a) => ['bank', 'cash', 'credit_card', 'current_liability', 'long_term_liability'].includes(a.subtype)} placeholder="Don't post" />
        </label>
      </div>
    </Modal>
  );
}

function DisposeForm({ asset, onClose }: { asset: Json; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ date: today(), amount: '', depositToId: '' });
  return (
    <Modal
      title={`Sell or scrap ${asset.name}`}
      onClose={onClose}
      footer={
        <button
          className="btn danger"
          onClick={async () => {
            try {
              const r = await post<Json>(`/api/v1/books/assets/${asset.id}/dispose`, { date: f.date, amount: Number(f.amount) || 0, depositToId: f.depositToId || null });
              toast(r.gain >= 0 ? `Gain of ${money2(r.gain)} booked` : `Loss of ${money2(-r.gain)} booked`);
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Dispose
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Sale amount (₹, 0 if scrapped)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field wide">
          Received in
          <AccountSelect value={f.depositToId} onChange={(v) => setF({ ...f, depositToId: v })} filter={(a) => ['bank', 'cash', 'accounts_receivable'].includes(a.subtype) && a.subtype !== 'accounts_receivable'} placeholder="Default bank" />
        </label>
        <p className="muted small wide">Book value today is about {money2(asset.book_value)}; depreciation is brought up to the month before the disposal first.</p>
      </div>
    </Modal>
  );
}

/* ───────────────────────── GST & TDS ───────────────────────── */

/** The month a link asked for (once), e.g. from the accounts desk's "Review line by line". */
function askedMonth() {
  try {
    const m = sessionStorage.getItem('books.gstMonth');
    sessionStorage.removeItem('books.gstMonth');
    return m && /^\d{4}-\d{2}$/.test(m) ? m : null;
  } catch {
    return null;
  }
}

function GstTds() {
  const [asked] = useState(askedMonth);
  const [month, setMonth] = useState(asked ?? today().slice(0, 7));
  const b2Ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (asked) setTimeout(() => b2Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  }, [asked]);
  const g = useQuery({ queryKey: ['books', 'gstr3b', month], queryFn: () => get<Json>(`/api/v1/books/reports/gstr-3b?month=${month}`) });
  const tds = useQuery({ queryKey: ['books', 'tds'], queryFn: () => get<Json>(`/api/v1/books/reports/tds?from=${fyStart()}&to=${today()}`) });
  const period = `${month.slice(5, 7)}${month.slice(0, 4)}`;
  const b2 = useQuery({ queryKey: ['books', 'gstr2b', period], queryFn: () => get<Json>(`/api/v1/books/reports/gstr-2b?period=${period}`).catch(() => null) });
  const toast = useToast();
  const d = g.data;
  const t3 = (label: string, v: Json | undefined, taxable?: number) => (
    <tr>
      <td>{label}</td>
      <td className="num">{taxable != null ? money2(taxable) : v?.taxable != null ? money2(v.taxable) : ''}</td>
      <td className="num">{money2(v?.igst ?? 0)}</td>
      <td className="num">{money2(v?.cgst ?? 0)}</td>
      <td className="num">{money2(v?.sgst ?? 0)}</td>
    </tr>
  );
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field">
          Return period
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label className="btn">
          Import GSTR-2B (JSON)
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const rows = parse2b(JSON.parse(await file.text()));
                if (!rows.length) return toast('No B2B invoices found in the file', true);
                const r = await post<Json>('/api/v1/books/gstr-2b', { period, rows });
                toast(`${r.lines} invoice(s): ${r.matched} matched, ${r.mismatch} with differences, ${r.unmatched} not in the books`);
                b2.refetch();
              } catch (err) {
                toast((err as Error).message, true);
              }
            }}
          />
        </label>
      </div>
      <h3 style={{ margin: 0 }}>GSTR-3B summary</h3>
      {!d ? (
        <Spinner />
      ) : (
        <table className="data" style={{ maxWidth: 820 }}>
          <thead>
            <tr>
              <th>Table</th>
              <th className="num">Taxable</th>
              <th className="num">IGST</th>
              <th className="num">CGST</th>
              <th className="num">SGST</th>
            </tr>
          </thead>
          <tbody>
            {t3('3.1(a) Outward taxable supplies', d.outward)}
            {t3('3.1(b) Zero rated (exports)', d.zeroRated)}
            {t3('3.1(c) Nil rated / exempt', undefined, d.nilExempt)}
            {t3('3.1(d) Inward supplies on reverse charge', d.inwardReverseCharge)}
            {t3('4(A) Input tax credit available', d.itc.total)}
            {t3('Tax liability', d.liability)}
            {t3('Reverse charge (paid in cash)', d.reverseChargeCash)}
            {t3('Credit carried forward', d.creditCarriedForward)}
            <tr>
              <td>
                <b>Payable in cash</b>
              </td>
              <td />
              <td className="num">
                <b>{money2(d.payableInCash.igst)}</b>
              </td>
              <td className="num">
                <b>{money2(d.payableInCash.cgst)}</b>
              </td>
              <td className="num">
                <b>{money2(d.payableInCash.sgst)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <h3 ref={b2Ref} style={{ margin: 0 }}>GSTR-2B reconciliation</h3>
      {!b2.data ? (
        <p className="muted small">Download GSTR-2B (JSON) for {month} from the GST portal and import it to match your suppliers' filings against your bills.</p>
      ) : (
        <>
          <div className="row small" style={{ gap: 14 }}>
            <span className="chip good">{b2.data.lines.filter((l: Json) => l.match_status === 'matched').length} matched</span>
            <span className="chip warn">{b2.data.lines.filter((l: Json) => l.match_status === 'mismatch').length} with differences</span>
            <span className="chip bad">{b2.data.lines.filter((l: Json) => l.match_status === 'unmatched').length} not in the books</span>
            <span className="chip">{b2.data.missingInGstr2b.length} bill(s) not filed by the supplier</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Supplier GSTIN</th>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th className="num">Taxable</th>
                  <th className="num">Tax</th>
                  <th>Status</th>
                  <th>In the books</th>
                </tr>
              </thead>
              <tbody>
                {(b2.data.lines as Json[]).map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.supplier_gstin} <span className="muted small">{l.supplier_name}</span>
                    </td>
                    <td>{l.doc_number}</td>
                    <td>{date(l.doc_date)}</td>
                    <td className="num">{money2(l.taxable)}</td>
                    <td className="num">{money2(l.tax)}</td>
                    <td>
                      <span className={`chip ${l.match_status === 'matched' ? 'good' : l.match_status === 'mismatch' ? 'warn' : 'bad'}`} title={l.note ?? undefined}>
                        {l.match_status}
                      </span>
                    </td>
                    <td>{l.bill_id ? <Link to={`/o/bill/${l.bill_id}`}>{l.bill_number}</Link> : '—'}</td>
                  </tr>
                ))}
                {(b2.data.missingInGstr2b as Json[]).map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.vendor_gstin} <span className="muted small">{b.vendor}</span>
                    </td>
                    <td>{b.vendor_ref}</td>
                    <td>{date(b.bill_date)}</td>
                    <td className="num">{money2(b.taxable)}</td>
                    <td className="num">{money2(b.tax)}</td>
                    <td>
                      <span className="chip">not filed</span>
                    </td>
                    <td>
                      <Link to={`/o/bill/${b.id}`}>{b.bill_number}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h3 style={{ margin: 0 }}>TDS · FY {fyLabel()}</h3>
      {!tds.data ? (
        <Spinner />
      ) : (
        <div className="stack">
          <div className="row small" style={{ gap: 12, flexWrap: 'wrap' }}>
            {(tds.data.bySection as Json[]).map((s) => (
              <span key={s.section} className="chip info">
                {s.section}: {money2(s.tds)}
              </span>
            ))}
            {!tds.data.bySection.length && <span className="muted">No TDS deducted on bills yet.</span>}
          </div>
          {tds.data.payable.length > 0 && (
            <table className="data">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Vendor</th>
                  <th>PAN</th>
                  <th>Bill</th>
                  <th>Date</th>
                  <th className="num">Taxable</th>
                  <th className="num">TDS</th>
                  <th>Deposit by</th>
                </tr>
              </thead>
              <tbody>
                {(tds.data.payable as Json[]).map((r, i) => (
                  <tr key={i}>
                    <td>{r.section}</td>
                    <td>{r.vendor}</td>
                    <td>{r.pan ?? <span className="chip bad">missing</span>}</td>
                    <td>{r.bill_number}</td>
                    <td>{date(r.bill_date)}</td>
                    <td className="num">{money2(r.taxable)}</td>
                    <td className="num">{money2(r.tds)}</td>
                    <td>{date(r.deposit_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tds.data.receivable.length > 0 && (
            <>
              <b>Deducted by customers</b>
              <p className="small muted" style={{ margin: 0 }}>
                Income-tax TDS: claim in your return (check Form 26AS). GST TDS (section 51): accept it in GSTR-2X; it then reaches your electronic cash ledger. Retention is
                tracked under Deposits &amp; guarantees.
              </p>
              <table className="data">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>GSTIN</th>
                    <th>Receipt</th>
                    <th>Date</th>
                    <th className="num">TDS</th>
                    <th className="num">GST TDS</th>
                    <th className="num">LD / penalty</th>
                    <th className="num">Retention</th>
                  </tr>
                </thead>
                <tbody>
                  {(tds.data.receivable as Json[]).map((r, i) => (
                    <tr key={i}>
                      <td>{r.customer}</td>
                      <td className="small">{r.gstin ?? ''}</td>
                      <td>{r.payment_number}</td>
                      <td>{date(r.payment_date)}</td>
                      <td className="num">{r.tds ? money2(r.tds) : ''}</td>
                      <td className="num">{r.gst_tds ? money2(r.gst_tds) : ''}</td>
                      <td className="num">{r.ld ? money2(r.ld) : ''}</td>
                      <td className="num">{r.retention ? money2(r.retention) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Reads the GST portal's GSTR-2B JSON (data.docdata.b2b[].inv[] / cdnr). */
function parse2b(j: Json) {
  const doc = j?.data?.docdata ?? j?.docdata ?? {};
  const out: Json[] = [];
  const iso = (s: string) => {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s ?? '');
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
  for (const s of doc.b2b ?? []) {
    for (const inv of s.inv ?? []) {
      out.push({ supplierGstin: String(s.ctin ?? '').toUpperCase(), supplierName: s.trdnm ?? null, docNumber: String(inv.inum ?? ''), docDate: iso(inv.dt), docType: 'invoice', taxable: Number(inv.txval ?? 0), igst: Number(inv.igst ?? 0), cgst: Number(inv.cgst ?? 0), sgst: Number(inv.sgst ?? 0), itcAvailable: inv.itcavl !== 'N' });
    }
  }
  for (const s of doc.cdnr ?? []) {
    for (const n of s.nt ?? []) {
      const sign = n.typ === 'C' ? -1 : 1;
      out.push({ supplierGstin: String(s.ctin ?? '').toUpperCase(), supplierName: s.trdnm ?? null, docNumber: String(n.ntnum ?? ''), docDate: iso(n.dt), docType: n.typ === 'C' ? 'credit_note' : 'debit_note', taxable: sign * Number(n.txval ?? 0), igst: sign * Number(n.igst ?? 0), cgst: sign * Number(n.cgst ?? 0), sgst: sign * Number(n.sgst ?? 0), itcAvailable: n.itcavl !== 'N' });
    }
  }
  return out.filter((r) => /^[0-9]{2}[A-Z0-9]{13}$/.test(r.supplierGstin) && r.docNumber);
}

/* ───────────────────────── settings ───────────────────────── */

function Settings() {
  const { data, refetch } = useQuery({ queryKey: ['books', 'settings'], queryFn: () => get<Json>('/api/v1/books/settings') });
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const c = f ?? data.config;
  const save = async (body: Json) => {
    try {
      const r = await put<Json>('/api/v1/books/settings', body);
      toast(r.posted ? `Saved. ${r.posted} existing document(s) posted to the ledger.` : 'Saved');
      setF(null);
      refetch();
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <ReminderSettings />
      <div className="panel" style={{ padding: 14 }}>
        <h3 style={{ marginTop: 0 }}>Books of record</h3>
        <div className="stack">
          <label className="row">
            <input type="radio" checked={c.books_of_record === 'synapse'} onChange={() => setF({ ...c, books_of_record: 'synapse' })} />
            <span>
              <b>SanchalanOS keeps the books.</b> Invoices, receipts, bills, vendor payments and expenses post journals automatically; reports come from the ledger.
            </span>
          </label>
          <label className="row">
            <input type="radio" checked={c.books_of_record === 'tally'} onChange={() => setF({ ...c, books_of_record: 'tally' })} />
            <span>
              <b>Our accountant keeps the books in Tally.</b> SanchalanOS records the documents and syncs vouchers to Tally (Billing → Tally); no journals are posted here.
            </span>
          </label>
          <label className="row">
            <input type="checkbox" checked={!!c.enabled} onChange={(e) => setF({ ...c, enabled: e.target.checked })} />
            <span>Posting switched on</span>
          </label>
        </div>
      </div>
      <div className="grid2">
        <label className="field">
          Books start on
          <input type="date" value={c.start_date ?? ''} onChange={(e) => setF({ ...c, start_date: e.target.value })} />
          <span className="small muted">The books are kept by financial year: when a bank line or document from an earlier year comes in, the start moves back to 1 April of that year by itself (unless opening balances are entered). Balances from before the start are entered as opening balances.</span>
        </label>
        <label className="field">
          Lock the books up to
          <input type="date" value={c.lock_date ?? ''} onChange={(e) => setF({ ...c, lock_date: e.target.value || null })} />
          <span className="small muted">Nothing dated on or before this can be posted, changed or voided (e.g. after filing returns).</span>
        </label>
        <label className="field">
          TAN (for TDS)
          <input value={c.tan ?? ''} maxLength={10} onChange={(e) => setF({ ...c, tan: e.target.value.toUpperCase() || null })} />
        </label>
        <label className="field">
          PAN
          <input value={c.pan ?? ''} maxLength={10} onChange={(e) => setF({ ...c, pan: e.target.value.toUpperCase() || null })} />
        </label>
        <label className="field">
          Stock accounting
          <select value={c.inventory_on} onChange={(e) => setF({ ...c, inventory_on: e.target.value })}>
            <option value="bill">Perpetual: bills add to stock, invoices post cost of goods sold</option>
            <option value="none">Periodic: purchases are expensed</option>
          </select>
        </label>
        <label className="row field">
          <input type="checkbox" checked={!!c.tds_enabled} onChange={(e) => setF({ ...c, tds_enabled: e.target.checked })} /> Deduct TDS on vendor bills
        </label>
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={!f}
          onClick={() =>
            save({
              enabled: c.enabled,
              booksOfRecord: c.books_of_record,
              ...(c.start_date !== data.config.start_date ? { startDate: c.start_date } : {}),
              lockDate: c.lock_date || null,
              tdsEnabled: c.tds_enabled,
              tan: c.tan || null,
              pan: c.pan || null,
              inventoryOn: c.inventory_on,
            })
          }
        >
          Save settings
        </button>
        <span className="muted small">
          {data.accounts} accounts · {data.journals} posted entries
        </span>
      </div>
    </div>
  );
}

