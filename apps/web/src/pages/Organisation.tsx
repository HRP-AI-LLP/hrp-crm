/**
 * Organisation: the company's profile (legal details, phones, emails, addresses, its own contacts),
 * partners and directors with their personal accounts, the company's bank accounts, and saved
 * signatures. Admins with the "organisation" permission manage it and can name others who may.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { BankModal, ORG_PATHS, PersonModal, ROLES } from '../components/books/OwnAccounts';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, post, put } from '../lib/api';

type Json = Record<string, any>;
type Tab = 'profile' | 'contacts' | 'people' | 'banks' | 'signatures';

const CONSTITUTIONS: [string, string][] = [
  ['llp', 'Limited liability partnership (LLP)'],
  ['private_limited', 'Private limited company'],
  ['public_limited', 'Public limited company'],
  ['opc', 'One person company'],
  ['partnership', 'Partnership firm'],
  ['proprietorship', 'Proprietorship'],
  ['section_8', 'Section 8 company'],
  ['trust', 'Trust'],
  ['society', 'Society'],
  ['other', 'Other'],
];

export function OrganisationPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Organisation</h1>
          <p>Your company's details, partners, bank accounts and signatures, used across quotes, invoices and the books.</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-body">
          <OrganisationTab />
        </div>
      </section>
    </>
  );
}

export function OrganisationTab() {
  const q = useQuery({ queryKey: ['organisation'], queryFn: () => get<Json>('/api/v1/organisation') });
  const [tab, setTab] = useState<Tab>('profile');
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  return (
    <div className="stack">
      {!d.canManage && <div className="notice small">You can see the profile; changing it is for admins and the people they name.</div>}
      <div className="tabs" role="tablist" style={{ padding: 0 }}>
        {(
          [
            ['profile', 'Profile'],
            ['contacts', 'Phones, emails & contacts'],
            ['people', 'Partners & directors'],
            ['banks', 'Bank accounts'],
            ['signatures', 'Signatures'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'profile' && <Profile d={d} />}
      {tab === 'contacts' && <Contacts d={d} />}
      {tab === 'people' && <People d={d} />}
      {tab === 'banks' && <Banks d={d} />}
      {tab === 'signatures' && <Signatures d={d} />}
    </div>
  );
}

function useSaveProfile() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (profile: Json) => {
    try {
      const { managers, ...rest } = profile;
      const r = await put<Json>('/api/v1/organisation', { ...rest, ...(profile._isAdmin ? { managers } : {}) });
      qc.setQueryData(['organisation'], r);
      toast('Saved');
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
}

const field = (label: string, el: React.ReactNode, wide = false) => (
  <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
    {label}
    {el}
  </label>
);

function Profile({ d }: { d: Json }) {
  const save = useSaveProfile();
  const [p, setP] = useState<Json>(d.profile);
  useEffect(() => setP(d.profile), [d.profile]);
  const ro = !d.canManage;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setP({ ...p, [k]: e.target.value });
  return (
    <div className="stack">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {field('Legal name', <input value={p.legalName} disabled={ro} onChange={set('legalName')} />)}
        {field('Trade name', <input value={p.tradeName} disabled={ro} onChange={set('tradeName')} />)}
        {field(
          'Constitution',
          <select value={p.constitution} disabled={ro} onChange={set('constitution')}>
            <option value="">—</option>
            {CONSTITUTIONS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>,
        )}
        {field('PAN', <input className="mono" maxLength={10} value={p.pan} disabled={ro} onChange={(e) => setP({ ...p, pan: e.target.value.toUpperCase() })} />)}
        {field('GSTIN', <input className="mono" maxLength={15} value={p.gstin} disabled={ro} onChange={(e) => setP({ ...p, gstin: e.target.value.toUpperCase() })} />)}
        {field('TAN', <input className="mono" maxLength={10} value={p.tan} disabled={ro} onChange={(e) => setP({ ...p, tan: e.target.value.toUpperCase() })} />)}
        {field('LLPIN / CIN / registration no.', <input value={p.registrationNo} disabled={ro} onChange={set('registrationNo')} />)}
        {field('Udyam (MSME) no.', <input value={p.udyam} disabled={ro} onChange={set('udyam')} />)}
        {field('Incorporated on', <input type="date" value={p.incorporatedOn} disabled={ro} onChange={set('incorporatedOn')} />)}
        {field('Registered address', <textarea rows={2} value={p.address} disabled={ro} onChange={set('address')} />, true)}
        {field('City', <input value={p.city} disabled={ro} onChange={set('city')} />)}
        {field('State', <input value={p.state} disabled={ro} onChange={set('state')} />)}
        {field('PIN code', <input value={p.pincode} disabled={ro} onChange={set('pincode')} />)}
        {field('Website', <input value={p.website} disabled={ro} onChange={set('website')} placeholder="https://" />)}
        {field('Main phone (printed on documents)', <input value={p.phone} disabled={ro} onChange={set('phone')} />)}
        {field('Main email (printed on documents)', <input type="email" value={p.email} disabled={ro} onChange={set('email')} />)}
      </div>
      {d.isAdmin && (
        <div className="field">
          Who else manages this profile (besides admins)
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {d.users.map((u: Json) => (
              <label key={u.id} className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={p.managers.includes(u.id)} onChange={(e) => setP({ ...p, managers: e.target.checked ? [...p.managers, u.id] : p.managers.filter((x: string) => x !== u.id) })} />
                {u.name}
              </label>
            ))}
          </div>
        </div>
      )}
      {!ro && (
        <div>
          <button className="btn primary" onClick={() => save({ ...p, _isAdmin: d.isAdmin })}>
            Save profile
          </button>
        </div>
      )}
    </div>
  );
}

function ListEditor<T extends Json>({ title, rows, cols, blank, ro, onChange }: { title: string; rows: T[]; cols: [keyof T & string, string, string?][]; blank: T; ro: boolean; onChange: (r: T[]) => void }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {!rows.length && <span className="muted small">None yet.</span>}
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          {cols.map(([k, label, ph]) => (
            <input key={k} aria-label={label} placeholder={ph ?? label} value={String(r[k] ?? '')} disabled={ro} style={{ flex: k === 'label' || k === 'role' ? 0.6 : 1 }} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
          ))}
          {!ro && (
            <button className="btn ghost sm" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {!ro && (
        <div>
          <button className="btn ghost sm" onClick={() => onChange([...rows, { ...blank }])}>
            + Add
          </button>
        </div>
      )}
    </div>
  );
}

function Contacts({ d }: { d: Json }) {
  const save = useSaveProfile();
  const [p, setP] = useState<Json>(d.profile);
  useEffect(() => setP(d.profile), [d.profile]);
  const ro = !d.canManage;
  return (
    <div className="stack">
      <ListEditor title="Phone numbers" rows={p.phones} cols={[['label', 'Label', 'Office / Accounts / Support'], ['number', 'Number', '+91 …']]} blank={{ label: '', number: '' }} ro={ro} onChange={(phones) => setP({ ...p, phones })} />
      <ListEditor title="Email addresses" rows={p.emails} cols={[['label', 'Label', 'Accounts / Sales'], ['email', 'Email']]} blank={{ label: '', email: '' }} ro={ro} onChange={(emails) => setP({ ...p, emails })} />
      <ListEditor title="Other addresses (branches, warehouses)" rows={p.addresses} cols={[['label', 'Label', 'Branch'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['pincode', 'PIN']]} blank={{ label: '', address: '', city: '', state: '', pincode: '' }} ro={ro} onChange={(addresses) => setP({ ...p, addresses })} />
      <ListEditor title="People to contact at the company" rows={p.contacts} cols={[['name', 'Name'], ['role', 'Role', 'Accounts / HR'], ['phone', 'Phone'], ['email', 'Email']]} blank={{ name: '', role: '', phone: '', email: '' }} ro={ro} onChange={(contacts) => setP({ ...p, contacts })} />
      {!ro && (
        <div>
          <button className="btn primary" onClick={() => save({ ...p, _isAdmin: false })}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function usePeople(enabled: boolean) {
  return useQuery({ queryKey: ['organisation', 'people'], queryFn: () => get<Json>('/api/v1/organisation/people'), enabled, retry: false });
}

function People({ d }: { d: Json }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = usePeople(true);
  const [edit, setEdit] = useState<Json | null | 'new'>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Empty title="Only managers see this">Partners' personal accounts are visible to admins and the profile's managers.</Empty>;
  const data = q.data!;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['organisation', 'people'] });
    qc.invalidateQueries({ queryKey: ['books', 'desk'] });
  };
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Money between the business and a partner's personal accounts is booked to that partner's own ledger by the accounts desk: add every mobile number, UPI id and account number they use.
      </p>
      <div>
        {d.canManage && (
          <button className="btn primary sm" onClick={() => setEdit('new')}>
            Add a partner or director
          </button>
        )}
      </div>
      {!data.persons.length ? (
        <Empty title="No one yet">Add the partners or directors.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Details</th>
                <th>Personal accounts</th>
                <th>Ledger</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.persons.map((p: Json) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.name}</b>
                    <div className="muted small">{p.designation || ROLES.find(([k]) => k === p.role)?.[1]}</div>
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    {[p.share_pct != null ? `${p.share_pct}%` : null, p.phone, p.email, p.pan && `PAN ${p.pan}`, p.din && `DIN ${p.din}`].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {p.identifiers.map((i: Json) => (
                      <span key={i.id} className="chip" style={{ marginRight: 4, display: 'inline-block', marginBottom: 2 }}>
                        {i.value}
                      </span>
                    ))}
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    {p.account_in_name}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {d.canManage && (
                      <>
                        <button className="btn ghost sm" onClick={() => setEdit(p)}>
                          Edit
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            if (!confirm(`Remove ${p.name}? Lines already booked stay as they are.`)) return;
                            try {
                              await del(`/api/v1/organisation/people/${p.id}`);
                              refresh();
                            } catch (e) {
                              toast((e as Error).message, true);
                            }
                          }}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <PersonModal
          person={edit === 'new' ? null : edit}
          defaultRole={data.defaultRole}
          paths={ORG_PATHS}
          details
          users={d.users}
          onClose={() => setEdit(null)}
          onSaved={() => {
            toast('Saved');
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Banks({ d }: { d: Json }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = usePeople(true);
  const [edit, setEdit] = useState<Json | null>(null);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ name: '', bankName: '', accountNumber: '', ifsc: '', upi: '' });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Empty title="Only managers see this">The company's account numbers are visible to admins and the profile's managers.</Empty>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['organisation', 'people'] });
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        The company's current accounts. Their numbers let the accounts desk book transfers between them once, and print on documents where needed. Statements and reconciliation are in Books → Banking.
      </p>
      {d.canManage && (
        <div>
          <button className="btn primary sm" onClick={() => setAdd(true)}>
            Add a bank account
          </button>
        </div>
      )}
      {!q.data!.banks.length ? (
        <Empty title="No bank accounts">Add the company's current accounts.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Numbers / UPI</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.banks.map((b: Json) => (
                <tr key={b.id}>
                  <td>
                    <b>{b.name}</b>
                    <div className="muted small">{[b.bank_name, b.account_last4 && `••${b.account_last4}`].filter(Boolean).join(' ')}</div>
                  </td>
                  <td>
                    {b.identifiers.map((i: Json) => (
                      <span key={i.id} className="chip mono" style={{ marginRight: 4 }}>
                        {i.value}
                      </span>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {d.canManage && (
                      <button className="btn ghost sm" onClick={() => setEdit(b)}>
                        Edit numbers
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <BankModal bank={edit} paths={ORG_PATHS} onClose={() => setEdit(null)} onSaved={() => refresh()} />}
      {add && (
        <Modal
          title="Add a bank account"
          onClose={() => setAdd(false)}
          footer={
            <button
              className="btn primary"
              disabled={!f.name.trim() || !f.accountNumber.trim()}
              onClick={async () => {
                try {
                  await post('/api/v1/organisation/bank-accounts', { name: f.name, bankName: f.bankName || null, accountNumber: f.accountNumber.replace(/\s/g, ''), ifsc: f.ifsc || null, upi: f.upi || null });
                  toast('Added');
                  setAdd(false);
                  refresh();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Add
            </button>
          }
        >
          <div className="modal-body stack">
            {field('Name in the books', <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Yes Bank current account" autoFocus />)}
            {field('Bank', <input value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />)}
            {field('Account number', <input className="mono" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} />)}
            {field('IFSC', <input className="mono" maxLength={11} value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} />)}
            {field('UPI id (optional)', <input value={f.upi} onChange={(e) => setF({ ...f, upi: e.target.value })} placeholder="business@okhdfcbank" />)}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ───────────────────────── signatures ───────────────────────── */

/** Reads an image file, trims and shrinks it to a PNG data URL of at most ~600px wide. */
async function signatureFromFile(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 600 / bmp.width, 220 / bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function DrawPad({ onDone }: { onDone: (url: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * ref.current!.width) / r.width, ((e.clientY - r.top) * ref.current!.height) / r.height] as const;
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <canvas
        ref={ref}
        width={600}
        height={200}
        style={{ width: '100%', maxWidth: 420, height: 140, background: '#fff', border: '1px dashed var(--line)', borderRadius: 8, touchAction: 'none' }}
        onPointerDown={(e) => {
          drawing.current = true;
          const g = ref.current!.getContext('2d')!;
          g.lineWidth = 3;
          g.lineCap = 'round';
          g.strokeStyle = '#13213c';
          g.beginPath();
          g.moveTo(...pos(e));
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const g = ref.current!.getContext('2d')!;
          g.lineTo(...pos(e));
          g.stroke();
        }}
        onPointerUp={() => {
          drawing.current = false;
          onDone(ref.current!.toDataURL('image/png'));
        }}
      />
      <div>
        <button className="btn ghost sm" type="button" onClick={() => ref.current!.getContext('2d')!.clearRect(0, 0, 600, 200)}>
          Clear
        </button>
      </div>
    </div>
  );
}

function Signatures({ d }: { d: Json }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-signatures'], queryFn: () => get<Json[]>('/api/v1/organisation/signatures') });
  const billing = useQuery({ queryKey: ['billing-settings'], queryFn: () => get<Json>('/api/v1/billing/settings'), retry: false });
  const [edit, setEdit] = useState<Json | null>(null);
  if (q.isLoading) return <Spinner />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['org-signatures'] });
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Save each signatory's signature once; the people you name can sign invoices, quotes, orders and purchase orders with it. A signed document prints the signature with a code anyone can check at the verification page; if the document changes, the check shows it.
      </p>
      {d.canManage && (
        <div>
          <button className="btn primary sm" onClick={() => setEdit({ signerName: '', designation: '', image: '', userIds: [] })}>
            Add a signature
          </button>
        </div>
      )}
      {!q.data?.length ? (
        <Empty title="No signatures yet">Add yours and your partner's.</Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {q.data.map((s) => (
            <div key={s.id} className="panel" style={{ padding: 12 }}>
              <img src={s.image} alt={`Signature of ${s.signerName}`} style={{ height: 60, maxWidth: '100%', objectFit: 'contain', background: '#fff', display: 'block' }} />
              <b>{s.signerName}</b>
              <div className="muted small">{s.designation}</div>
              <div className="small">Signs: {s.userIds.map((id: string) => d.users.find((u: Json) => u.id === id)?.name ?? 'someone').join(', ') || 'no one yet'}</div>
              {billing.data?.autoSignId === s.id && <span className="chip good">Signs every invoice when issued</span>}
              {d.canManage && (
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn ghost sm" onClick={() => setEdit(s)}>
                    Edit
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={async () => {
                      if (!confirm(`Remove ${s.signerName}'s signature? Documents already signed keep it.`)) return;
                      await del(`/api/v1/organisation/signatures/${s.id}`).catch((e) => toast((e as Error).message, true));
                      refresh();
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {billing.data && q.data?.length ? (
        <label className="field" style={{ maxWidth: 420 }}>
          Sign every invoice when it is issued with
          <select
            value={billing.data.autoSignId ?? ''}
            onChange={async (e) => {
              try {
                await put('/api/admin/billing/settings', { autoSignId: e.target.value });
                qc.invalidateQueries({ queryKey: ['billing-settings'] });
                toast('Saved');
              } catch (err) {
                toast((err as Error).message, true);
              }
            }}
          >
            <option value="">No one (sign each by hand)</option>
            {q.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.signerName}
              </option>
            ))}
          </select>
          <span className="muted small">Includes recurring invoices issued on their own. Needs the billing admin permission.</span>
        </label>
      ) : null}
      {edit && <SignatureModal sig={edit} users={d.users} onClose={() => setEdit(null)} onSaved={refresh} />}
    </div>
  );
}

function SignatureModal({ sig, users, onClose, onSaved }: { sig: Json; users: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ signerName: sig.signerName ?? '', designation: sig.designation ?? '', image: sig.image ?? '', userIds: (sig.userIds ?? []) as string[] });
  const [mode, setMode] = useState<'upload' | 'draw'>('upload');
  return (
    <Modal
      title={sig.id ? `Edit ${sig.signerName}'s signature` : 'Add a signature'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!f.signerName.trim() || !f.image}
            onClick={async () => {
              try {
                const body = { ...f, designation: f.designation || undefined };
                if (sig.id) await put(`/api/v1/organisation/signatures/${sig.id}`, body);
                else await post('/api/v1/organisation/signatures', body);
                onSaved();
                onClose();
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
      <div className="modal-body stack">
        {field('Signatory', <input value={f.signerName} onChange={(e) => setF({ ...f, signerName: e.target.value })} placeholder="Harsha Rani" autoFocus />)}
        {field('Designation', <input value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} placeholder="Designated partner" />)}
        <div className="field">
          Signature
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className={`btn sm${mode === 'upload' ? ' primary' : ''}`} onClick={() => setMode('upload')}>
              Upload an image
            </button>
            <button type="button" className={`btn sm${mode === 'draw' ? ' primary' : ''}`} onClick={() => setMode('draw')}>
              Draw it
            </button>
          </div>
          {mode === 'upload' ? (
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setF({ ...f, image: await signatureFromFile(file) });
              }}
            />
          ) : (
            <DrawPad onDone={(image) => setF((x) => ({ ...x, image }))} />
          )}
          {f.image && <img src={f.image} alt="Preview" style={{ height: 60, maxWidth: 260, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)', borderRadius: 6, marginTop: 6 }} />}
          <span className="muted small">A scan of the signature on white paper works best (PNG with a transparent background is ideal).</span>
        </div>
        <div className="field">
          Who may sign with it
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {users.map((u) => (
              <label key={u.id} className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={f.userIds.includes(u.id)} onChange={(e) => setF({ ...f, userIds: e.target.checked ? [...f.userIds, u.id] : f.userIds.filter((x) => x !== u.id) })} />
                {u.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
