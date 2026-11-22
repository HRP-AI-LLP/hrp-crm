/**
 * Accounts desk → Import invoices: sales invoices raised elsewhere (Zoho, Tally, Excel, scans,
 * handwritten bills) are read, staged with what approving them would create, corrected by a person,
 * and only then created. Approved invoices keep their own numbers and are marked imported.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, patch, post } from '../../lib/api';
import { PdfPasswordError, readDocument, type ReadPart } from '../../lib/doc-read';
import { date, money2 } from '../../lib/format';
import { SelectAll } from '../SelectAll';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const PAY: Record<string, string> = { bank: 'Receipt in the bank', record: 'Record the receipt (no bank line)', later: 'Not paid yet / later' };
const ENGINE: Record<string, string> = { text: 'Read by rules', sheet: 'Spreadsheet', ai: 'Read by AI', vision: 'Read from picture (AI)' };

export function InvoiceImport() {
  const qc = useQueryClient();
  const toast = useToast();
  const batches = useQuery({ queryKey: ['books', 'imports'], queryFn: () => get<Json[]>('/api/v1/books/imports') });
  const [batch, setBatch] = useState<string | null>(null);
  const current = batch ?? batches.data?.[0]?.id ?? null;
  const items = useQuery({ queryKey: ['books', 'imports', current], queryFn: () => get<Json[]>(`/api/v1/books/imports/${current}`), enabled: !!current });
  const [progress, setProgress] = useState<{ name: string; state: string; error?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'pending' | 'failed' | 'approved' | 'rejected' | 'all'>('pending');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Json | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['books'] });

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const prog: { name: string; state: string; error?: boolean }[] = files.map((f) => ({ name: f.name, state: 'Reading…' }));
    setProgress([...prog]);
    const setP = (i: number, state: string, error = false) => {
      prog[i] = { ...prog[i]!, state, error };
      setProgress([...prog]);
    };
    try {
      const b = await post<Json>('/api/v1/books/imports', { name: files.length === 1 ? files[0]!.name : `${files.length} files` });
      setBatch(b.id);
      for (const [i, f] of files.entries()) {
        let parts: ReadPart[] = [];
        let password: string | undefined;
        for (;;) {
          try {
            parts = await readDocument(f, { password });
            break;
          } catch (e) {
            if (e instanceof PdfPasswordError) {
              const pw = window.prompt(`${f.name} is password-protected${e.wrong ? ' (wrong password)' : ''}. Password:`);
              if (pw) {
                password = pw;
                continue;
              }
              setP(i, 'Skipped (password-protected)', true);
            } else setP(i, (e as Error).message, true);
            parts = [];
            break;
          }
        }
        if (!parts.length) {
          if (!prog[i]?.error) setP(i, 'Nothing readable in the file', true);
          continue;
        }
        let n = 0;
        const notes: string[] = [];
        // a PDF with text goes to the server too: it is read there the same way as invoices that come by mail
        let pdf: string | undefined;
        if (!password && /\.pdf$/i.test(f.name) && f.size <= 15 * 1024 * 1024 && parts.some((x) => x.pages?.length)) {
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = '';
          for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode(...buf.subarray(k, k + 0x8000));
          pdf = btoa(bin);
        }
        for (const p of parts) {
          setP(i, p.images ? 'Reading the pictures with AI…' : 'Reading…');
          try {
            const r = await post<Json>(`/api/v1/books/imports/${b.id}/files`, { fileName: p.name, pages: p.pages, rows: p.rows, images: p.images, ...(pdf && p.pages ? { pdf } : {}) });
            n += r.invoices;
            if (r.note) notes.push(r.note);
          } catch (e) {
            notes.push((e as Error).message);
          }
        }
        setP(i, `${n} invoice(s)${notes.length ? ` — ${notes.join('; ')}` : ''}`, !n);
      }
      setFilter('pending');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await post<Json>('/api/v1/books/imports/items/approve', { ids });
      const bad = (r.results as Json[]).filter((x) => !x.ok);
      toast(
        `${r.approved} invoice(s) created${bad.length ? `; ${bad.length} need attention (${bad[0]?.error})` : ''}${r.bookkeeper ? `. Bookkeeper: ${r.bookkeeper.applied} booked, ${r.bookkeeper.waiting} for review` : ''}`,
        bad.length > 0,
      );
      setSel(new Set());
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const reject = async (id: string) => {
    try {
      await post(`/api/v1/books/imports/items/${id}/reject`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const all = items.data ?? [];
  const rows = all.filter((x) => filter === 'all' || x.status === filter);
  const selectable = rows.filter((x) => x.status === 'pending' || x.status === 'failed');
  const count = (s: string) => all.filter((x) => x.status === s).length;
  return (
    <div className="stack">
      <section className="panel" style={{ padding: 14 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b>Import invoices you raised elsewhere</b>
            <div className="muted small">
              PDFs from Zoho, Tally or any software, Excel / CSV registers or exports, and scans or photos of printed or handwritten bills — many files at once, several invoices per file. Each invoice is read
              and staged with what it would create (customer, contact, project, the invoice under its own number, the receipt from the bank); nothing is created until you approve it. Scans and handwriting are
              read by your AI model (Settings → AI models).
            </div>
          </div>
          <label className={`btn sm primary${busy ? ' disabled' : ''}`}>
            {busy ? 'Working…' : 'Choose files'}
            <input
              type="file"
              hidden
              multiple
              disabled={busy}
              accept=".pdf,.xlsx,.xls,.csv,.tsv,.txt,.jpg,.jpeg,.png,.webp,image/*,application/pdf"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = '';
                void upload(list);
              }}
            />
          </label>
        </div>
        {progress.length > 0 && (
          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {progress.map((p, i) => (
              <li key={i} style={{ color: p.error ? 'var(--bad)' : undefined }}>
                <b>{p.name}</b>: {p.state}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(batches.data ?? []).length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={current ?? ''} onChange={(e) => setBatch(e.target.value)}>
            {(batches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {new Date(b.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {b.name ?? 'Import'} · {b.items} invoice(s), {b.pending} waiting
              </option>
            ))}
          </select>
          <div className="seg">
            {(['pending', 'failed', 'approved', 'rejected', 'all'] as const).map((k) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {k === 'pending' ? `Waiting (${count('pending')})` : k === 'failed' ? `Need fixing (${count('failed')})` : k === 'approved' ? `Created (${count('approved')})` : k === 'rejected' ? `Rejected (${count('rejected')})` : 'All'}
              </button>
            ))}
          </div>
          {(filter === 'pending' || filter === 'failed') && count(filter) > 0 && (
            <button
              className="btn sm ghost"
              disabled={busy}
              title="Set aside everything waiting in this import, e.g. to import the files again"
              onClick={async () => {
                if (!window.confirm('Set aside every invoice still waiting in this import? Nothing is created; you can import the files again.')) return;
                try {
                  const r = await post<Json>('/api/v1/books/imports/reject-waiting', { importId: current });
                  toast(`${r.rejected} set aside`);
                  refresh();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Discard all waiting
            </button>
          )}
          {(filter === 'pending' || filter === 'failed') && (
            <button className="btn sm primary" disabled={busy || !sel.size} onClick={() => approve([...sel])}>
              Approve selected{sel.size ? ` (${sel.size})` : ''}
            </button>
          )}
        </div>
      )}

      {!current ? (
        <Empty title="No imports yet">Choose your invoice files above. You will review every invoice before anything is created.</Empty>
      ) : !items.data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title="Nothing here">{filter === 'pending' ? 'Every invoice of this import has been decided.' : 'No invoices with this status.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <SelectAll ids={selectable.map((x) => x.id)} sel={sel} setSel={setSel} />
                </th>
                <th>Invoice</th>
                <th>Customer</th>
                <th className="num">Total</th>
                <th>Paid</th>
                <th>Will create</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const d = x.data;
                const pl = x.plan ?? {};
                const can = x.status === 'pending' || x.status === 'failed';
                return (
                  <tr key={x.id}>
                    <td>
                      {can && (
                        <input
                          type="checkbox"
                          checked={sel.has(x.id)}
                          onChange={() =>
                            setSel((s) => {
                              const n = new Set(s);
                              if (n.has(x.id)) n.delete(x.id);
                              else n.add(x.id);
                              return n;
                            })
                          }
                        />
                      )}
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 220 }}>
                      <b>{d.number ?? '— no number —'}</b>
                      <div className="muted small">{d.date ? date(d.date) : 'no date'}</div>
                      <div className="muted small" style={{ wordBreak: 'break-word' }}>
                        {x.source_file}
                        {x.pages ? ` · ${/^row/.test(x.pages) ? x.pages : `p. ${x.pages}`}` : ''}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>
                      {pl.customer?.id ? pl.customer.name : (d.customer?.name ?? '— no name —')}{' '}
                      <span className={`chip ${pl.customer?.id ? 'good' : 'info'}`}>{pl.customer?.id ? (pl.customer.by === 'gstin' ? 'existing (GSTIN)' : 'existing') : 'new'}</span>
                      {d.customer?.gstin && <div className="muted small">{d.customer.gstin}</div>}
                    </td>
                    <td className="num">
                      {d.total != null ? money2(d.total) : '—'}
                      <div className="muted small">tax {money2((d.cgst ?? 0) + (d.sgst ?? 0) + (d.igst ?? 0))}</div>
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 220 }} className="small">
                      <span className={`chip ${d.paid?.status === 'paid' ? 'good' : d.paid?.status === 'unpaid' ? '' : 'warn'}`}>{d.paid?.status ?? 'unknown'}</span>
                      <div>
                        {pl.payment?.mode === 'bank' && pl.payment.bank ? `Bank ${date(pl.payment.bank.date)} ${money2(pl.payment.bank.amount)}${pl.payment.bank.tds ? ` + TDS ${money2(pl.payment.bank.tds)}` : ''}` : PAY[pl.payment?.mode] ?? ''}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>
                      {x.status === 'approved' ? (
                        <span className="chip good">Created</span>
                      ) : (
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {!pl.customer?.id && <span className="chip">Customer</span>}
                          {pl.contact && <span className="chip">Contact</span>}
                          {pl.project?.new && <span className="chip">Project</span>}
                          {pl.deal && <span className="chip" title={pl.recurring ? `Recurring: ${pl.recurring.name}` : ''}>Deal: {pl.deal.name}</span>}
                          {d.taxInclusive && <span className="chip">incl. GST</span>}
                          <span className="chip">Invoice</span>
                          {pl.payment?.mode !== 'later' && <span className="chip">Receipt</span>}
                        </div>
                      )}
                      <div className="muted small">
                        {ENGINE[x.engine] ?? x.engine} · {Math.round(x.confidence * 100)}%
                      </div>
                      {x.error && <div className="small" style={{ color: 'var(--bad)' }}>{x.error}</div>}
                      {x.warnings?.length > 0 && x.status !== 'approved' && (
                        <div className="small" style={{ color: '#9a3412' }} title={(x.warnings as string[]).join('\n')}>
                          ⚠ {x.warnings[0]}
                          {x.warnings.length > 1 ? ` (+${x.warnings.length - 1})` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {can ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <button className="btn sm primary" disabled={busy} onClick={() => approve([x.id])}>
                            Approve
                          </button>
                          <button className="btn sm" onClick={() => setEdit(x)}>
                            Review &amp; edit
                          </button>
                          <button className="btn sm ghost" onClick={() => reject(x.id)}>
                            Reject
                          </button>
                        </div>
                      ) : x.status === 'rejected' ? (
                        <button className="btn sm ghost" onClick={() => setEdit(x)}>
                          Bring back
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edit && <EditInvoice item={edit} onClose={() => setEdit(null)} onDone={refresh} onApprove={(id) => approve([id])} />}
    </div>
  );
}

const n2 = (v: unknown) => (v === '' || v == null ? null : Number(v));

function EditInvoice({ item, onClose, onDone, onApprove }: { item: Json; onClose: () => void; onDone: () => void; onApprove: (id: string) => void }) {
  const toast = useToast();
  const [d, setD] = useState<Json>(() => JSON.parse(JSON.stringify(item.data)));
  const [plan, setPlan] = useState<Json>(item.plan ?? {});
  const [ch, setCh] = useState<Json>(() => ({ ...(item.plan?.choices ?? {}) }));
  const [busy, setBusy] = useState(false);
  const customers = useQuery({ queryKey: ['books', 'parties', 'accounts_receivable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/account?limit=200&sort=name&dir=asc') });
  const projects = useQuery({ queryKey: ['records', 'project', 'all'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/project?limit=200').catch(() => ({ items: [] })) });
  const banks = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts') });
  const deals = useQuery({ queryKey: ['records', 'deal', 'import'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/deal?limit=200&sort=updated_at&dir=desc').catch(() => ({ items: [] })) });
  const tax = (Number(d.cgst) || 0) + (Number(d.sgst) || 0) + (Number(d.igst) || 0);
  const linesSum = (d.lines as Json[]).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const setC = (k: string, v: unknown) => setD({ ...d, customer: { ...d.customer, [k]: v } });
  const setLine = (i: number, k: string, v: unknown) => setD({ ...d, lines: (d.lines as Json[]).map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const clean = () => ({
    ...d,
    taxable: n2(d.taxable),
    cgst: Number(d.cgst) || 0,
    sgst: Number(d.sgst) || 0,
    igst: Number(d.igst) || 0,
    total: n2(d.total),
    number: d.number || null,
    date: d.date || null,
    dueDate: d.dueDate || null,
    customer: Object.fromEntries(Object.entries(d.customer).map(([k, v]) => [k, v === '' ? null : v])),
    lines: (d.lines as Json[]).map((l) => ({ description: String(l.description || 'Item'), hsn: l.hsn || null, qty: Number(l.qty) || 1, rate: Number(l.rate) || 0, taxRate: Number(l.taxRate) || 0, amount: Number(l.amount) || 0 })),
    paid: { ...d.paid, amount: n2(d.paid?.amount) },
    taxInclusive: !!d.taxInclusive,
    subject: d.subject || null,
    customerRef: d.customerRef || null,
  });
  const save = async (andApprove = false) => {
    setBusy(true);
    try {
      const r = await patch<Json>(`/api/v1/books/imports/items/${item.id}`, { data: clean(), choices: Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== '' && v !== undefined)) });
      setPlan(r.plan);
      onDone();
      if (andApprove) {
        onApprove(item.id);
        onClose();
      } else toast('Saved');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const ai = async () => {
    setBusy(true);
    try {
      const r = await post<Json>(`/api/v1/books/imports/items/${item.id}/ai`);
      setD(r.data);
      setPlan(r.plan);
      toast(`Read again by ${r.model}`);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const pay = ch.payment ?? plan.payment?.mode ?? 'later';
  return (
    <Modal
      title={`Invoice ${d.number ?? ''} from ${item.source_file}`}
      onClose={onClose}
      wide
      footer={
        <>
          {item.has_text && (
            <button className="btn ghost" disabled={busy} onClick={ai} title="Uses your AI model">
              Read again with AI
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => save(false)}>
            Save
          </button>
          <button className="btn primary" disabled={busy} onClick={() => save(true)}>
            Save &amp; approve
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        {(plan.warnings ?? item.warnings ?? []).length > 0 && (
          <div className="small" style={{ background: '#fff7ed', padding: 8, borderRadius: 8, color: '#9a3412' }}>
            {((plan.warnings?.length ? plan.warnings : item.warnings) as string[]).map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="field">
            Invoice number
            <input value={d.number ?? ''} onChange={(e) => setD({ ...d, number: e.target.value })} />
          </label>
          <label className="field">
            Date
            <input type="date" value={d.date ?? ''} onChange={(e) => setD({ ...d, date: e.target.value })} />
          </label>
          <label className="field">
            Due date
            <input type="date" value={d.dueDate ?? ''} onChange={(e) => setD({ ...d, dueDate: e.target.value })} />
          </label>
          <label className="field">
            P.O. / order no.
            <input value={d.customerRef ?? ''} onChange={(e) => setD({ ...d, customerRef: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Subject
          <input value={d.subject ?? ''} onChange={(e) => setD({ ...d, subject: e.target.value })} />
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!d.taxInclusive} onChange={(e) => setD({ ...d, taxInclusive: e.target.checked })} />
          The line amounts include GST (“Tax inclusive” on the document)
        </label>

        <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            Customer
          </legend>
          <label className="field">
            Existing customer, or a new one
            <select value={ch.customerId ?? ''} onChange={(e) => setCh({ ...ch, customerId: e.target.value || null })}>
              <option value="">{plan.customer?.id && !ch.customerId ? `Found: ${plan.customer.name}` : 'New customer (from the details below)'}</option>
              {(customers.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <label className="field" style={{ flex: 2 }}>
              Name
              <input value={d.customer.name ?? ''} onChange={(e) => setC('name', e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              GSTIN
              <input value={d.customer.gstin ?? ''} onChange={(e) => setC('gstin', e.target.value.toUpperCase())} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              State
              <input value={d.customer.state ?? ''} onChange={(e) => setC('state', e.target.value)} />
            </label>
          </div>
          <label className="field" style={{ marginTop: 6 }}>
            Address
            <input value={d.customer.address ?? ''} onChange={(e) => setC('address', e.target.value)} />
          </label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <label className="field" style={{ flex: 1 }}>
              Contact person
              <input value={d.customer.contact ?? ''} onChange={(e) => setC('contact', e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              Email
              <input value={d.customer.email ?? ''} onChange={(e) => setC('email', e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              Phone
              <input value={d.customer.phone ?? ''} onChange={(e) => setC('phone', e.target.value)} />
            </label>
          </div>
          <label className="row small" style={{ gap: 6, marginTop: 6 }}>
            <input type="checkbox" checked={ch.createContact ?? !!(d.customer.contact || d.customer.email)} onChange={(e) => setCh({ ...ch, createContact: e.target.checked })} />
            Add the contact person to the customer
          </label>
        </fieldset>

        <label className="field">
          Deal
          <select
            value={ch.dealId === null ? '__none' : (ch.dealId ?? '')}
            onChange={(e) => setCh({ ...ch, dealId: e.target.value === '__none' ? null : e.target.value || undefined, recurringProfileId: undefined })}
          >
            <option value="">{plan.deal ? `Found: ${plan.deal.name}${plan.recurring ? ` (recurring: ${plan.recurring.name})` : ''}` : 'No deal found'}</option>
            <option value="__none">No deal</option>
            {(deals.data?.items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Project
          <select
            value={ch.projectId ? ch.projectId : ch.newProject != null ? '__new' : ''}
            onChange={(e) => setCh({ ...ch, projectId: e.target.value && e.target.value !== '__new' ? e.target.value : null, newProject: e.target.value === '__new' ? (ch.newProject ?? d.project ?? '') : null })}
          >
            <option value="">{plan.project ? `${plan.project.new ? 'New' : 'Existing'}: ${plan.project.name}` : 'No project'}</option>
            <option value="__new">➕ New project…</option>
            {(projects.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {ch.newProject != null && <input style={{ marginTop: 4 }} placeholder="Project name" value={ch.newProject} onChange={(e) => setCh({ ...ch, newProject: e.target.value })} />}
        </label>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Description</th>
                <th>HSN/SAC</th>
                <th className="num">Qty</th>
                <th className="num">Taxable</th>
                <th className="num">GST %</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(d.lines as Json[]).map((l, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'normal' }}>
                    <input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} style={{ width: '100%', minWidth: 200 }} />
                  </td>
                  <td>
                    <input value={l.hsn ?? ''} onChange={(e) => setLine(i, 'hsn', e.target.value)} style={{ width: 90 }} />
                  </td>
                  <td>
                    <input type="number" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} style={{ width: 70 }} />
                  </td>
                  <td>
                    <input type="number" value={l.amount} onChange={(e) => setLine(i, 'amount', e.target.value)} style={{ width: 110 }} />
                  </td>
                  <td>
                    <select value={l.taxRate} onChange={(e) => setLine(i, 'taxRate', Number(e.target.value))}>
                      {[0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28, 40].map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="btn sm ghost" onClick={() => setD({ ...d, lines: (d.lines as Json[]).filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn sm ghost" style={{ marginTop: 4 }} onClick={() => setD({ ...d, lines: [...d.lines, { description: '', hsn: '', qty: 1, rate: 0, taxRate: 18, amount: 0 }] })}>
            + Add line
          </button>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(['taxable', 'cgst', 'sgst', 'igst', 'total'] as const).map((k) => (
            <label key={k} className="field" style={{ width: 120 }}>
              {k === 'taxable' ? 'Taxable' : k === 'total' ? 'Total' : k.toUpperCase()}
              <input type="number" value={d[k] ?? ''} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="muted small">
          Lines add up to {money2(linesSum)}
          {d.taxable != null && Math.abs(linesSum - Number(d.taxable)) > 1 ? ' — not the taxable value' : ''} · taxable + tax = {money2((Number(d.taxable) || 0) + tax)}
          {d.total != null && Math.abs((Number(d.taxable) || 0) + tax - Number(d.total)) > 1 ? ` — not the total ${money2(Number(d.total))}` : ''}. SanchalanOS recalculates the tax from the lines; approval stops if its total differs from the document by more than ₹1.
        </div>

        <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            Payment
          </legend>
          <div className="row small" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span>
              Document says: <b>{d.paid?.status}</b>
            </span>
            <select value={d.paid?.status ?? 'unknown'} onChange={(e) => setD({ ...d, paid: { ...d.paid, status: e.target.value } })}>
              {['paid', 'partial', 'unpaid', 'unknown'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {(['bank', 'record', 'later'] as const).map((m) => (
            <label key={m} className="row small" style={{ gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
              <input type="radio" checked={pay === m} onChange={() => setCh({ ...ch, payment: m })} style={{ marginTop: 3 }} />
              <span style={{ flex: 1 }}>
                <b>{PAY[m]}</b>
                {m === 'bank' && (
                  <>
                    {(plan.payment?.candidates ?? []).length ? (
                      <select
                        style={{ display: 'block', marginTop: 4, width: '100%' }}
                        value={ch.bankTxnId ?? plan.payment?.bank?.id ?? ''}
                        onChange={(e) => setCh({ ...ch, payment: 'bank', bankTxnId: e.target.value || null })}
                      >
                        <option value="">Choose the bank line</option>
                        {(plan.payment.candidates as Json[]).map((c) => (
                          <option key={c.id} value={c.id}>
                            {date(c.date)} · {money2(c.amount)}
                            {c.tds ? ` (+TDS ${money2(c.tds)})` : ''} · {c.description.slice(0, 70)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="muted">No unbooked receipt of this amount in the bank lines yet. Upload the statement that has it, then open this again.</div>
                    )}
                  </>
                )}
                {m === 'record' && pay === 'record' && (
                  <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    <input type="date" value={ch.paidDate ?? d.paid?.date ?? d.date ?? ''} onChange={(e) => setCh({ ...ch, paidDate: e.target.value })} />
                    <select value={ch.depositAccountId ?? ''} onChange={(e) => setCh({ ...ch, depositAccountId: e.target.value || null })}>
                      <option value="">Into the main bank account</option>
                      {(banks.data ?? [])
                        .filter((b) => ['bank', 'cash'].includes(b.kind))
                        .map((b) => (
                          <option key={b.gl_account_id} value={b.gl_account_id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                    <span className="muted">Use this for cash, or receipts before your bank statements start.</span>
                  </div>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        {item.has_text && <div className="muted small">Compare with the document: “Read again with AI” replaces this reading with your AI model's.</div>}
      </div>
    </Modal>
  );
}
