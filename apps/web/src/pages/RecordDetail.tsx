import type { FieldDef, RecordDto } from '@synapse/shared';
import { ConsentPanel } from '../components/admin/PrivacyAdmin';
import { CopilotPanel } from '../components/intel/CopilotPanel';

const COPILOT_OBJECTS = ['lead', 'contact', 'account', 'deal'];
import { WhatsAppButton } from './Inbox';
import { allowedChoices, fieldVisible, objectPerm, resolveLayout } from '@synapse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FieldInput, FieldValue } from '../components/fields';
import { Empty, Modal, ScoreRing, Spinner, useToast } from '../components/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { useObject, usePipelines } from '../lib/hooks';
import { TaskList } from './Tasks';
import { DuplicateBanner, MergeModal, RelatedPanel } from '../components/RecordData';
import { EmailComposer } from '../components/EmailComposer';
import { placeCall, useIntegrationStatus } from '../components/MailboxPanel';
import { ShareModal } from '../components/ShareModal';
import { QuoteEditor } from '../components/QuoteEditor';
import { EventModal } from './Calendar';
import { FilesPanel } from '../components/Files';
import { ApprovalBar, QuoteRevisions } from '../components/Approvals';
import { OrderPanel, useApps } from '../components/ops/OrderPanel';
import { PoPanel, VendorScorecard } from '../components/ops/PurchasePanels';
import { ProductStockPanel } from '../components/ops/Inventory';
import { InstallationPanel, ShipmentPanel } from '../components/ops/FieldPanels';
import { RaiseTicketButton, TicketBar } from '../components/ops/ServicePanels';
import { InvoicePanel, PaymentPanel } from '../components/ops/BillingPanels';
import { BillPanel, ExpensePanel, MakeRecurring, VendorPaymentPanel, WriteOffButton } from '../components/books/BookPanels';
import { ProjectWorkspace } from '../components/projects/ProjectWorkspace';
import { JobWorkPanel, WorkOrderPanel } from '../components/mfg/MfgPanels';
import { RecordDeposits } from '../components/books/Deposits';
import { DealCharges } from '../components/deals/DealCharges';
import { SignaturesPanel } from '../components/SignaturesPanel';

/** Mirrors the API: documents that drive stock, tax or customer commitments are deleted only in these states. */
const DELETABLE_IN: Record<string, string[]> = {
  sales_order: ['draft', 'cancelled'],
  purchase_order: ['draft', 'cancelled'],
  shipment: ['planned', 'cancelled'],
  installation: ['scheduled', 'cancelled'],
  invoice: ['draft'],
  payment: ['void'],
};
import { hasAdmin } from '@synapse/shared';

interface Activity {
  id: string;
  kind: string;
  subject: string | null;
  body: string | null;
  direction: string | null;
  sentiment: string | null;
  occurred_at: string;
  actor_name: string | null;
  metadata?: {
    location?: { lat: number; lng: number; accuracy?: number };
    outcome?: string;
    durationMinutes?: number;
    // calls (telephony) and synced email
    provider?: string;
    status?: string;
    recordingUrl?: string | null;
    from?: string;
    to?: string[] | string;
    synced?: boolean;
  } | null;
}

const KIND_MARK: Record<string, string> = { note: 'N', call: 'C', email: '@', meeting: 'M', whatsapp: 'W', instagram: 'IG', visit: 'V', sms: 'S', stage_change: '→', system: '•', ai: 'AI', webhook: '⇄' };

export function RecordDetailPage() {
  const { object = '', id = '' } = useParams();
  const obj = useObject(object);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { me } = useAuth();
  const [tab, setTab] = useState<'timeline' | 'related' | 'files' | 'tasks' | 'ai' | 'copilot'>('timeline');
  const [converting, setConverting] = useState(false);
  const [composing, setComposing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [merging, setMerging] = useState(false);
  const pipelines = usePipelines(object);
  const apps = useApps();
  const key = ['record', object, id];
  const { data: rec, isLoading, error } = useQuery({ queryKey: key, queryFn: () => get<RecordDto>(`/api/v1/records/${object}/${id}`) });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<RecordDto>(`/api/v1/records/${object}/${id}`, body, rec ? { 'if-match': String(rec.version) } : undefined),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      qc.invalidateQueries({ queryKey: ['records', object] });
      qc.invalidateQueries({ queryKey: ['timeline', object, id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast('Someone else changed this record. Reloaded the latest version.', true);
        qc.invalidateQueries({ queryKey: key });
      } else if (e instanceof ApiError && e.details?.[0]?.field) {
        const label = obj?.fields.find((f) => f.key === e.details![0]!.field)?.label ?? e.details[0].field;
        toast(e.details[0].message === e.message ? e.message : `${label}: ${e.details[0].message}`, true);
      } else toast((e as Error).message, true);
    },
  });

  if (isLoading || !obj) return <Spinner />;
  if (error || !rec) return <Empty title="This record is not available">It may have been deleted, or you may not have access to it.</Empty>;

  const perm = me ? objectPerm(me.permissions, object) : null;
  const canEdit = perm?.update !== 'none';
  const pipeline = pipelines.find((p) => p.id === rec.pipeline_id);
  const stageIdx = pipeline?.stages.findIndex((s) => s.id === rec.stage_id) ?? -1;
  const byKey = new Map(obj.fields.map((f) => [f.key, f]));
  const values = rec as Record<string, unknown>;
  const sections = resolveLayout(obj)
    .sections.map((s) => ({ ...s, fields: s.fields.map((k) => byKey.get(k)).filter((f): f is FieldDef => !!f && !['full_name', 'pipeline_id', 'stage_id', 'ai_score'].includes(f.key) && fieldVisible(f, values)) }))
    .filter((s) => s.fields.length);
  const insights = rec.ai_insights as { reasons?: string[]; nextAction?: string | null; model?: string | null } | null;

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          {object === 'lead' && <ScoreRing value={rec.ai_score as number | null} size="lg" />}
          <div>
            <div className="muted small">{obj.label}</div>
            <h1>{rec.title || 'Untitled'}</h1>
            <p className="small row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {typeof rec.rating === 'string' && (
                <span className={`chip rating-${rec.rating}`} title={`Score ${rec.score ?? '—'} from your scoring rules`}>
                  {rec.rating} · {String(rec.score ?? '')}
                </span>
              )}
              {object === 'quote' && Number(rec.revision ?? 1) > 1 && <span className="chip">Revision {String(rec.revision)}</span>}
              <span>Updated {relative(rec.updated_at)}</span>
            </p>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {['lead', 'contact', 'account', 'ticket'].includes(object) && <CallButton object={object} id={id} phone={(rec.phone ?? rec.customer_phone) as string | null} />}
          {['lead', 'contact', 'account', 'deal', 'quote', 'sales_order', 'invoice', 'ticket'].includes(object) && <WhatsAppButton object={object} id={id} name={rec.title} />}
          {['lead', 'contact', 'account', 'deal', 'quote'].includes(object) || obj.fields.some((f) => f.type === 'email') ? (
            <button className="btn" onClick={() => setComposing(true)}>
              Email
            </button>
          ) : null}
          <button className="btn" onClick={() => setScheduling(true)}>
            Schedule
          </button>
          {apps.has('service') && ['account', 'contact', 'sales_order'].includes(object) && me && objectPerm(me.permissions, 'ticket').create && <RaiseTicketButton object={object} record={rec} />}
          {canEdit && (
            <button className="btn" onClick={() => setSharing(true)}>
              Share
            </button>
          )}
          {object === 'deal' && me && objectPerm(me.permissions, 'quote').create && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  const q = await post<RecordDto>(`/api/v1/quotes/from-deal/${id}`);
                  toast(`Quote ${q.quote_number} created`);
                  nav(`/o/quote/${q.id}`);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Create quote
            </button>
          )}
          {object === 'quote' && rec.status === 'accepted' && apps.has('orders') && me && objectPerm(me.permissions, 'sales_order').create && (
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const o = await post<{ id: string }>(`/api/v1/orders/from-quote/${id}`);
                  toast('Sales order created');
                  nav(`/o/sales_order/${o.id}`);
                } catch (e) {
                  const orderId = (e as ApiError).details as unknown as { orderId?: string } | undefined;
                  if (orderId?.orderId) nav(`/o/sales_order/${orderId.orderId}`);
                  else toast((e as Error).message, true);
                }
              }}
            >
              Convert to order
            </button>
          )}
          {object === 'lead' && !rec.converted_at && canEdit && (
            <button className="btn primary" onClick={() => setConverting(true)}>
              Convert lead
            </button>
          )}
          {canEdit && ['account', 'contact', 'vendor', 'lead'].includes(object) && (
            <button className="btn" onClick={() => setMerging(true)} title={`Merge a duplicate ${obj.label.toLowerCase()} into this one`}>
              Merge…
            </button>
          )}
          {perm?.delete !== 'none' && (!DELETABLE_IN[object] || DELETABLE_IN[object]!.includes(String(rec.status))) && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!window.confirm(`Delete this ${obj.label.toLowerCase()}? It disappears from lists; its history stays in the audit log.`)) return;
                await del(`/api/v1/records/${object}/${id}`);
                toast(`${obj.label} deleted`);
                qc.invalidateQueries({ queryKey: ['records', object] });
                nav(`/o/${object}`);
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {canEdit && <DuplicateBanner obj={obj} record={rec} />}
      {merging && <MergeModal obj={obj} master={rec} candidates={[]} onClose={() => setMerging(false)} />}
      {object === 'quote' && (
        <div style={{ marginBottom: 20 }}>
          <ApprovalBar object={object} record={rec} canEdit={canEdit} />
          <div style={{ marginBottom: 10 }}>
            <QuoteRevisions quoteId={id} />
          </div>
          <QuoteEditor quoteId={id} canEdit={canEdit} />
          <SignaturesPanel object="quote" id={id} signable={rec.status !== "superseded"} />
        </div>
      )}

      {object === 'sales_order' && (
        <>
          <ApprovalBar object={object} record={rec} canEdit={canEdit} />
          <OrderPanel orderId={id} canEdit={canEdit} />
          <SignaturesPanel object="sales_order" id={id} signable={rec.status !== 'cancelled'} />
        </>
      )}
      {object === 'purchase_order' && (
        <>
          <ApprovalBar object={object} record={rec} canEdit={canEdit} />
          <PoPanel poId={id} canEdit={canEdit} />
          <SignaturesPanel object="purchase_order" id={id} signable={rec.status !== 'cancelled'} />
        </>
      )}
      {object === 'vendor' && <VendorScorecard vendorId={id} />}
      {object === 'shipment' && <ShipmentPanel id={id} canEdit={canEdit} />}
      {object === 'installation' && <InstallationPanel id={id} canEdit={canEdit} />}
      {object === 'ticket' && <TicketBar ticket={rec} canEdit={canEdit} />}
      {object === 'invoice' && (
        <>
          <ApprovalBar object={object} record={rec} canEdit={canEdit} />
          {apps.has('books') && rec.doc_type === 'tax_invoice' && (
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
              <MakeRecurring kind="invoice" rec={rec} />
              {['issued', 'partially_paid'].includes(String(rec.status)) && <WriteOffButton invoice={rec} />}
            </div>
          )}
          <InvoicePanel id={id} canEdit={canEdit} />
          <SignaturesPanel object="invoice" id={id} signable={!['draft', 'cancelled'].includes(String(rec.status))} why="Issue the invoice first: a signed draft would change" />
        </>
      )}
      {object === 'bill' && (
        <>
          <ApprovalBar object={object} record={rec} canEdit={canEdit} />
          <BillPanel id={id} canEdit={canEdit} />
        </>
      )}
      {object === 'vendor_payment' && <VendorPaymentPanel id={id} canEdit={canEdit} />}
      {object === 'expense' && <ExpensePanel rec={rec} canEdit={canEdit} />}
      {object === 'deal' && <DealCharges dealId={id} canEdit={canEdit} />}
      {(object === 'deal' || object === 'project') && apps.has('billing') && me && (hasAdmin(me.permissions, 'books') || hasAdmin(me.permissions, 'billing')) && (
        <RecordDeposits object={object} rec={rec as Record<string, unknown>} />
      )}
      {object === 'project' && apps.has('projects') && <ProjectWorkspace id={id} />}
      {object === 'work_order' && apps.has('manufacturing') && <WorkOrderPanel id={id} canEdit={canEdit} />}
      {object === 'job_work' && apps.has('manufacturing') && <JobWorkPanel id={id} canEdit={canEdit} />}
      {object === 'payment' && <PaymentPanel id={id} canEdit={canEdit} />}
      {object === 'product' && apps.has('inventory') && rec.product_type !== 'service' && (
        <ProductStockPanel productId={id} productName={rec.title} isVariant={!!rec.variant_of} canMove={!!me && (hasAdmin(me.permissions, 'operations') || objectPerm(me.permissions, 'product').update === 'all')} />
      )}

      {pipeline && (
        <div className="panel" style={{ padding: 10, marginBottom: 20 }}>
          <div className="stage-track" role="group" aria-label={`${pipeline.name} stage`}>
            {pipeline.stages.map((s, i) => (
              <button
                key={s.id}
                className={`${i < stageIdx ? 'done' : ''} ${i === stageIdx ? 'current' : ''} ${s.category}`}
                aria-pressed={i === stageIdx}
                disabled={!canEdit || save.isPending}
                onClick={() => i !== stageIdx && save.mutate({ stage_id: s.id })}
                title={`${s.label} · ${s.probability}%`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="record-grid">
        <div className="stack" style={{ gap: 16 }}>
          {sections.map((sec, i) => (
            <DetailSection key={sec.id} title={i === 0 && sections.length === 1 ? 'Details' : sec.title || 'Details'} startCollapsed={!!sec.collapsed}>
              {sec.fields.map((f) => (
                <EditableField key={f.key} field={f} record={rec} objectKey={object} editable={canEdit && !f.readOnly} onSave={(v) => save.mutateAsync({ [f.key]: v })} />
              ))}
            </DetailSection>
          ))}
          {(object === 'lead' || object === 'contact') && <ConsentPanel object={object} id={id} />}
        </div>

        <section className="panel">
          <div className="tabs" role="tablist">
            {(['timeline', ...(COPILOT_OBJECTS.includes(object) ? (['copilot'] as const) : []), 'related', 'files', 'tasks', 'ai'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === 'timeline' ? 'Timeline' : t === 'copilot' ? 'Copilot' : t === 'related' ? 'Related' : t === 'files' ? 'Files' : t === 'tasks' ? 'Tasks' : 'Synapse AI'}
              </button>
            ))}
          </div>
          {tab === 'timeline' && <Timeline object={object} id={id} canLog={canEdit} />}
          {tab === 'related' && <RelatedPanel object={object} id={id} />}
          {tab === 'files' && <FilesPanel object={object} id={id} canEdit={canEdit} />}
          {tab === 'tasks' && (
            <div className="panel-body">
              <TaskList relatedObject={object} relatedId={id} compact />
            </div>
          )}
          {tab === 'ai' && <AiPanel object={object} id={id} insights={insights} />}
          {tab === 'copilot' && <CopilotPanel object={object} id={id} canEdit={canEdit} />}
        </section>
      </div>

      {sharing && <ShareModal object={object} id={id} title={rec.title || obj.label} onClose={() => setSharing(false)} />}
      {composing && <EmailComposer object={object} recordId={id} onClose={() => setComposing(false)} />}
      {scheduling && (
        <EventModal
          event={{ title: `${object === 'deal' ? 'Meeting' : 'Call'}: ${rec.title}`, kind: object === 'deal' ? 'meeting' : 'call', starts_at: new Date(Math.ceil(Date.now() / 3600_000) * 3600_000).toISOString(), ends_at: new Date(Math.ceil(Date.now() / 3600_000) * 3600_000 + 1800_000).toISOString(), reminder_minutes: 15, related_object: object, related_id: id, attendees: [] }}
          onClose={() => setScheduling(false)}
        />
      )}
      {converting && <ConvertModal leadId={id} company={String(rec.company ?? '')} onClose={() => setConverting(false)} />}
    </>
  );
}

function DetailSection({ title, startCollapsed, children }: { title: string; startCollapsed: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!startCollapsed);
  return (
    <section className="panel">
      <div className="panel-head">
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <h2>{title}</h2>
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </div>
      {open && <div className="fields">{children}</div>}
    </section>
  );
}

function EditableField({ field, record, objectKey, editable, onSave }: { field: FieldDef; record: RecordDto; objectKey: string; editable: boolean; onSave: (v: unknown) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<unknown>(record[field.key]);
  const commit = async () => {
    if (JSON.stringify(val ?? null) !== JSON.stringify(record[field.key] ?? null)) {
      try {
        await onSave(val);
      } catch {
        setVal(record[field.key]);
      }
    }
    setEditing(false);
  };
  return (
    <div
      className={`fv${editable && !editing ? ' editable' : ''}`}
      onClick={() => {
        if (editable && !editing) {
          setVal(record[field.key]);
          setEditing(true);
        }
      }}
    >
      <span>{field.label}</span>
      {editing ? (
        <div
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && field.type !== 'textarea') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        >
          <FieldInput field={field} objectKey={objectKey} value={val} onChange={setVal} choices={field.options?.controlling ? allowedChoices(field, record as Record<string, unknown>) : undefined} />
        </div>
      ) : (
        <span className="val">
          <FieldValue field={field} record={record} />
        </span>
      )}
    </div>
  );
}

function Timeline({ object, id, canLog }: { object: string; id: string; canLog: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [loc, setLoc] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device', true);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy) });
        setLocating(false);
      },
      () => {
        toast('Could not read your location. Allow location access and try again.', true);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const { data, isLoading } = useQuery({ queryKey: ['timeline', object, id], queryFn: () => get<{ items: Activity[] }>(`/api/v1/records/${object}/${id}/timeline`) });
  const log = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await post(`/api/v1/records/${object}/${id}/activities`, { kind, subject: kind === 'note' ? 'Note' : kind === 'visit' ? 'Site visit' : `Logged ${kind}`, body, ...(kind === 'visit' && loc ? { location: loc } : {}) });
      setBody('');
      setLoc(null);
      qc.invalidateQueries({ queryKey: ['timeline', object, id] });
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <>
      {canLog && (
        <form className="panel-body stack" style={{ borderBottom: '1px solid var(--line-2)', gap: 8 }} onSubmit={log}>
          <textarea placeholder="Write a note, or log a call or meeting…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Activity" style={{ minHeight: 64 }} />
          <div className="spread">
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }} aria-label="Activity type">
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
              <option value="email">Email (logged)</option>
              <option value="whatsapp">WhatsApp (logged)</option>
              <option value="visit">Site / field visit</option>
            </select>
            {kind === 'visit' && (
              <button type="button" className="btn sm" onClick={locate} disabled={locating}>
                {locating ? 'Locating…' : loc ? `📍 ±${loc.accuracy} m` : 'Add my location'}
              </button>
            )}
            <button className="btn primary sm" disabled={!body.trim()}>
              Add to timeline
            </button>
          </div>
        </form>
      )}
      {isLoading ? (
        <div className="panel-body">
          <Spinner />
        </div>
      ) : data?.items.length ? (
        <ul className="timeline">
          {data.items.map((a) => (
            <li key={a.id}>
              <span className="ico" aria-hidden="true">
                {KIND_MARK[a.kind] ?? '•'}
              </span>
              <div>
                <div className="spread">
                  <b>{a.subject ?? a.kind}</b>
                  <span className="muted small">{dateTime(a.occurred_at)}</span>
                </div>
                <div className="muted small">
                  {a.actor_name ?? (a.direction === 'in' ? 'Customer' : 'Automation')}
                  {a.sentiment ? ` · sentiment ${a.sentiment}` : ''}
                </div>
                {a.kind === 'email' && a.metadata?.from && (
                  <div className="muted small">
                    {a.direction === 'in' ? `From ${a.metadata.from}` : `To ${Array.isArray(a.metadata.to) ? a.metadata.to.join(', ') : (a.metadata.to ?? '')}`}
                    {a.metadata.synced ? ' · from mailbox' : ''}
                  </div>
                )}
                {a.body && <div className="body">{a.body}</div>}
                {a.kind === 'call' && a.metadata?.recordingUrl?.startsWith('https://') && (
                  <audio className="call-rec" controls preload="none" src={a.metadata.recordingUrl}>
                    <a href={a.metadata.recordingUrl} target="_blank" rel="noopener noreferrer">
                      Recording
                    </a>
                  </audio>
                )}
                {(a.metadata?.location || a.metadata?.outcome) && (
                  <div className="small muted">
                    {a.metadata.outcome ? `Outcome: ${a.metadata.outcome}` : ''}
                    {a.metadata.location && (
                      <>
                        {a.metadata.outcome ? ' · ' : ''}
                        <a href={`https://www.google.com/maps?q=${a.metadata.location.lat},${a.metadata.location.lng}`} target="_blank" rel="noopener noreferrer">
                          Checked in here{a.metadata.location.accuracy ? ` (±${a.metadata.location.accuracy} m)` : ''}
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No activity yet">Calls, notes, emails and stage changes will appear here.</Empty>
      )}
    </>
  );
}

function AiPanel({ object, id, insights }: { object: string; id: string; insights: { reasons?: string[]; nextAction?: string | null; model?: string | null } | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ summary: string; key_points: string[]; risks: string[] } | null>(null);
  const [actions, setActions] = useState<{ title: string; reason: string; priority: string; type: string; due_in_hours?: number }[] | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [intent, setIntent] = useState('Follow up on our last conversation and propose a call this week');

  const run = async <T,>(name: string, fn: () => Promise<T>, done: (r: T) => void) => {
    setBusy(name);
    try {
      done(await fn());
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel-body stack">
      {object === 'lead' && (
        <div className="ai-box">
          <div className="spread">
            <h3>Why this score</h3>
            <button className="btn ai sm" disabled={!!busy} onClick={() => run('score', () => post(`/api/ai/score/lead/${id}`), () => qc.invalidateQueries({ queryKey: ['record', object, id] }))}>
              {busy === 'score' ? 'Scoring…' : 'Rescore'}
            </button>
          </div>
          {insights?.reasons?.length ? (
            <ul>
              {insights.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Not scored yet.</p>
          )}
          {insights?.nextAction && (
            <p>
              <b>Suggested next step:</b> {insights.nextAction}
            </p>
          )}
          {insights?.model && <p className="muted small">Model: {insights.model}</p>}
        </div>
      )}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn ai" disabled={!!busy} onClick={() => run('sum', () => post<typeof summary>(`/api/ai/summarize/${object}/${id}`), setSummary)}>
          {busy === 'sum' ? 'Summarising…' : 'Summarise this record'}
        </button>
        <button className="btn ai" disabled={!!busy} onClick={() => run('nba', () => post<{ actions: NonNullable<typeof actions> }>(`/api/ai/next-actions/${object}/${id}`), (r) => setActions(r.actions))}>
          {busy === 'nba' ? 'Thinking…' : 'Suggest next actions'}
        </button>
      </div>

      {summary && (
        <div className="ai-box">
          <h3>Summary</h3>
          <p>{summary.summary}</p>
          {summary.key_points.length > 0 && (
            <ul>
              {summary.key_points.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          )}
          {summary.risks.length > 0 && (
            <>
              <b>Risks</b>
              <ul>
                {summary.risks.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {actions && (
        <div className="ai-box">
          <h3>Next best actions</h3>
          <ul>
            {actions.map((a) => (
              <li key={a.title}>
                <div className="spread">
                  <b>{a.title}</b>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await post('/api/v1/tasks', { title: a.title, description: a.reason, priority: a.priority === 'high' ? 'high' : 'normal', dueAt: a.due_in_hours ? new Date(Date.now() + a.due_in_hours * 3600_000).toISOString() : null, relatedObject: object, relatedId: id });
                      toast('Task created');
                      qc.invalidateQueries({ queryKey: ['tasks'] });
                    }}
                  >
                    Make it a task
                  </button>
                </div>
                <div className="muted small">{a.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stack" style={{ gap: 8 }}>
        <label className="field">
          Draft an email
          <input value={intent} onChange={(e) => setIntent(e.target.value)} />
        </label>
        <div>
          <button className="btn ai" disabled={!!busy || intent.length < 3} onClick={() => run('draft', () => post<{ subject: string; body: string }>(`/api/ai/draft-email/${object}/${id}`, { intent }), setDraft)}>
            {busy === 'draft' ? 'Drafting…' : 'Write draft'}
          </button>
        </div>
        {draft && (
          <div className="ai-box">
            <b>{draft.subject}</b>
            <p style={{ whiteSpace: 'pre-wrap' }}>{draft.body}</p>
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).then(() => toast('Draft copied'))}>
              Copy draft
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConvertModal({ leadId, company, onClose }: { leadId: string; company: string; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [createDeal, setCreateDeal] = useState(true);
  const [dealName, setDealName] = useState(company ? `${company} – opportunity` : '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ contactId: string; dealId: string | null }>(`/api/v1/records/lead/${leadId}/convert`, { createDeal, dealName: dealName || undefined, amount: amount ? Number(amount) : undefined });
      toast('Lead converted');
      qc.invalidateQueries();
      nav(r.dealId ? `/o/deal/${r.dealId}` : `/o/contact/${r.contactId}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Convert lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={busy}>
            {busy ? 'Converting…' : 'Convert lead'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <p className="wide muted">This creates a contact{company ? ` and the account “${company}”` : ''}, and keeps the lead's history linked.</p>
        <label className="row wide">
          <input type="checkbox" checked={createDeal} onChange={(e) => setCreateDeal(e.target.checked)} /> Also create a deal
        </label>
        {createDeal && (
          <>
            <label className="field">
              Deal name
              <input value={dealName} onChange={(e) => setDealName(e.target.value)} />
            </label>
            <label className="field">
              Amount (₹)
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Click-to-call through the workspace's telephony (Exotel), else the phone's own dialer. */
function CallButton({ object, id, phone }: { object: string; id: string; phone: string | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const st = useIntegrationStatus();
  const [busy, setBusy] = useState(false);
  if (!phone) return null;
  if (!st.data?.telephony) {
    return (
      <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
        Call
      </a>
    );
  }
  return (
    <button
      className="btn"
      disabled={busy}
      title={`Synapse rings your phone${st.data.myPhone ? ` (${st.data.myPhone})` : ''}, then connects ${phone}`}
      onClick={async () => {
        setBusy(true);
        try {
          await placeCall(object, id);
          toast('Calling — pick up your phone; the customer is connected next');
          setTimeout(() => qc.invalidateQueries({ queryKey: ['timeline', object, id] }), 1500);
        } catch (e) {
          toast((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Calling…' : 'Call'}
    </button>
  );
}
