import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, patch, post, put } from '../lib/api';
import { money } from '../lib/format';
import { useMeta } from '../lib/hooks';
import { IN_STATES } from './QuoteEditor';
import { Empty, Modal, Spinner, useToast } from './ui';
import { del } from '../lib/api';

type Json = Record<string, any>;

/** Settings → Sales setup: letterhead/GST profile, price books, email templates. */
export function SalesSetup() {
  const [sub, setSub] = useState<'company' | 'prices' | 'templates'>('company');
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Sales setup" style={{ alignSelf: 'flex-start' }}>
        {([['company', 'Company & GST'], ['prices', 'Price books'], ['templates', 'Email templates']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={sub === k} aria-pressed={sub === k} onClick={() => setSub(k)}>
            {l}
          </button>
        ))}
      </div>
      {sub === 'company' && <CompanyProfile />}
      {sub === 'prices' && <PriceBooks />}
      {sub === 'templates' && <Templates />}
    </div>
  );
}

function CompanyProfile() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['tenant-settings'], queryFn: () => get<{ settings: Json; name: string }>('/api/admin/tenant') });
  const [c, setC] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setC({ legalName: data.name, ...(data.settings?.company ?? {}) });
  }, [data]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setC({ ...c, [k]: e.target.value });
  const gstinOk = !c.gstin || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(c.gstin);
  if (!data) return <Spinner />;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <p className="muted small" style={{ margin: 0 }}>
        Printed on quotes. When the customer’s state matches yours, quotes split GST into CGST + SGST; otherwise they show IGST.
      </p>
      <div className="grid2">
        <label className="field">
          Legal name
          <input value={c.legalName ?? ''} onChange={set('legalName')} />
        </label>
        <label className="field">
          GSTIN
          <input value={c.gstin ?? ''} onChange={(e) => setC({ ...c, gstin: e.target.value.toUpperCase() })} maxLength={15} className="mono" aria-invalid={!gstinOk} />
          {!gstinOk && <span className="field-error">That does not look like a GSTIN (15 characters, e.g. 29ABCDE1234F1Z5)</span>}
        </label>
        <label className="field wide">
          Address
          <input value={c.address ?? ''} onChange={set('address')} />
        </label>
        <label className="field">
          State
          <input value={c.state ?? ''} onChange={set('state')} list="in-states-setup" />
          <datalist id="in-states-setup">
            {IN_STATES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Phone
          <input value={c.phone ?? ''} onChange={set('phone')} />
        </label>
        <label className="field">
          Email
          <input type="email" value={c.email ?? ''} onChange={set('email')} />
        </label>
        <label className="field">
          Website
          <input value={c.website ?? ''} onChange={set('website')} placeholder="www.example.in" />
        </label>
        <label className="field wide">
          Default quote terms
          <textarea rows={4} value={c.quoteTerms ?? ''} onChange={set('quoteTerms')} placeholder={'Prices are exclusive of GST unless stated.\nPayment: 50% advance, balance on delivery.\nValid for 30 days.'} />
        </label>
      </div>
      <div>
        <button
          className="btn primary"
          disabled={!gstinOk}
          onClick={async () => {
            try {
              await patch('/api/admin/tenant', { settings: { company: c } });
              toast('Company details saved');
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save company details
        </button>
      </div>
    </div>
  );
}

function PriceBooks() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['price-books'], queryFn: () => get<{ items: Json[] }>('/api/v1/price-books') });
  const [selected, setSelected] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const book = data?.items.find((b) => b.id === selected) ?? data?.items[0];
  const entries = useQuery({ queryKey: ['price-book-entries', book?.id], queryFn: () => get<{ items: Json[] }>(`/api/v1/price-books/${book!.id}/entries`), enabled: !!book });
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => setEdits({}), [book?.id]);

  const save = async () => {
    try {
      await put(`/api/v1/price-books/${book!.id}/entries`, { entries: Object.entries(edits).map(([productId, v]) => ({ productId, unitPrice: v.trim() === '' ? null : Number(v.replace(/[,₹\s]/g, '')) })) });
      toast('Prices saved');
      setEdits({});
      qc.invalidateQueries({ queryKey: ['price-book-entries'] });
      qc.invalidateQueries({ queryKey: ['price-books'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          <select value={book?.id ?? ''} onChange={(e) => setSelected(e.target.value)} style={{ width: 'auto' }} aria-label="Price book">
            {data.items.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.is_default ? ' (default)' : ''}
                {b.is_active ? '' : ' — inactive'}
              </option>
            ))}
          </select>
          {book && !book.is_default && (
            <button className="btn sm" onClick={async () => { await patch(`/api/v1/price-books/${book.id}`, { isDefault: true }); qc.invalidateQueries({ queryKey: ['price-books'] }); }}>
              Make default
            </button>
          )}
          {book && !book.is_default && (
            <button className="btn sm" onClick={async () => { await patch(`/api/v1/price-books/${book.id}`, { isActive: !book.is_active }); qc.invalidateQueries({ queryKey: ['price-books'] }); }}>
              {book.is_active ? 'Deactivate' : 'Activate'}
            </button>
          )}
        </div>
        <div className="row">
          <button className="btn" onClick={() => setCreating(true)}>
            New price book
          </button>
          <button className="btn primary" disabled={!Object.keys(edits).length} onClick={save}>
            Save prices
          </button>
        </div>
      </div>
      {!entries.data ? (
        <Spinner />
      ) : !entries.data.items.length ? (
        <Empty title="No products yet">Add products under Products in the menu, then price them here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th className="num">List price</th>
                <th style={{ width: 180 }}>Price in “{book?.name}”</th>
                <th className="num">GST</th>
              </tr>
            </thead>
            <tbody>
              {entries.data.items.map((e) => (
                <tr key={e.product_id}>
                  <td>
                    {e.name}
                    {!e.is_active && <span className="muted small"> (inactive)</span>}
                  </td>
                  <td className="muted">{e.sku}</td>
                  <td className="num">{e.list_price === null ? '—' : money(e.list_price)}</td>
                  <td>
                    <input inputMode="decimal" aria-label={`Price for ${e.name}`} value={edits[e.product_id] ?? (e.unit_price === null ? '' : String(e.unit_price))} placeholder="Not sold in this book" onChange={(ev) => setEdits({ ...edits, [e.product_id]: ev.target.value })} />
                  </td>
                  <td className="num">{e.tax_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewBookModal
          books={data.items}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ['price-books'] });
            setSelected(id);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function NewBookModal({ books, onClose, onCreated }: { books: Json[]; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState(books.find((b) => b.is_default)?.id ?? '');
  return (
    <Modal
      title="New price book"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={async () => {
            try {
              const r = await post<{ id: string }>('/api/v1/price-books', { name: name.trim(), copyFrom: copyFrom || null });
              onCreated(r.id);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Create
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Partner, Government, Export" />
        </label>
        <label className="field">
          Start with prices from
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Empty</option>
            {books.map((b) => (
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

function Templates() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['email-templates', 'all'], queryFn: () => get<{ items: Json[] }>('/api/v1/email-templates') });
  const [editing, setEditing] = useState<Json | null>(null);
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Merge fields: {'{{first_name}}'}, {'{{company}}'}, {'{{name}}'}, {'{{amount}}'}, any field API name, plus {'{{me.full_name}}'}, {'{{company.name}}'}, {'{{today}}'} and {'{{quote_link}}'} on quotes.
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', subject: '', body: '', object_key: '', category: '', is_shared: true })}>
          New template
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Template</th>
              <th>For</th>
              <th>Shared</th>
              <th className="num">Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.name}</b>
                  <div className="muted small">{t.subject}</div>
                </td>
                <td>{t.object_key ? (meta?.objects.find((o) => o.key === t.object_key)?.plural ?? t.object_key) : 'Any record'}</td>
                <td>{t.is_shared ? 'Everyone' : `Only ${t.owner_name ?? 'owner'}`}</td>
                <td className="num">{t.use_count}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => setEditing(t)}>
                    Edit
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete “${t.name}”?`)) return;
                      await del(`/api/v1/email-templates/${t.id}`).catch((e) => toast((e as Error).message, true));
                      qc.invalidateQueries({ queryKey: ['email-templates'] });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit template' : 'New template'}
          wide
          onClose={() => setEditing(null)}
          footer={
            <button
              className="btn primary"
              disabled={!editing.name?.trim() || !editing.subject?.trim() || !editing.body?.trim()}
              onClick={async () => {
                const body = { name: editing.name, objectKey: editing.object_key || null, category: editing.category || null, subject: editing.subject, body: editing.body, isShared: !!editing.is_shared };
                try {
                  if (editing.id) await put(`/api/v1/email-templates/${editing.id}`, body);
                  else await post('/api/v1/email-templates', body);
                  toast('Template saved');
                  qc.invalidateQueries({ queryKey: ['email-templates'] });
                  setEditing(null);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Save template
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="field">
              Category
              <input value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="e.g. Follow-up" />
            </label>
            <label className="field">
              Use on
              <select value={editing.object_key ?? ''} onChange={(e) => setEditing({ ...editing, object_key: e.target.value })}>
                <option value="">Any record</option>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.plural}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ alignSelf: 'end', height: 34 }}>
              <input type="checkbox" checked={!!editing.is_shared} onChange={(e) => setEditing({ ...editing, is_shared: e.target.checked })} /> Shared with everyone
            </label>
            <label className="field wide">
              Subject
              <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
            </label>
            <label className="field wide">
              Message
              <textarea rows={10} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
