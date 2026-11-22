/**
 * Accounts desk → Own accounts: the owners / partners / directors and what identifies their personal
 * accounts (mobile numbers behind UPI, UPI ids, account numbers, the name the bank prints), and what
 * identifies each of the company's own bank accounts. The bookkeeper books any line naming one of them
 * as a transfer: to that person's own ledger, or between the company's accounts.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { SelectAll } from '../SelectAll';
import { blankIdentity, IdentitySection, persistIdentity, type IdentityValues } from '../IdentitySection';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type Ident = { kind: 'mobile' | 'upi' | 'account' | 'name'; value: string };

const KINDS: [Ident['kind'], string, string][] = [
  ['mobile', 'Mobile number', '9311421118'],
  ['upi', 'UPI id', 'name@okaxis'],
  ['account', 'Account number', '50200012345678'],
  ['name', 'Name as the bank prints it', 'PRASHANT K SRIVASTAVA'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
export const ROLES: [string, string, string][] = [
  ['partner', 'Partner', "One running ledger: “<name> — partner's current account” (equity)"],
  ['director', 'Director', 'One running ledger: “Loan from <name> (director)” (liability)'],
  ['proprietor', 'Proprietor', "Money in to Owner's capital, money out to Drawings"],
  ['other', 'Other (family, relative)', 'One running ledger: “<name> — personal account” (liability)'],
];

export function IdentEditor({ list, onChange, kinds = KINDS }: { list: Ident[]; onChange: (l: Ident[]) => void; kinds?: typeof KINDS }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {list.map((it, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <select value={it.kind} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, kind: e.target.value as Ident['kind'] } : x)))} style={{ width: 190 }}>
            {kinds.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input value={it.value} placeholder={kinds.find(([k]) => k === it.kind)?.[2]} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ flex: 1 }} />
          <button className="btn ghost sm" aria-label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div>
        <button className="btn ghost sm" onClick={() => onChange([...list, { kind: kinds[0]![0], value: '' }])}>
          + Add {list.length ? 'another' : 'one'}
        </button>
      </div>
    </div>
  );
}

/** Where people and bank identifiers are saved: the accounts desk, or Settings → Organisation. */
export const DESK_PATHS = { person: '/api/v1/books/desk/own/persons', bank: '/api/v1/books/desk/own/banks' };
export const ORG_PATHS = { person: '/api/v1/organisation/people', bank: '/api/v1/organisation/bank-accounts' };

export function PersonModal({ person, defaultRole, onClose, onSaved, paths = DESK_PATHS, details = false, users = [] }: { person: Json | null; defaultRole: string; onClose: () => void; onSaved: (r: Json) => void; paths?: typeof DESK_PATHS; details?: boolean; users?: { id: string; name: string }[] }) {
  const toast = useToast();
  const accounts = useQuery({ queryKey: ['books', 'accounts'], queryFn: () => get<Json[]>('/api/v1/books/accounts'), staleTime: 30_000 });
  const [f, setF] = useState({
    name: person?.name ?? '',
    role: person?.role ?? defaultRole,
    custom: false,
    accountIn: person?.account_in ?? '',
    accountOut: person?.account_out ?? '',
    identifiers: (person?.identifiers ?? [{ kind: 'mobile', value: '' }]) as Ident[],
    designation: person?.designation ?? '',
    phone: person?.phone ?? '',
    email: person?.email ?? '',
    pan: person?.pan ?? '',
    din: person?.din ?? '',
    sharePct: person?.share_pct ?? '',
    joinedOn: person?.joined_on ?? '',
    userId: person?.user_id ?? '',
  });
  const [idv, setIdv] = useState<IdentityValues>(blankIdentity());
  const [busy, setBusy] = useState(false);
  const ledgers = (accounts.data ?? []).filter((a) => ['equity', 'liability'].includes(a.type) && !['accounts_payable', 'credit_card', 'tax_payable'].includes(a.subtype) && a.is_active !== false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: f.name,
        role: f.role,
        identifiers: f.identifiers.filter((i) => i.value.trim()),
        ...(f.custom ? { accountIn: f.accountIn || null, accountOut: f.accountOut || null } : {}),
        ...(details
          ? { designation: f.designation || null, phone: f.phone || null, email: f.email || null, pan: f.pan || null, din: f.din || null, sharePct: f.sharePct === '' ? null : Number(f.sharePct), joinedOn: f.joinedOn || null, userId: f.userId || null }
          : {}),
      };
      const r = person ? await put<Json>(`${paths.person}/${person.id}`, body) : await post<Json>(paths.person, body);
      const pid = person?.id ?? r?.id ?? r?.person?.id;
      if (details && pid) {
        try {
          await persistIdentity('partner', pid, idv, { includePan: false });
        } catch (e) {
          // the person is saved; say what is left
          toast(`Saved ${f.name}, but not the ID details: ${(e as Error).message}`, true);
          onSaved(r);
          return;
        }
      }
      onSaved(r);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={person ? `Edit ${person.name}` : 'Add an owner or partner'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !f.name.trim()}>
            {busy ? 'Saving…' : 'Save and book their lines'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Prashant Srivastava" autoFocus />
        </label>
        {details && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <label className="field">
              Designation
              <input value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} placeholder="Designated partner" />
            </label>
            <label className="field">
              Share / capital %
              <input className="num" inputMode="decimal" value={f.sharePct} onChange={(e) => setF({ ...f, sharePct: e.target.value })} />
            </label>
            <label className="field">
              Phone
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </label>
            <label className="field">
              Email
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </label>
            <label className="field">
              PAN
              <input className="mono" maxLength={10} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              DIN / DPIN
              <input className="mono" maxLength={8} value={f.din} onChange={(e) => setF({ ...f, din: e.target.value })} />
            </label>
            <label className="field">
              Partner / director since
              <input type="date" value={f.joinedOn} onChange={(e) => setF({ ...f, joinedOn: e.target.value })} />
            </label>
            <label className="field">
              Their SanchalanOS user
              <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {details && <IdentitySection subject="partner" id={person?.id ?? null} value={idv} onChange={setIdv} showPan={false} />}
        <div className="field">
          Role in the business
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {ROLES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <span className="muted small">{ROLES.find(([k]) => k === f.role)?.[2]}</span>
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.custom} onChange={(e) => setF({ ...f, custom: e.target.checked })} />
          Use ledgers I choose instead
        </label>
        {f.custom && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(
              [
                ['accountIn', 'Money in from them'],
                ['accountOut', 'Money out to them'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="field" style={{ flex: 1, minWidth: 220 }}>
                {l}
                <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
                  <option value="">Default for the role</option>
                  {ledgers.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code ? `${a.code} · ` : ''}
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        <div className="field">
          Their personal accounts: what the bank prints on a transfer
          <span className="muted small">Add every mobile number (UPI shows it), UPI id and account number they use. A name alone is used too, but those lines wait for your approval.</span>
          <IdentEditor list={f.identifiers} onChange={(identifiers) => setF({ ...f, identifiers })} />
        </div>
      </div>
    </Modal>
  );
}

export function BankModal({ bank, onClose, onSaved, paths = DESK_PATHS }: { bank: Json; onClose: () => void; onSaved: (r: Json) => void; paths?: typeof DESK_PATHS }) {
  const toast = useToast();
  const kinds = KINDS.filter(([k]) => k === 'account' || k === 'upi');
  const [list, setList] = useState<Ident[]>(bank.identifiers.length ? bank.identifiers : [{ kind: 'account', value: '' }]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await put<Json>(`${paths.bank}/${bank.id}`, { identifiers: list.filter((i) => i.value.trim()) }));
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={bank.name}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          The full account number (and UPI id, if it has one). When another company account's statement shows it, the line is a transfer between your own accounts, booked once; the matching line here then matches the same entry.
        </p>
        <IdentEditor list={list} onChange={setList} kinds={kinds} />
      </div>
    </Modal>
  );
}

function Misbooked({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['books', 'desk', 'own', 'misbooked'], queryFn: () => get<{ lines: Json[] }>('/api/v1/books/desk/own/misbooked') });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Spinner />;
  const lines = q.data?.lines ?? [];
  if (!lines.length) return null;
  const can = lines.filter((l) => l.canRebook);
  const rebook = async () => {
    setBusy(true);
    try {
      const r = await post<Json>('/api/v1/books/desk/own/rebook', { txnIds: [...sel] });
      toast(`${r.undone} line(s) re-booked${r.applied < r.undone ? `; ${r.undone - r.applied} wait in the review queue` : ''}${r.skipped?.length ? `; ${r.skipped.length} skipped: ${r.skipped[0].error}` : ''}`, !!r.skipped?.length);
      setSel(new Set());
      q.refetch();
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>Booked another way ({lines.length})</h2>
        <button className="btn primary sm" disabled={!sel.size || busy} onClick={rebook}>
          {busy ? 'Re-booking…' : `Re-book ${sel.size || ''} as own transfers`}
        </button>
      </div>
      <div className="panel-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          These lines name one of your own accounts but were booked before it was listed, or by hand. Re-booking undoes that booking (voiding a receipt or payment the desk recorded as an advance) and books the line as a transfer. Lines matched to invoices or bills, or already reconciled, are only listed: check them yourself.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <SelectAll ids={can.map((l) => l.id)} sel={sel} setSel={setSel} />
                </th>
                <th>Date</th>
                <th>Bank line</th>
                <th className="num">Amount</th>
                <th>Booked to</th>
                <th>Names</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={!l.canRebook}
                      checked={sel.has(l.id)}
                      onChange={(e) => {
                        const n = new Set(sel);
                        e.target.checked ? n.add(l.id) : n.delete(l.id);
                        setSel(n);
                      }}
                    />
                  </td>
                  <td>{date(l.date)}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                    {l.description}
                    <div className="muted small">{l.bank}</div>
                  </td>
                  <td className="num" style={{ color: l.amount > 0 ? 'var(--good)' : undefined }}>
                    {money2(l.amount)}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {l.bookedTo}
                    {l.why && <div className="muted small">{l.why}</div>}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {l.owner}
                    <div className="muted small">{l.identifier}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function OwnAccounts() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['books', 'desk', 'own'], queryFn: () => get<Json>('/api/v1/books/desk/own') });
  const [edit, setEdit] = useState<Json | null | 'new'>(null);
  const [bank, setBank] = useState<Json | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['books', 'desk'] });
    qc.invalidateQueries({ queryKey: ['books', 'accounts'] });
  };
  const saved = (r: Json) => {
    toast(r.proposed ? `Saved. ${r.applied ?? 0} line(s) booked as own transfers${r.proposed - (r.applied ?? 0) > 0 ? `, ${r.proposed - r.applied} in the review queue` : ''}` : 'Saved');
    refresh();
  };
  if (q.isLoading) return <Spinner />;
  const d = q.data ?? { persons: [], banks: [], defaultRole: 'partner' };
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <p className="muted small" style={{ margin: 0 }}>
        Money moving between the business and its owners, or between the company's own accounts, is not income or expense. List the people and accounts here; the bookkeeper books every bank line that names one of them as a transfer, automatically when it's named by a mobile number, UPI id or account number.
      </p>

      <section className="panel">
        <div className="panel-head">
          <h2>Owners, partners and directors</h2>
          <button className="btn primary sm" onClick={() => setEdit('new')}>
            Add a person
          </button>
        </div>
        <div className="panel-body">
          {!d.persons.length ? (
            <Empty title="No one listed yet">Add yourself and your partners with the mobile numbers, UPI ids and account numbers of your personal accounts.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Identified by</th>
                    <th>Books to</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.persons.map((p: Json) => (
                    <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.55 }}>
                      <td>
                        <b>{p.name}</b>
                        <div className="muted small">{ROLES.find(([k]) => k === p.role)?.[1]}</div>
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {p.identifiers.length ? (
                          p.identifiers.map((i: Json) => (
                            <span key={i.id} className="chip" title={KIND_LABEL[i.kind]} style={{ marginRight: 4, display: 'inline-block', marginBottom: 2 }}>
                              {i.value}
                            </span>
                          ))
                        ) : (
                          <span className="muted small">Nothing yet: add a mobile number or account</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {p.account_in === p.account_out ? (
                          p.account_in_name
                        ) : (
                          <>
                            In: {p.account_in_name}
                            <div>Out: {p.account_out_name}</div>
                          </>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => setEdit(p)}>
                          Edit
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            if (!confirm(`Stop treating ${p.name}'s accounts as own accounts? Lines already booked stay as they are.`)) return;
                            try {
                              await del(`/api/v1/books/desk/own/persons/${p.id}`);
                              refresh();
                            } catch (e) {
                              toast((e as Error).message, true);
                            }
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
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>The company's own bank accounts</h2>
        </div>
        <div className="panel-body stack">
          <p className="muted small" style={{ margin: 0 }}>
            Add the full account number of each current account. Add more accounts in Books → Banking. Without numbers, money leaving one account and the same amount arriving in another within two days is still suggested as a transfer for you to approve.
          </p>
          {!d.banks.length ? (
            <Empty title="No bank accounts">Add your current accounts in Books → Banking.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Identified by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.banks.map((b: Json) => (
                    <tr key={b.id}>
                      <td>
                        <b>{b.name}</b>
                        <div className="muted small">{[b.bank_name, b.account_last4 && `••${b.account_last4}`].filter(Boolean).join(' ')}</div>
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {b.identifiers.length ? (
                          b.identifiers.map((i: Json) => (
                            <span key={i.id} className="chip" style={{ marginRight: 4 }}>
                              {i.value}
                            </span>
                          ))
                        ) : (
                          <span className="muted small">No account number yet</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost sm" onClick={() => setBank(b)}>
                          {b.identifiers.length ? 'Edit' : 'Add number'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Misbooked onDone={refresh} />

      {edit && <PersonModal person={edit === 'new' ? null : edit} defaultRole={d.defaultRole} onClose={() => setEdit(null)} onSaved={saved} />}
      {bank && <BankModal bank={bank} onClose={() => setBank(null)} onSaved={saved} />}
    </div>
  );
}

