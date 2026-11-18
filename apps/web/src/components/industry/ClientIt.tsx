/** Client IT: asset register with history, the credentials vault (reveals are logged) and technical documents. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, del, post, put } from '../../lib/api';
import { LookupPicker } from '../fields';
import { Markdown } from '../Markdown';
import { Modal } from '../ui';
import { d, Head, type Json, label, NoRows, useAct } from './kit';

const KINDS = ['laptop', 'desktop', 'server', 'network', 'printer', 'mobile', 'peripheral', 'software', 'license', 'cloud', 'domain', 'certificate', 'other'];

export function ClientAssets({ accountId }: { accountId?: string }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [renewing, setRenewing] = useState(false);
  const qs = new URLSearchParams({ ...(accountId ? { account: accountId } : {}), ...(q ? { q } : {}), ...(kind ? { kind } : {}), ...(renewing ? { renewing: '45' } : {}) }).toString();
  const { data } = useQuery({ queryKey: ['client-assets', qs], queryFn: () => get<{ items: Json[] }>(`/api/v1/client-assets?${qs}`) });
  const [edit, setEdit] = useState<Json | null>(null);
  const [hist, setHist] = useState<Json | null>(null);
  return (
    <>
      <Head title="Client assets" sub="Hardware, licences (with seats), cloud, domains and certificates you look after, who has each one, and when it renews.">
        <input placeholder="Name, serial, tag…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} aria-label="Search assets" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }} aria-label="Kind">
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {label(k)}
            </option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={renewing} onChange={(e) => setRenewing(e.target.checked)} /> Renewing soon
        </label>
        <button className="btn sm primary" onClick={() => setEdit({ accountId: accountId ?? '', kind: 'laptop', name: '', status: 'in_use' })}>
          Add asset
        </button>
      </Head>
      {data?.items.length ? (
        <div className="table-wrap">
          <table className="data" data-export-title="Client assets">
            <thead>
              <tr>
                <th>Asset</th>
                {!accountId && <th>Client</th>}
                <th>With</th>
                <th>Serial / tag</th>
                <th>Seats</th>
                <th>Renews / warranty</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.name}</b>
                    <div className="muted small">{[label(a.kind), a.make, a.model, a.location].filter(Boolean).join(' · ')}</div>
                  </td>
                  {!accountId && (
                    <td>
                      <Link to={`/o/account/${a.account_id}`}>{a.account}</Link>
                    </td>
                  )}
                  <td>{a.assigned_to ?? '—'}</td>
                  <td className="mono small">{[a.serial_no, a.asset_tag].filter(Boolean).join(' / ') || '—'}</td>
                  <td>{a.seats != null ? `${a.seats_used ?? 0} / ${a.seats}` : '—'}</td>
                  <td>
                    {a.next_date ? (
                      <>
                        {d(a.next_date)} {a.days_left != null && a.days_left <= 45 && <span className={`chip ${a.days_left < 0 ? 'bad' : 'warn'}`}>{a.days_left < 0 ? 'lapsed' : `${a.days_left} d`}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`chip${a.status === 'repair' ? ' warn' : a.status === 'retired' ? '' : ' good'}`}>{label(a.status)}</span>
                  </td>
                  <td className="row" style={{ gap: 4 }}>
                    <button className="btn sm" onClick={() => setHist(a)}>
                      History
                    </button>
                    <button
                      className="btn sm"
                      onClick={() =>
                        setEdit({
                          id: a.id, accountId: a.account_id, contactId: a.contact_id ?? '', kind: a.kind, name: a.name, make: a.make ?? '', model: a.model ?? '', serialNo: a.serial_no ?? '', assetTag: a.asset_tag ?? '',
                          location: a.location ?? '', vendorName: a.vendor_name ?? '', purchasedOn: a.purchased_on?.slice(0, 10) ?? '', cost: a.cost ?? '', warrantyEndsOn: a.warranty_ends_on?.slice(0, 10) ?? '',
                          renewsOn: a.renews_on?.slice(0, 10) ?? '', seats: a.seats ?? '', seatsUsed: a.seats_used ?? '', status: a.status, notes: a.notes ?? '',
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <NoRows>No assets recorded.</NoRows>
      )}
      {edit && <AssetModal a={edit} onClose={() => setEdit(null)} />}
      {hist && <AssetHistory a={hist} onClose={() => setHist(null)} />}
    </>
  );
}

function AssetModal({ a, onClose }: { a: Json; onClose: () => void }) {
  const [f, setF] = useState<Json>(a);
  const act = useAct([['client-assets']]);
  const I = (k: string, l: string, type = 'text') => (
    <label className="field">
      {l}
      <input type={type} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  const licence = ['software', 'license', 'cloud'].includes(f.kind);
  return (
    <Modal
      title={f.id ? f.name : 'Add an asset'}
      wide
      onClose={onClose}
      footer={
        <>
          {f.id && (
            <button className="btn danger" onClick={async () => window.confirm('Delete this asset and its history?') && (await act(() => del(`/api/v1/client-assets/${f.id}`), 'Deleted')) && onClose()}>
              Delete
            </button>
          )}
          <button
            className="btn primary"
            disabled={!f.accountId || !f.name}
            onClick={async () => {
              const n = (v: unknown) => (v === '' || v == null ? null : Number(v));
              const s = (v: unknown) => (v === '' || v == null ? null : String(v));
              const body = {
                accountId: f.accountId, contactId: s(f.contactId), kind: f.kind, name: f.name, make: s(f.make), model: s(f.model), serialNo: s(f.serialNo), assetTag: s(f.assetTag), location: s(f.location),
                vendorName: s(f.vendorName), purchasedOn: s(f.purchasedOn), cost: n(f.cost), warrantyEndsOn: s(f.warrantyEndsOn), renewsOn: s(f.renewsOn), seats: n(f.seats), seatsUsed: n(f.seatsUsed), status: f.status, notes: s(f.notes),
              };
              if (await act(() => (f.id ? put(`/api/v1/client-assets/${f.id}`, body) : post('/api/v1/client-assets', body)), 'Asset saved')) onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <div className="field">
          Client
          <LookupPicker id="as-acc" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </div>
        <label className="field">
          Kind
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </label>
        {I('name', 'Name')}
        <div className="field">
          With (contact)
          <LookupPicker id="as-con" objectKey="contact" value={f.contactId ?? ''} onChange={(v) => setF({ ...f, contactId: String(v ?? '') })} />
        </div>
        {I('make', 'Make')}
        {I('model', 'Model / plan')}
        {I('serialNo', licence ? 'Licence / subscription ID' : 'Serial number')}
        {I('assetTag', 'Asset tag')}
        {I('location', 'Location')}
        {I('vendorName', 'Bought from')}
        {I('purchasedOn', 'Bought on', 'date')}
        {I('cost', 'Cost (₹)', 'number')}
        {I('warrantyEndsOn', 'Warranty until', 'date')}
        {I('renewsOn', 'Renews on', 'date')}
        {licence && I('seats', 'Seats bought', 'number')}
        {licence && I('seatsUsed', 'Seats in use', 'number')}
        <label className="field">
          Status
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {['in_use', 'in_stock', 'repair', 'retired'].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

function AssetHistory({ a, onClose }: { a: Json; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['asset-history', a.id], queryFn: () => get<{ items: Json[] }>(`/api/v1/client-assets/${a.id}/history`) });
  const [note, setNote] = useState('');
  const act = useAct([['asset-history', a.id]]);
  return (
    <Modal title={`History · ${a.name}`} onClose={onClose}>
      <div className="modal-body stack">
        <div className="row" style={{ gap: 6 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (repair done, moved to Pune office…)" />
          <button className="btn sm" disabled={!note.trim()} onClick={async () => (await act(() => post(`/api/v1/client-assets/${a.id}/notes`, { note }), 'Noted')) && setNote('')}>
            Add
          </button>
        </div>
        <ul className="timeline">
          {(data?.items ?? []).map((e, i) => (
            <li key={i}>
              <b>{label(e.kind)}</b> {e.contact ? `→ ${e.contact}` : ''} {e.note ? `· ${e.note}` : ''}
              <div className="muted small">
                {d(e.at)} {e.actor ? `· ${e.actor}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

export function ClientVault({ accountId }: { accountId?: string }) {
  const { data } = useQuery({ queryKey: ['client-vault', accountId], queryFn: () => get<{ items: Json[] }>(`/api/v1/client-vault${accountId ? `?account=${accountId}` : ''}`) });
  const [edit, setEdit] = useState<Json | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const act = useAct([['client-vault']]);
  return (
    <>
      <Head title="Credentials vault" sub="Client passwords and keys, encrypted. Opening one is recorded (who and when).">
        <button className="btn sm primary" onClick={() => setEdit({ accountId: accountId ?? '', title: '', url: '', username: '', secret: '', notes: '' })}>
          Add credential
        </button>
      </Head>
      {data?.items.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>What</th>
              {!accountId && <th>Client</th>}
              <th>User name</th>
              <th>Password / key</th>
              <th>Last opened</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.title}</b>
                  {s.url && (
                    <div className="small">
                      <a href={/^https?:\/\//.test(s.url) ? s.url : `https://${s.url}`} target="_blank" rel="noreferrer">
                        {s.url}
                      </a>
                    </div>
                  )}
                </td>
                {!accountId && <td>{s.account}</td>}
                <td className="mono">{s.username ?? '—'}</td>
                <td className="mono">
                  {shown[s.id] ? (
                    <span className="row" style={{ gap: 4 }}>
                      {shown[s.id]}
                      <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(shown[s.id]!)}>
                        Copy
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const r = await act(() => post<{ secret: string }>(`/api/v1/client-vault/${s.id}/reveal`));
                        if (r) {
                          setShown((m) => ({ ...m, [s.id]: r.secret }));
                          setTimeout(() => setShown((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== s.id))), 30_000);
                        }
                      }}
                    >
                      Reveal
                    </button>
                  )}
                </td>
                <td className="small">{s.last_revealed_at ? `${d(s.last_revealed_at)} · ${s.last_revealed_by ?? ''}` : 'Never'}</td>
                <td>
                  <button className="btn sm" onClick={() => setEdit({ id: s.id, accountId: s.account_id, title: s.title, url: s.url ?? '', username: s.username ?? '', secret: '', notes: s.notes ?? '' })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>Nothing in the vault.</NoRows>
      )}
      {edit && (
        <Modal
          title={edit.id ? edit.title : 'Add a credential'}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this credential?') && (await act(() => del(`/api/v1/client-vault/${edit.id}`), 'Deleted')) && setEdit(null)}>
                  Delete
                </button>
              )}
              <button
                className="btn primary"
                disabled={!edit.accountId || !edit.title || (!edit.id && !edit.secret)}
                onClick={async () => {
                  const body = { accountId: edit.accountId, title: edit.title, url: edit.url || null, username: edit.username || null, secret: edit.secret || null, notes: edit.notes || null };
                  if (await act(() => (edit.id ? put(`/api/v1/client-vault/${edit.id}`, body) : post('/api/v1/client-vault', body)), 'Saved')) setEdit(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="field">
              Client
              <LookupPicker id="v-acc" objectKey="account" value={edit.accountId} onChange={(v) => setEdit({ ...edit, accountId: String(v ?? '') })} />
            </div>
            <label className="field">
              What it opens
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Firewall admin, AWS root, cPanel…" />
            </label>
            <label className="field">
              Address
              <input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
            </label>
            <label className="field">
              User name
              <input value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">
              {edit.id ? 'New password / key (leave blank to keep)' : 'Password / key'}
              <input type="password" value={edit.secret} onChange={(e) => setEdit({ ...edit, secret: e.target.value })} autoComplete="new-password" />
            </label>
            <label className="field">
              Notes
              <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

export function TechDocs({ accountId }: { accountId?: string }) {
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ ...(accountId ? { account: accountId } : {}), ...(q ? { q } : {}) }).toString();
  const { data } = useQuery({ queryKey: ['tech-docs', qs], queryFn: () => get<{ items: Json[] }>(`/api/v1/tech-docs?${qs}`) });
  const [open, setOpen] = useState<Json | null>(null);
  return (
    <>
      <Head title="Technical documents" sub="Runbooks, architecture, configuration and SOPs for each client (Markdown). Each save is a new version.">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} aria-label="Search documents" />
        <button className="btn sm primary" onClick={() => setOpen({ accountId: accountId ?? '', kind: 'runbook', title: '', body: '', editing: true })}>
          New document
        </button>
      </Head>
      {data?.items.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              {!accountId && <th>Client</th>}
              <th>Kind</th>
              <th>Version</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((x) => (
              <tr key={x.id} onClick={() => setOpen({ id: x.id })} style={{ cursor: 'pointer' }}>
                <td>
                  <b>{x.title}</b>
                </td>
                {!accountId && <td>{x.account}</td>}
                <td>{label(x.kind)}</td>
                <td>v{x.version}</td>
                <td className="small">
                  {d(x.updated_at)} · {x.updated_by ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No documents yet.</NoRows>
      )}
      {open && <DocModal init={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function DocModal({ init, onClose }: { init: Json; onClose: () => void }) {
  const doc = useQuery({ queryKey: ['tech-doc', init.id], queryFn: () => get<Json>(`/api/v1/tech-docs/${init.id}`), enabled: !!init.id });
  const [f, setF] = useState<Json | null>(init.id ? null : init);
  const act = useAct([['tech-docs'], ['tech-doc', init.id]]);
  const cur = f ?? (doc.data ? { id: doc.data.id, accountId: doc.data.account_id, kind: doc.data.kind, title: doc.data.title, body: doc.data.body ?? '', version: doc.data.version, account: doc.data.account } : null);
  if (!cur) return null;
  const editing = !!f?.editing;
  return (
    <Modal
      title={cur.title || 'New document'}
      wide
      onClose={onClose}
      footer={
        editing ? (
          <button
            className="btn primary"
            disabled={!cur.accountId || !cur.title}
            onClick={async () => {
              const body = { accountId: cur.accountId, kind: cur.kind, title: cur.title, body: cur.body || null };
              if (await act(() => (cur.id ? put(`/api/v1/tech-docs/${cur.id}`, body) : post('/api/v1/tech-docs', body)), 'Document saved')) onClose();
            }}
          >
            Save
          </button>
        ) : (
          <>
            <button className="btn danger" onClick={async () => window.confirm('Delete this document?') && (await act(() => del(`/api/v1/tech-docs/${cur.id}`), 'Deleted')) && onClose()}>
              Delete
            </button>
            <button className="btn primary" onClick={() => setF({ ...cur, editing: true })}>
              Edit
            </button>
          </>
        )
      }
    >
      <div className="modal-body stack">
        {editing ? (
          <>
            <div className="grid2">
              <div className="field">
                Client
                <LookupPicker id="doc-acc" objectKey="account" value={cur.accountId} onChange={(v) => setF({ ...cur, editing: true, accountId: String(v ?? '') })} />
              </div>
              <label className="field">
                Kind
                <select value={cur.kind} onChange={(e) => setF({ ...cur, editing: true, kind: e.target.value })}>
                  {['runbook', 'architecture', 'configuration', 'sop', 'network', 'other'].map((k) => (
                    <option key={k} value={k}>
                      {k === 'sop' ? 'SOP' : label(k)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Title
              <input value={cur.title} onChange={(e) => setF({ ...cur, editing: true, title: e.target.value })} />
            </label>
            <textarea rows={18} className="mono" value={cur.body} onChange={(e) => setF({ ...cur, editing: true, body: e.target.value })} placeholder="## Steps&#10;1. …" />
          </>
        ) : (
          <>
            <div className="muted small">
              {cur.account} · {label(cur.kind)} · version {cur.version}
            </div>
            <div className="md">
              <Markdown source={cur.body || "_Empty_"} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

