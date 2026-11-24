/**
 * Organisation: the company's profile (legal details, phones, emails, addresses, its own contacts),
 * partners and directors with their personal accounts, the company's bank accounts, and saved
 * signatures. Admins with the "organisation" permission manage it and can name others who may.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { BankModal, ORG_PATHS, PersonModal, ROLES } from '../components/books/OwnAccounts';
import { DocTemplatesTab } from '../components/admin/DocTemplates';
import { DocSlot, foundingDoc, OrgDocuments } from '../components/OrgDocuments';
import { forgetPdfOrganisation } from '../lib/table-pdf';
import { local, setSignerPort, signerPort } from '../lib/dsc';
import { date as fmtDate } from '../lib/format';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SideTabs } from '../components/SideTabs';
import { Guide } from '../components/admin/ConnectionKeys';
import { ProfessionalsTab } from '../components/ProfessionalsTab';

type Json = Record<string, any>;
type Tab = 'profile' | 'contacts' | 'leaders' | 'people' | 'banks' | 'documents' | 'signatures' | 'dsc' | 'templates' | 'professionals';

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
      <SideTabs
        id="organisation"
        title="Organisation"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'profile', label: 'Profile', icon: 'building', group: 'Company' },
          { key: 'contacts', label: 'Phones, emails & contacts', icon: 'mail', group: 'Company' },
          { key: 'banks', label: 'Bank accounts', icon: 'wallet', group: 'Company' },
          { key: 'leaders', label: 'Leadership & key people', icon: 'users', group: 'People' },
          { key: 'people', label: 'Partners & directors', icon: 'user', group: 'People' },
          { key: 'professionals', label: 'Accountants & CAs', icon: 'users', group: 'People' },
          { key: 'documents', label: 'Documents', icon: 'folder', group: 'Papers' },
          { key: 'signatures', label: 'Signatures', icon: 'contract', group: 'Papers' },
          { key: 'dsc', label: 'Digital signatures (DSC)', icon: 'stamp', group: 'Papers' },
          { key: 'templates', label: 'Document templates', icon: 'file', group: 'Papers' },
        ]}
      >
        <div className="panel-body">
      {tab === 'profile' && <Profile d={d} />}
      {tab === 'contacts' && <Contacts d={d} />}
      {tab === 'leaders' && <KeyPeople d={d} />}
      {tab === 'people' && <People d={d} />}
      {tab === 'professionals' && <ProfessionalsTab />}
      {tab === 'banks' && <Banks d={d} />}
      {tab === 'documents' && <OrgDocuments d={d} />}
      {tab === 'signatures' && <Signatures d={d} />}
      {tab === 'dsc' && <Dsc d={d} />}
      {tab === 'templates' && <DocTemplatesTab />}
        </div>
      </SideTabs>
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
      forgetPdfOrganisation(); // reports print the new name / logo
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
        <div className="field">
          Logo
          <LogoField value={p.logo ?? ''} disabled={ro} onChange={(logo) => setP({ ...p, logo })} />
        </div>
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
        {foundingDoc(p.constitution) && (
          <div className="field">
            {foundingDoc(p.constitution)![1][0]!.toUpperCase() + foundingDoc(p.constitution)![1].slice(1)}
            <DocSlot kind={foundingDoc(p.constitution)![0]} label={foundingDoc(p.constitution)![1]} />
          </div>
        )}
        {field('PAN', <><input className="mono" maxLength={10} value={p.pan} disabled={ro} onChange={(e) => setP({ ...p, pan: e.target.value.toUpperCase() })} /><DocSlot kind="pan" number={p.pan} label="PAN card" /></>)}
        {field('GSTIN', <><input className="mono" maxLength={15} value={p.gstin} disabled={ro} onChange={(e) => setP({ ...p, gstin: e.target.value.toUpperCase() })} /><DocSlot kind="gst" number={p.gstin} label="GST certificate" /></>)}
        {field('TAN', <><input className="mono" maxLength={10} value={p.tan} disabled={ro} onChange={(e) => setP({ ...p, tan: e.target.value.toUpperCase() })} /><DocSlot kind="tan" number={p.tan} label="TAN letter" /></>)}
        {field('LLPIN / CIN / registration no.', <><input value={p.registrationNo} disabled={ro} onChange={set('registrationNo')} /><DocSlot kind="incorporation" number={p.registrationNo} label="incorporation certificate" /></>)}
        {field('Udyam (MSME) no.', <><input value={p.udyam} disabled={ro} onChange={set('udyam')} /><DocSlot kind="udyam" number={p.udyam} label="Udyam certificate" /></>)}
        {field('Incorporated on', <input type="date" value={p.incorporatedOn} disabled={ro} onChange={set('incorporatedOn')} />)}
        {field('Registered address', <textarea rows={2} value={p.address} disabled={ro} onChange={set('address')} />, true)}
        {field('City', <input value={p.city} disabled={ro} onChange={set('city')} />)}
        {field('State', <input value={p.state} disabled={ro} onChange={set('state')} />)}
        {field('PIN code', <input value={p.pincode} disabled={ro} onChange={set('pincode')} />)}
        {field('Website', <input value={p.website} disabled={ro} onChange={set('website')} placeholder="https://" />)}
        {field('Main phone (printed on documents)', <input value={p.phone} disabled={ro} onChange={set('phone')} />)}
        {field('Main email (printed on documents)', <input type="email" value={p.email} disabled={ro} onChange={set('email')} />)}
      </div>
      <fieldset className="panel" style={{ padding: 14, margin: 0 }}>
        <legend className="small" style={{ fontWeight: 600, padding: '0 6px' }}>
          Startup India (DPIIT recognition)
        </legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {field('DPIIT recognition no.', <><input className="mono" value={p.dpiitNumber ?? ''} disabled={ro} placeholder="DIPP123456" onChange={(e) => setP({ ...p, dpiitNumber: e.target.value.toUpperCase().replace(/\s/g, '') })} /><DocSlot kind="startup_india" number={p.dpiitNumber} label="recognition certificate" /></>)}
          {field('Recognised on', <input type="date" value={p.dpiitRecognisedOn ?? ''} disabled={ro} onChange={set('dpiitRecognisedOn')} />)}
          {field('Sector', <input value={p.startupSector ?? ''} disabled={ro} onChange={set('startupSector')} placeholder="e.g. Artificial Intelligence" />)}
          {field('Industry', <input value={p.startupIndustry ?? ''} disabled={ro} onChange={set('startupIndustry')} placeholder="e.g. IT Services" />)}
          {field('Sec 80-IAC certificate no.', <><input value={p.section80IacCertNo ?? ''} disabled={ro} onChange={set('section80IacCertNo')} placeholder="if the tax exemption was granted" /><DocSlot kind="section_80iac" number={p.section80IacCertNo} label="80-IAC certificate" /></>)}
          {field('80-IAC claimed from (financial year)', <input value={p.section80IacFrom ?? ''} disabled={ro} onChange={set('section80IacFrom')} placeholder="2026-27" />)}
          <label className="row small" style={{ gap: 6, alignSelf: 'end', paddingBottom: 10 }}>
            <input type="checkbox" checked={!!p.section56Exempt} disabled={ro} onChange={(e) => setP({ ...p, section56Exempt: e.target.checked })} />
            Exempt under section 56(2)(viib) (angel tax)
          </label>
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Upload each certificate under its number above; other papers (MoA, partnership deed, licences, rent agreement…) go in the Documents tab.
        </p>
      </fieldset>
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

const DESIGNATIONS = [
  'Founder & CEO', 'Co-founder', 'Chief Executive Officer (CEO)', 'Chief Technology Officer (CTO)', 'Chief Operating Officer (COO)', 'Chief Financial Officer (CFO)',
  'Chief Product Officer (CPO)', 'Chief Marketing Officer (CMO)', 'Managing Partner', 'Designated Partner', 'Managing Director', 'Director', 'Company Secretary',
  'Head of Engineering', 'Head of Sales', 'Head of Delivery', 'Head of HR', 'Finance Manager', 'Advisor',
];
type KeyPerson = { name: string; designation: string; department: string; email: string; phone: string; since: string; userId: string | null; linkedin: string; bio: string };
const blankKey: KeyPerson = { name: '', designation: '', department: '', email: '', phone: '', since: '', userId: null, linkedin: '', bio: '' };

/** The leadership team and other key people: who runs what. Partners' money stays under Partners & directors. */
function KeyPeople({ d }: { d: Json }) {
  const save = useSaveProfile();
  const { me } = useAuth();
  const ro = !d.canManage;
  const people = (d.profile.keyPeople ?? []) as KeyPerson[];
  const [edit, setEdit] = useState<{ i: number | null; p: KeyPerson } | null>(null);
  const users = (d.users ?? []) as { id: string; name: string; email: string }[];
  const write = (list: KeyPerson[]) => save({ ...d.profile, keyPeople: list, _isAdmin: false });
  const mine = me ? people.findIndex((p) => p.userId === me.user.id) : -1;
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        The people who run the organisation and what each one is responsible for. Partners and directors whose personal money the accounts desk should recognise are added under <b>Partners &amp; directors</b>; a partner can be here too, with their title.
      </p>
      {!ro && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary sm" onClick={() => setEdit({ i: null, p: { ...blankKey } })}>
            Add a key person
          </button>
          {me && mine < 0 && (
            <button className="btn sm" onClick={() => setEdit({ i: null, p: { ...blankKey, name: me.user.fullName, email: me.user.email, userId: me.user.id } })}>
              Add me
            </button>
          )}
        </div>
      )}
      {!people.length ? (
        <Empty title="No key people yet">Add yourself and the leadership team — CEO, CTO, CFO and the heads of each function.</Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {people.map((p, i) => (
            <div key={i} className="panel" style={{ padding: 14, display: 'grid', gap: 8 }}>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--brand-100)', color: 'var(--brand-800)', display: 'grid', placeItems: 'center', fontWeight: 700, flex: 'none' }}>{initials(p.name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="small" style={{ color: 'var(--accent-ink)' }}>
                    {p.designation}
                    {p.department ? ` · ${p.department}` : ''}
                  </div>
                </div>
              </div>
              {p.bio && <div className="small muted">{p.bio}</div>}
              <div className="small muted" style={{ display: 'grid', gap: 2 }}>
                {p.email && <span>{p.email}</span>}
                {p.phone && <span>{p.phone}</span>}
                {p.since && <span>Since {fmtDate(p.since)}</span>}
                {p.userId && <span>Signs in as {users.find((u) => u.id === p.userId)?.name ?? 'a user'}</span>}
              </div>
              {!ro && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => setEdit({ i, p: { ...blankKey, ...p } })}>
                    Edit
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      if (confirm(`Remove ${p.name} from the key people?`)) write(people.filter((_, j) => j !== i));
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
      {edit && (
        <KeyPersonModal
          value={edit.p}
          users={users}
          onClose={() => setEdit(null)}
          onSave={async (p) => {
            const list = edit.i == null ? [...people, p] : people.map((x, j) => (j === edit.i ? p : x));
            if (await write(list)) setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function KeyPersonModal({ value, users, onClose, onSave }: { value: KeyPerson; users: { id: string; name: string; email: string }[]; onClose: () => void; onSave: (p: KeyPerson) => void }) {
  const [p, setP] = useState<KeyPerson>(value);
  const set = (k: keyof KeyPerson, v: string | null) => setP({ ...p, [k]: v });
  return (
    <Modal title={value.name ? `Edit ${value.name}` : 'Add a key person'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(p);
        }}
      >
        <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field(
            'Signs in as (optional)',
            <select
              value={p.userId ?? ''}
              onChange={(e) => {
                const u = users.find((x) => x.id === e.target.value);
                setP({ ...p, userId: u?.id ?? null, name: p.name || u?.name || '', email: p.email || u?.email || '' });
              }}
            >
              <option value="">— not a user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>,
          )}
          {field('Name', <input required value={p.name} onChange={(e) => set('name', e.target.value)} />)}
          {field(
            'Designation',
            <>
              <input required list="key-designations" value={p.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Chief Technology Officer (CTO)" />
              <datalist id="key-designations">
                {DESIGNATIONS.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </>,
          )}
          {field('Department / responsible for', <input value={p.department} onChange={(e) => set('department', e.target.value)} placeholder="Technology & AI" />)}
          {field('Email', <input type="email" value={p.email} onChange={(e) => set('email', e.target.value)} />)}
          {field('Phone', <input value={p.phone} onChange={(e) => set('phone', e.target.value)} />)}
          {field('In this role since', <input type="date" value={p.since} onChange={(e) => set('since', e.target.value)} />)}
          {field('LinkedIn', <input value={p.linkedin} onChange={(e) => set('linkedin', e.target.value)} placeholder="https://linkedin.com/in/…" />)}
          {field('About (one or two lines)', <textarea rows={2} value={p.bio} onChange={(e) => set('bio', e.target.value)} />, true)}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
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

/* ───────────────────────── digital signature certificates ───────────────────────── */

const fileB64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

function Dsc({ d }: { d: Json }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-dsc'], queryFn: () => get<Json>('/api/v1/organisation/dsc') });
  const sigs = useQuery({ queryKey: ['org-signatures'], queryFn: () => get<Json[]>('/api/v1/organisation/signatures') });
  const billing = useQuery({ queryKey: ['billing-settings'], queryFn: () => get<Json>('/api/v1/billing/settings'), staleTime: 60_000 });
  const [modal, setModal] = useState<'pfx' | 'token' | 'pair' | null>(null);
  const [edit, setEdit] = useState<Json | null>(null);
  const [paired, setPaired] = useState<Json | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org-dsc'] });
  if (q.isLoading) return <Spinner />;
  const certs = (q.data?.certificates ?? []) as Json[];
  const signers = (q.data?.signers ?? []) as Json[];
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Sign invoices, orders and purchase orders with your digital signature certificate (Class 3 DSC). The signed PDF shows as signed in Adobe Reader and is kept with the document. A certificate kept as a <b>.pfx file</b> is stored encrypted and is never handed back — it signs only from SanchalanOS. A certificate on a <b>USB token</b> stays on the token: the DSC signer on the computer with the token signs only what this SanchalanOS asks it to.
      </p>
      <Guide id="dsc_signer" />
      {d.canManage && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn primary sm" onClick={() => setModal('pfx')}>
            Add a .pfx certificate
          </button>
          <button className="btn sm" onClick={() => setModal('pair')}>
            Pair a signer (USB token)
          </button>
          <button className="btn sm" onClick={() => setModal('token')} disabled={!signers.length} title={signers.length ? '' : 'Pair a signer first'}>
            Add the token's certificate
          </button>
        </div>
      )}
      {!certs.length ? (
        <Empty title="No certificates yet">Add your .pfx, or pair the signer and add the certificate on your USB token.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Certificate</th>
                <th>Issued by</th>
                <th>Valid until</th>
                <th>Kept as</th>
                <th>Who signs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'normal' }}>
                    <b>{c.subjectCn}</b>
                    <div className="muted small">{c.label}</div>
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                    {c.issuer}
                  </td>
                  <td>{c.expired ? <span className="chip bad">Expired {fmtDate(c.validTo)}</span> : fmtDate(c.validTo)}</td>
                  <td>{c.kind === 'pfx' ? 'Certificate file (encrypted)' : 'USB token'}</td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    {(c.userIds as string[]).map((id) => d.users.find((u: Json) => u.id === id)?.name ?? '—').join(', ') || 'No one yet'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {c.canEdit && (
                      <>
                        <button className="btn ghost sm" onClick={() => setEdit(c)}>
                          Edit
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            if (!confirm(`Remove ${c.subjectCn}'s certificate? The encrypted key is deleted; documents already signed stay signed.`)) return;
                            await del(`/api/v1/organisation/dsc/${c.id}`).catch((e) => toast((e as Error).message, true));
                            refresh();
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
      {d.canManage && certs.length > 0 && billing.data && (
        <div className="panel" style={{ padding: 12, maxWidth: 560 }}>
          <b>Sign invoices automatically when they are issued</b>
          {certs.some((c) => c.kind === 'pfx' && !c.expired) ? (
            <>
              <label className="field" style={{ marginTop: 6 }}>
                Sign every invoice with this .pfx certificate the moment it is issued
                <select
                  value={billing.data.autoDscCertId ?? ''}
                  onChange={async (e) => {
                    try {
                      await put('/api/admin/billing/settings', { autoDscCertId: e.target.value });
                      qc.invalidateQueries({ queryKey: ['billing-settings'] });
                      toast('Saved');
                    } catch (err) {
                      toast((err as Error).message, true);
                    }
                  }}
                >
                  <option value="">No automatic signing (sign each by hand)</option>
                  {certs
                    .filter((c) => c.kind === 'pfx' && !c.expired)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.subjectCn} — {c.label}
                      </option>
                    ))}
                </select>
              </label>
              <small className="muted">The certificate must list you as allowed to sign. A USB-token certificate can’t be used here — see below.</small>
            </>
          ) : (
            <TokenAutoSign certs={certs.filter((c) => c.kind === 'token' && !c.expired)} billing={billing.data} refresh={() => { qc.invalidateQueries({ queryKey: ['org-dsc'] }); qc.invalidateQueries({ queryKey: ['billing-settings'] }); }} toast={toast} />
          )}
        </div>
      )}
      <h3 style={{ margin: '8px 0 0' }}>Paired signers</h3>
      {!signers.length ? (
        <span className="muted small">None. A signer is needed only for a certificate on a USB token.</span>
      ) : (
        signers.map((s) => (
          <div key={s.id} className="row small" style={{ gap: 8 }}>
            <span>
              🔐 <b>{s.label}</b> · paired {fmtDate(s.created_at)}
              {s.last_used_at ? ` · last used ${fmtDate(s.last_used_at)}` : ''}
            </span>
            {d.canManage && (
              <button
                className="btn ghost sm"
                onClick={async () => {
                  if (!confirm(`Unpair “${s.label}”? It stops signing for this workspace at once.`)) return;
                  await del(`/api/v1/organisation/dsc-signers/${s.id}`).catch((e) => toast((e as Error).message, true));
                  refresh();
                }}
              >
                Unpair
              </button>
            )}
          </div>
        ))
      )}
      <label className="field small" style={{ maxWidth: 260 }}>
        Signer port on this computer
        <input type="number" defaultValue={signerPort()} onBlur={(e) => setSignerPort(Number(e.target.value) || 47321)} />
      </label>

      {modal === 'pfx' && <PfxModal d={d} sigs={sigs.data ?? []} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal === 'pair' && (
        <PairModal
          onClose={() => setModal(null)}
          onPaired={(r) => {
            setPaired(r);
            setModal(null);
            refresh();
          }}
        />
      )}
      {paired && <PairedModal code={paired.pairingCode} onClose={() => setPaired(null)} />}
      {modal === 'token' && <TokenCertModal d={d} sigs={sigs.data ?? []} signers={signers} onClose={() => setModal(null)} onSaved={refresh} />}
      {edit && <CertEditModal d={d} sigs={sigs.data ?? []} cert={edit} onClose={() => setEdit(null)} onSaved={refresh} />}
    </div>
  );
}

/** Auto-sign with a USB token: pick the certificate and save its PIN; a tab open on the laptop signs issued invoices. */
function TokenAutoSign({ certs, billing, refresh, toast }: { certs: Json[]; billing: Json; refresh: () => void; toast: (m: string, bad?: boolean) => void }) {
  const current = certs.find((c) => c.id === billing.autoDscCertId);
  const [certId, setCertId] = useState<string>(current?.id ?? '');
  const [pin, setPin] = useState('');
  const chosen = certs.find((c) => c.id === certId);
  const save = async () => {
    if (!certId) return;
    if (!chosen?.autoPin && !pin.trim()) {
      toast('Enter the token PIN to save', true);
      return;
    }
    try {
      if (pin.trim()) await put(`/api/v1/organisation/dsc/${certId}/auto-pin`, { pin: pin.trim() });
      await put('/api/admin/billing/settings', { autoDscCertId: certId });
      setPin('');
      refresh();
      toast('Automatic token signing is on');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const turnOff = async () => {
    try {
      await put('/api/admin/billing/settings', { autoDscCertId: '' });
      if (billing.autoDscCertId) await del(`/api/v1/organisation/dsc/${billing.autoDscCertId}/auto-pin`).catch(() => {});
      refresh();
      toast('Automatic signing turned off');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack" style={{ gap: 8, marginTop: 6 }}>
      <p className="muted small" style={{ margin: 0 }}>
        Your certificates are on <b>USB tokens</b>. A token can’t sign on its own in the cloud — but if you keep the token plugged in, run the local signer, and save the PIN here, then <b>any open SanchalanOS tab on that laptop signs issued invoices automatically</b>, with no typing. Invoices made overnight sign the next time a tab is open there. (The PIN is stored encrypted. Saving it removes the token’s PIN protection, so do this only on a trusted machine.)
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 240 }}>
          Certificate
          <select value={certId} onChange={(e) => setCertId(e.target.value)}>
            <option value="">Choose a token certificate…</option>
            {certs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.subjectCn} — {c.label}
                {c.autoPin ? ' (PIN saved)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ minWidth: 160 }}>
          Token PIN
          <input type="password" value={pin} autoComplete="off" placeholder={chosen?.autoPin ? '•••• (saved — leave blank to keep)' : 'Token PIN'} onChange={(e) => setPin(e.target.value)} />
        </label>
        <button className="btn primary sm" onClick={save} disabled={!certId}>
          Turn on auto-signing
        </button>
        {billing.autoDscCertId && (
          <button className="btn ghost sm" onClick={turnOff}>
            Turn off
          </button>
        )}
      </div>
      {billing.autoDscCertId && current && (
        <span className="chip good">Auto-signing with {current.subjectCn} — keep the token plugged in and the signer running</span>
      )}
    </div>
  );
}

function WhoSigns({ users, value, onChange }: { users: Json[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="field">
      Who may sign with it
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {users.map((u) => (
          <label key={u.id} className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={value.includes(u.id)} onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))} />
            {u.name}
          </label>
        ))}
      </div>
    </div>
  );
}

function SigPick({ sigs, value, onChange }: { sigs: Json[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      Signature image on the document (optional)
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">None — the DSC stamp only</option>
        {sigs.map((s) => (
          <option key={s.id} value={s.id}>
            {s.signerName}
          </option>
        ))}
      </select>
    </label>
  );
}

function PfxModal({ d, sigs, onClose, onSaved }: { d: Json; sigs: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ label: '', pfx: '', password: '', userIds: [] as string[], signatureId: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Add a .pfx certificate"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !f.pfx || !f.label.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<Json>('/api/v1/organisation/dsc/pfx', { ...f, signatureId: f.signatureId || null });
              toast(`Added ${r.subjectCn}'s certificate (valid until ${fmtDate(r.validTo)})`);
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : 'Add'}
        </button>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          Name
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Harsha Rani — Class 3 signing" />
        </label>
        <label className="field">
          Certificate file (.pfx / .p12, with the private key)
          <input type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={async (e) => e.target.files?.[0] && setF({ ...f, pfx: await fileB64(e.target.files[0]) })} />
        </label>
        <label className="field">
          Its password
          <input type="password" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        <WhoSigns users={d.users} value={f.userIds} onChange={(userIds) => setF({ ...f, userIds })} />
        <SigPick sigs={sigs} value={f.signatureId} onChange={(signatureId) => setF({ ...f, signatureId })} />
        <p className="muted small" style={{ margin: 0 }}>
          The file and password are encrypted and kept by SanchalanOS; nobody can download them again. Remove the certificate here to delete them.
        </p>
      </div>
    </Modal>
  );
}

function PairModal({ onClose, onPaired }: { onClose: () => void; onPaired: (r: Json) => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  return (
    <Modal
      title="Pair a DSC signer"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!label.trim()}
          onClick={async () => {
            try {
              onPaired(await post<Json>('/api/v1/organisation/dsc-signers', { label }));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Pair
        </button>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          Which computer
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Prashant's laptop" autoFocus />
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          The signer is a small program (tools/dsc-signer) that runs on the computer where the USB token is plugged in. Pairing gives it a secret so it signs only what this workspace asks.
        </p>
      </div>
    </Modal>
  );
}

function TokenCertModal({ d, sigs, signers, onClose, onSaved }: { d: Json; sigs: Json[]; signers: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [found, setFound] = useState<Json[] | null>(null);
  const [pick, setPick] = useState<Json | null>(null);
  const [f, setF] = useState({ label: '', userIds: [] as string[], signatureId: '' });
  const read = async () => {
    try {
      const st = await local<{ signers: Json[] }>('/v1/status');
      if (!st.signers.some((x) => signers.some((p) => p.id === x.signer))) throw new Error('The signer on this computer is paired with another workspace');
      const r = await local<{ certificates: Json[] }>('/v1/certificates', { pin: pin || undefined });
      setFound(r.certificates);
      if (r.certificates.length === 1) setPick(r.certificates[0]!);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title="Add the token's certificate"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!pick || !f.label.trim()}
          onClick={async () => {
            try {
              const r = await post<Json>('/api/v1/organisation/dsc/token', { label: f.label, certPem: pick!.pem, userIds: f.userIds, signatureId: f.signatureId || null });
              toast(`Added ${r.subjectCn}'s token certificate`);
              onSaved();
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
      <div className="modal-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          With the token plugged in and the signer running on this computer, read the certificate from the token. Some tokens show certificates only after the PIN.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input type="password" autoComplete="off" placeholder="Token PIN (if needed)" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="btn sm" onClick={read}>
            Read from the token
          </button>
        </div>
        {found &&
          (found.length ? (
            found.map((c) => (
              <label key={c.thumbprint} className="row small" style={{ gap: 6 }}>
                <input type="radio" name="tokcert" checked={pick?.thumbprint === c.thumbprint} onChange={() => setPick(c)} />
                {c.label} <span className="muted mono">{c.thumbprint.slice(0, 12)}…</span>
              </label>
            ))
          ) : (
            <span className="small">No certificate found on the token.</span>
          ))}
        <label className="field">
          Name
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Prashant — USB token" />
        </label>
        <WhoSigns users={d.users} value={f.userIds} onChange={(userIds) => setF({ ...f, userIds })} />
        <SigPick sigs={sigs} value={f.signatureId} onChange={(signatureId) => setF({ ...f, signatureId })} />
      </div>
    </Modal>
  );
}

function CertEditModal({ d, sigs, cert, onClose, onSaved }: { d: Json; sigs: Json[]; cert: Json; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ label: cert.label, userIds: cert.userIds as string[], signatureId: cert.signatureId ?? '' });
  return (
    <Modal
      title={`${cert.subjectCn}'s certificate`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await put(`/api/v1/organisation/dsc/${cert.id}`, { ...f, signatureId: f.signatureId || null });
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
      <div className="modal-body stack">
        <label className="field">
          Name
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </label>
        <WhoSigns users={d.users} value={f.userIds} onChange={(userIds) => setF({ ...f, userIds })} />
        <SigPick sigs={sigs} value={f.signatureId} onChange={(signatureId) => setF({ ...f, signatureId })} />
        <p className="muted small mono" style={{ margin: 0, wordBreak: 'break-all' }}>
          {cert.subject} · serial {cert.serial} · SHA-1 {cert.thumbprint}
        </p>
      </div>
    </Modal>
  );
}

/** The one-time pairing command, for the computer with the USB token. */
function PairedModal({ code, onClose }: { code: string; onClose: () => void }) {
  const toast = useToast();
  const localDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const origins = localDev ? [...new Set([location.origin, 'http://localhost:5173', 'http://localhost:8787', 'http://127.0.0.1:5173', 'http://127.0.0.1:8787'])] : [location.origin];
  const flags = origins.map((o) => `--origin ${o}`).join(' ');
  const cmds = localDev ? [`pnpm dsc pair ${code} ${flags}`] : [`python dsc_signer.py pair ${code} ${flags}`];
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'));
  return (
    <Modal title="Signer paired" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="modal-body stack">
        <p className="small" style={{ margin: 0 }}>
          {localDev ? 'In a terminal in the project folder on this computer (the one with the USB token), run this once' : 'On the computer with the USB token, in the tools/dsc-signer folder, run this once'} — the code is shown only now:
        </p>
        {cmds.map((c) => (
          <div key={c} className="stack" style={{ gap: 6 }}>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--line-2)', padding: 10, borderRadius: 8, margin: 0 }}>
              {c}
            </pre>
            <button className="btn sm" onClick={() => copy(c)}>
              Copy
            </button>
          </div>
        ))}
        <p className="small muted" style={{ margin: 0 }}>
          {localDev
            ? 'pnpm local installs and starts the signer for you; it picks up the pairing at once. Then plug in the token and use “Add the token’s certificate”.'
            : 'Then start the signer (start-signer.bat), plug in the token and use “Add the token’s certificate”.'}
        </p>
      </div>
    </Modal>
  );
}

/**
 * The organisation's logo: any image, made into a PNG at most 600 px across (transparency kept) so it
 * stays small enough to travel with every document. Printed on invoices, quotes, orders and PDF reports
 * unless a document template sets its own.
 */
function LogoField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  const toast = useToast();
  const pick = async (f: File) => {
    if (!/^image\//.test(f.type)) return toast('Choose an image (PNG, JPG, SVG or WebP)', true);
    if (f.size > 8 * 1024 * 1024) return toast('That image is larger than 8 MB', true);
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Could not read that image'));
        i.src = url;
      });
      const w0 = img.naturalWidth || 600;
      const h0 = img.naturalHeight || 200;
      const k = Math.min(1, 600 / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * k));
      c.height = Math.max(1, Math.round(h0 * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const png = c.toDataURL('image/png');
      onChange(png.length > 380_000 ? c.toDataURL('image/jpeg', 0.85) : png);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center', minHeight: 40 }}>
      {value ? (
        <img src={value} alt="Organisation logo" style={{ maxHeight: 48, maxWidth: 160, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)', borderRadius: 6, padding: 4 }} />
      ) : (
        <span className="muted small">No logo yet</span>
      )}
      {!disabled && (
        <>
          <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
            {value ? 'Change' : '📎 Upload logo'}
            <input type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          </label>
          {value && (
            <button type="button" className="btn ghost sm" onClick={() => onChange('')}>
              Remove
            </button>
          )}
        </>
      )}
    </div>
  );
}

