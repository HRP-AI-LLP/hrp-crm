/**
 * Settings → Document templates: how invoices (and quotes, orders, purchase orders) look. Built-in
 * designs with your colours, logo, columns and wording; your letterhead with the document laid inside
 * its margins (designed on top of it); HTML templates with placeholders; or a design made by AI from a
 * description (and your letterhead's look). One template is the default for each kind of document.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put } from '../../lib/api';
import { TemplatedDocument } from '../DocTemplateView';
import type { DocLabels, DocTemplate, QuoteDoc } from '../QuoteDocument';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type Settings = DocTemplate['settings'];

const BASES: [DocTemplate['base'], string, string][] = [
  ['classic', 'Classic', 'Coloured header band and line table; the familiar GST layout'],
  ['modern', 'Modern', 'Light, airy, an accent stripe on top and rounded boxes'],
  ['compact', 'Compact', 'Tighter spacing and smaller type: long invoices on fewer pages'],
  ['gst_detailed', 'GST detailed', 'CGST / SGST / IGST on every line, ruled table'],
  ['letterhead', 'Your letterhead', 'Upload your letterhead (image or PDF) and lay the invoice inside it'],
  ['html', 'HTML template', 'Full control: HTML and CSS with placeholders'],
];
const KINDS: [string, string][] = [
  ['invoice', 'Invoices'],
  ['quote', 'Quotes'],
  ['sales_order', 'Sales orders'],
  ['purchase_order', 'Purchase orders'],
];
const DEFAULT_SETTINGS: Settings = {
  accent: '#075492',
  accent2: '#06a6c7',
  text: '#0f172a',
  font: 'sans',
  fontSize: 12.5,
  logo: null,
  logoPosition: 'left',
  showCompany: true,
  showGstSummary: true,
  showWords: true,
  showBank: true,
  showSignature: true,
  showQr: true,
  columns: { hsn: true, qty: true, rate: true, discount: true, taxable: true, gst: true },
  labels: {},
  headerNote: null,
  footerNote: null,
  margins: { top: 45, bottom: 30, left: 15, right: 15 },
};

const STARTER_HTML = `<style>
  .inv { font-family: Georgia, serif; color: #1f2937; }
  .top { display: flex; justify-content: space-between; border-bottom: 2px solid #111827; padding-bottom: 8px; }
  .top h1 { margin: 0; font-size: 22px; }
  table.l { width: 100%; border-collapse: collapse; margin-top: 14px; }
  table.l th { text-align: left; border-bottom: 1px solid #111827; padding: 4px; font-size: 11px; }
  table.l td { border-bottom: 1px solid #e5e7eb; padding: 4px; }
  .r { text-align: right; }
  .tot { margin-left: auto; margin-top: 10px; width: 260px; }
  .sig { margin-top: 30px; text-align: right; }
</style>
<div class="inv">
  <div class="top">
    <div>{{{company.logo_img}}}<h1>{{company.name}}</h1><div>{{company.address}}</div><div>GSTIN {{company.gstin}}</div></div>
    <div class="r"><h1>{{doc.title}}</h1><div># {{doc.number}}</div><div>Date {{doc.date}}</div><div>Due {{doc.due_date}}</div></div>
  </div>
  <p><b>Bill to:</b> {{bill_to.name}}<br>{{bill_to.address}}<br>{{bill_to.state}} {{#bill_to.gstin}}· GSTIN {{bill_to.gstin}}{{/bill_to.gstin}}</p>
  <p><b>Subject:</b> {{doc.subject}}</p>
  <table class="l">
    <tr><th>#</th><th>Item</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">Amount</th></tr>
    {{#lines}}<tr><td>{{n}}</td><td>{{name}}<div style="color:#6b7280">{{description}}</div></td><td>{{hsn}}</td><td class="r">{{qty}}</td><td class="r">{{rate}}</td><td class="r">{{taxable}}</td><td class="r">{{gst_rate}}</td><td class="r">{{amount}}</td></tr>{{/lines}}
  </table>
  <table class="tot">
    <tr><td>Subtotal</td><td class="r">{{totals.subtotal}}</td></tr>
    {{#totals.intra}}<tr><td>CGST</td><td class="r">{{totals.cgst}}</td></tr><tr><td>SGST</td><td class="r">{{totals.sgst}}</td></tr>{{/totals.intra}}
    {{^totals.intra}}<tr><td>IGST</td><td class="r">{{totals.igst}}</td></tr>{{/totals.intra}}
    <tr><td><b>Total</b></td><td class="r"><b>{{totals.total}}</b></td></tr>
  </table>
  <p><i>{{totals.in_words}}</i></p>
  <p style="white-space:pre-wrap">{{bank_details}}</p>
  <div class="sig">{{{signatures_html}}}</div>
</div>`;

/** A sample invoice to preview with: the organisation's own details and two lines. */
function useSample(): { doc: QuoteDoc; labels: DocLabels } | null {
  const org = useQuery({ queryKey: ['organisation'], queryFn: () => get<Json>('/api/v1/organisation'), staleTime: 60_000 });
  return useMemo(() => {
    const p = org.data?.profile;
    if (!p) return null;
    const lines = [
      { name: 'Website development', description: 'Design, build and launch', hsnSac: '998314', unit: 'Nos', quantity: 1, unitPrice: 10000, discountPct: 0, taxRate: 18, lineSubtotal: 10000, lineTax: 1800, lineTotal: 11800 },
      { name: 'Monthly maintenance', description: 'November 2026', hsnSac: '998313', unit: 'Month', quantity: 1, unitPrice: 1200, discountPct: 0, taxRate: 18, lineSubtotal: 1016.95, lineTax: 183.05, lineTotal: 1200 },
    ];
    return {
      doc: {
        quote: { name: 'Website and maintenance', subject: 'Website and maintenance', doc_date: '2026-11-01', subtotal: 11016.95, discount_total: 0, tax_total: 1983.05, grand_total: 13000, round_off: 0, currency: 'INR', bill_to: { name: 'Sindhu Manthan Foundation', address: 'Ravi Enclave, Sector-87, Noida', state: p.state || 'Uttar Pradesh', gstin: '' }, notes: 'Thanks for your business.', terms: 'Payment within the due date.' },
        lines,
        account: null,
        contact: null,
        company: { name: p.legalName, address: [p.address, p.city, p.pincode].filter(Boolean).join(', '), state: p.state, gstin: p.gstin, email: p.email, phone: p.phone, website: p.website },
      },
      labels: { title: 'Tax invoice', numberLabel: 'Invoice #', number: 'INV/26-27/0001', party: 'Bill to', rows: [['Terms', 'Due end of the month'], ['Due date', '30 Nov 2026'], ['Place of supply', `${p.state || 'Uttar Pradesh'}`]], footerNote: 'Bank: Yes Bank · A/c 0173 8460 0001 234 · IFSC YESB0000173' },
    };
  }, [org.data]);
}

export function DocTemplatesTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['doc-templates'], queryFn: () => get<{ templates: Json[]; canEdit: boolean }>('/api/v1/doc-templates') });
  const [edit, setEdit] = useState<Json | null>(null);
  const [pick, setPick] = useState(false);
  const [defaultsFor, setDefaultsFor] = useState<Json | null>(null);
  const sample = useSample();
  if (q.isLoading) return <Spinner />;
  const list = q.data?.templates ?? [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['doc-templates'] });
    qc.invalidateQueries({ queryKey: ['doc-template'] });
  };
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        How your invoices, quotes, orders and purchase orders look when printed, shared or signed. The default template of each kind is used for every document Synapse makes; the print page can switch to another for one print.
      </p>
      {q.data?.canEdit && (
        <div>
          <button className="btn primary sm" onClick={() => setPick(true)}>
            New template
          </button>
        </div>
      )}
      {!list.length ? (
        <Empty title="No templates yet">Documents print in the classic design. Make one from a design, your letterhead, HTML or AI.</Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {list.map((t) => (
            <div key={t.id} className="panel" style={{ padding: 10 }}>
              <div style={{ height: 300, overflow: 'hidden', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--line-2)', position: 'relative' }}>
                {sample && (
                  <div style={{ transform: 'scale(0.31)', transformOrigin: 'top left', width: '210mm', pointerEvents: 'none' }}>
                    <TemplatedDocument doc={sample.doc} labels={sample.labels} template={t as DocTemplate} />
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <b>{t.name}</b> <span className="muted small">· {BASES.find(([k]) => k === t.base)?.[1]}</span>
              </div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap', minHeight: 22 }}>
                {(t.defaults as string[]).map((k) => (
                  <span key={k} className="chip good">
                    Default for {KINDS.find(([x]) => x === k)?.[1].toLowerCase()}
                  </span>
                ))}
              </div>
              {q.data?.canEdit && (
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn sm" onClick={() => setEdit(t)}>
                    Edit
                  </button>
                  <button className="btn ghost sm" onClick={() => setDefaultsFor(t)}>
                    Use for…
                  </button>
                  <button className="btn ghost sm" onClick={() => setEdit({ ...t, id: undefined, name: `${t.name} (copy)`, defaults: [] })}>
                    Copy
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={async () => {
                      if (!confirm(`Delete “${t.name}”? Documents fall back to another default or the classic design.`)) return;
                      await del(`/api/v1/doc-templates/${t.id}`).catch((e) => toast((e as Error).message, true));
                      refresh();
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {pick && (
        <Modal title="New template" onClose={() => setPick(false)}>
          <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {BASES.map(([k, l, d]) => (
              <button
                key={k}
                className="panel"
                style={{ padding: 12, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => {
                  setPick(false);
                  setEdit({ name: l, base: k, settings: { ...DEFAULT_SETTINGS, showCompany: k !== 'letterhead' }, letterhead: null, html: k === 'html' ? STARTER_HTML : null, defaults: [] });
                }}
              >
                <b>{l}</b>
                <div className="muted small">{d}</div>
              </button>
            ))}
            <button
              className="panel"
              style={{ padding: 12, textAlign: 'left', cursor: 'pointer', borderColor: 'var(--brand, #075492)' }}
              onClick={() => {
                setPick(false);
                setEdit({ name: 'AI design', base: 'modern', settings: { ...DEFAULT_SETTINGS }, letterhead: null, html: null, defaults: [], _ai: true });
              }}
            >
              <b>✨ Design with AI</b>
              <div className="muted small">Describe the look (and add your letterhead); AI designs it, you adjust it</div>
            </button>
          </div>
        </Modal>
      )}
      {edit && <TemplateEditor initial={edit} sample={sample} onClose={() => setEdit(null)} onSaved={refresh} />}
      {defaultsFor && <DefaultsModal t={defaultsFor} onClose={() => setDefaultsFor(null)} onSaved={refresh} />}
    </div>
  );
}

function DefaultsModal({ t, onClose, onSaved }: { t: Json; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kinds, setKinds] = useState<string[]>(t.defaults ?? []);
  return (
    <Modal
      title={`Use “${t.name}” for`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await post(`/api/v1/doc-templates/${t.id}/defaults`, { kinds });
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
        {KINDS.map(([k, l]) => (
          <label key={k} className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />
            All {l.toLowerCase()} (replaces the current default)
          </label>
        ))}
      </div>
    </Modal>
  );
}

/** An image file, or the first page of a PDF, as an image (for the letterhead). */
async function letterheadFrom(file: File): Promise<string> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1654 / v1.width }); // 200 dpi across A4
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport, canvas: c } as never).promise;
    await doc.destroy();
    return c.toDataURL('image/jpeg', 0.9);
  }
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1654 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

async function logoFrom(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 480 / bmp.width, 200 / bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/** A small picture of the letterhead for the AI to see. */
async function shrink(dataUrl: string) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, 700 / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

function TemplateEditor({ initial, sample, onClose, onSaved }: { initial: Json; sample: ReturnType<typeof useSample>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<Json>(() => ({ ...initial, settings: { ...DEFAULT_SETTINGS, ...(initial.settings ?? {}), columns: { ...DEFAULT_SETTINGS.columns, ...(initial.settings?.columns ?? {}) }, labels: { ...(initial.settings?.labels ?? {}) }, margins: { ...DEFAULT_SETTINGS.margins, ...(initial.settings?.margins ?? {}) } } }));
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState({ open: !!initial._ai, prompt: '', mode: 'design' as 'design' | 'html', busy: false });
  const s = t.settings as Settings;
  const set = (patch: Partial<Settings>) => setT({ ...t, settings: { ...s, ...patch } });
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: t.name, base: t.base, settings: s, letterhead: t.base === 'letterhead' ? t.letterhead : null, html: t.base === 'html' ? t.html : null };
      if (t.id) await put(`/api/v1/doc-templates/${t.id}`, body);
      else await post('/api/v1/doc-templates', body);
      toast('Template saved');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const runAi = async () => {
    setAi({ ...ai, busy: true });
    try {
      const r = await post<Json>('/api/v1/doc-templates/ai', { prompt: ai.prompt, mode: ai.mode, current: s, letterheadPreview: t.letterhead ? await shrink(t.letterhead) : null });
      if (r.base === 'html') setT({ ...t, name: t.id ? t.name : r.name, base: 'html', html: r.html });
      else setT({ ...t, name: t.id ? t.name : r.name, base: t.letterhead && r.base === 'letterhead' ? 'letterhead' : r.base === 'letterhead' ? t.base : r.base, settings: { ...s, ...r.settings, logo: s.logo } });
      toast('Designed — adjust anything, then save');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setAi((x) => ({ ...x, busy: false }));
    }
  };
  const tpl = { ...t, settings: s } as DocTemplate;
  const check = (k: keyof Settings, label: string) => (
    <label className="row small" style={{ gap: 6 }}>
      <input type="checkbox" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} />
      {label}
    </label>
  );
  return (
    <Modal
      title={t.id ? `Edit “${initial.name}”` : 'New template'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !t.name?.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
        <div className="stack" style={{ maxHeight: '72vh', overflow: 'auto', paddingRight: 6 }}>
          <label className="field">
            Name
            <input value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </label>
          <label className="field">
            Design
            <select value={t.base} onChange={(e) => setT({ ...t, base: e.target.value, html: e.target.value === 'html' ? (t.html ?? STARTER_HTML) : t.html })}>
              {BASES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
            <legend className="small" style={{ fontWeight: 600 }}>
              ✨ Design with AI
            </legend>
            {!ai.open ? (
              <button className="btn ghost sm" onClick={() => setAi({ ...ai, open: true })}>
                Describe the look…
              </button>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <textarea rows={3} value={ai.prompt} onChange={(e) => setAi({ ...ai, prompt: e.target.value })} placeholder="e.g. Clean and modern, navy and teal like our logo, serif headings, no discount column, a thank-you line at the bottom" />
                <div className="row" style={{ gap: 8 }}>
                  <select value={ai.mode} onChange={(e) => setAi({ ...ai, mode: e.target.value as 'design' | 'html' })}>
                    <option value="design">Adjust this design</option>
                    <option value="html">Write a full HTML template</option>
                  </select>
                  <button className="btn primary sm" disabled={ai.busy || ai.prompt.trim().length < 3} onClick={runAi}>
                    {ai.busy ? 'Designing…' : 'Design it'}
                  </button>
                </div>
                {t.letterhead && <span className="muted small">The AI also sees your letterhead, to match its colours and leave its artwork clear.</span>}
              </div>
            )}
          </fieldset>

          {(t.base === 'letterhead' || t.letterhead) && (
            <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
              <legend className="small" style={{ fontWeight: 600 }}>
                Letterhead
              </legend>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    setT({ ...t, base: 'letterhead', letterhead: await letterheadFrom(f), settings: { ...s, showCompany: false } });
                  } catch (err) {
                    toast((err as Error).message, true);
                  }
                }}
              />
              <span className="muted small">An A4 image or PDF of your letterhead (a blank page with your header and footer). The document is placed inside the margins below, on every page.</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
                  <label key={k} className="field small">
                    {k[0]!.toUpperCase() + k.slice(1)} margin (mm)
                    <input type="number" min={0} max={150} value={s.margins[k]} onChange={(e) => set({ margins: { ...s.margins, [k]: Number(e.target.value) } })} />
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {t.base === 'html' ? (
            <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
              <legend className="small" style={{ fontWeight: 600 }}>
                HTML template
              </legend>
              <input
                type="file"
                accept=".html,.htm,text/html"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setT({ ...t, html: await f.text() });
                }}
              />
              <textarea className="mono" rows={14} value={t.html ?? ''} onChange={(e) => setT({ ...t, html: e.target.value })} style={{ fontSize: 11 }} />
              <details className="small">
                <summary>Placeholders</summary>
                <p className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
                  {`{{company.name}} {{company.address}} {{company.gstin}} {{company.phone}} {{company.email}} {{{company.logo_img}}}
{{doc.title}} {{doc.number}} {{doc.date}} {{doc.due_date}} {{doc.subject}} {{doc.place_of_supply}} {{doc.reference}} {{doc.terms_label}}
{{bill_to.name}} {{bill_to.address}} {{bill_to.state}} {{bill_to.gstin}}
{{#lines}} {{n}} {{name}} {{description}} {{hsn}} {{qty}} {{unit}} {{rate}} {{discount}} {{taxable}} {{gst_rate}} {{gst}} {{amount}} {{/lines}}
{{totals.subtotal}} {{totals.discount}} {{totals.cgst}} {{totals.sgst}} {{totals.igst}} {{totals.total}} {{totals.in_words}}
{{#totals.intra}}…{{/totals.intra}} {{^totals.intra}}…{{/totals.intra}}
{{notes}} {{terms}} {{bank_details}} {{{signatures_html}}}`}
                </p>
                Scripts, frames and event handlers are removed. Use {'{{{…}}}'} only for the two HTML placeholders.
              </details>
            </fieldset>
          ) : (
            <>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {(['accent', 'accent2', 'text'] as const).map((k) => (
                  <label key={k} className="field small" style={{ width: 100 }}>
                    {k === 'accent' ? 'Main colour' : k === 'accent2' ? 'Second colour' : 'Text'}
                    <input type="color" value={s[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<Settings>)} />
                  </label>
                ))}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <label className="field small" style={{ flex: 1 }}>
                  Font
                  <select value={s.font} onChange={(e) => set({ font: e.target.value as Settings['font'] })}>
                    <option value="sans">Sans serif</option>
                    <option value="serif">Serif</option>
                    <option value="rounded">Rounded</option>
                    <option value="condensed">Condensed</option>
                    <option value="mono">Monospace</option>
                  </select>
                </label>
                <label className="field small" style={{ width: 90 }}>
                  Size
                  <input type="number" min={9} max={16} step={0.5} value={s.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
                </label>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <label className="field small" style={{ flex: 1, minWidth: 0 }}>
                  Logo
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={async (e) => e.target.files?.[0] && set({ logo: await logoFrom(e.target.files[0]) })} />
                </label>
                <select style={{ width: 120 }} value={s.logoPosition} onChange={(e) => set({ logoPosition: e.target.value as Settings['logoPosition'] })}>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                  <option value="none">No logo</option>
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                {check('showCompany', 'Company details at top')}
                {check('showGstSummary', 'GST summary by rate')}
                {check('showWords', 'Amount in words')}
                {check('showBank', 'Bank details')}
                {check('showSignature', 'Signature block')}
                {check('showQr', 'UPI QR to pay')}
              </div>
              <div className="field small">
                Columns
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {(Object.keys(s.columns) as (keyof Settings['columns'])[]).map((k) => (
                    <label key={k} className="row" style={{ gap: 4 }}>
                      <input type="checkbox" checked={s.columns[k]} onChange={(e) => set({ columns: { ...s.columns, [k]: e.target.checked } })} />
                      {{ hsn: 'HSN/SAC', qty: 'Qty', rate: 'Rate', discount: 'Discount', taxable: 'Taxable', gst: 'GST %' }[k]}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {(['title', 'billTo', 'subject', 'total'] as const).map((k) => (
                  <label key={k} className="field small">
                    {{ title: 'Title', billTo: '“Bill to” label', subject: '“Subject” label', total: '“Total” label' }[k]}
                    <input value={s.labels[k] ?? ''} placeholder={{ title: 'Tax invoice', billTo: 'Bill to', subject: 'Subject', total: 'Total' }[k]} onChange={(e) => set({ labels: { ...s.labels, [k]: e.target.value || null } })} />
                  </label>
                ))}
              </div>
              <label className="field small">
                Line above the document
                <input value={s.headerNote ?? ''} onChange={(e) => set({ headerNote: e.target.value || null })} placeholder="e.g. Original for recipient" />
              </label>
              <label className="field small">
                Footer
                <textarea rows={2} value={s.footerNote ?? ''} onChange={(e) => set({ footerNote: e.target.value || null })} placeholder="e.g. This is a computer-generated invoice. Subject to Noida jurisdiction." />
              </label>
            </>
          )}
        </div>
        <div style={{ background: '#e2e8f0', borderRadius: 8, padding: 10, maxHeight: '72vh', overflow: 'auto' }}>
          {sample ? (
            <FitWidth>
              <TemplatedDocument doc={sample.doc} labels={sample.labels} template={tpl} />
            </FitWidth>
          ) : (
            <Spinner />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Shows an A4 document scaled to the width of its box (the preview beside the editor). */
function FitWidth({ children }: { children: React.ReactNode }) {
  const [scale, setScale] = useState(0.6);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 794)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <div style={{ width: 794, zoom: scale }}>{children}</div>
    </div>
  );
}
