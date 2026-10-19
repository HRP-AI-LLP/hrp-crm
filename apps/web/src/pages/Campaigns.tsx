/**
 * Campaigns: a WhatsApp template or an email to an audience of leads or contacts, with consent
 * checks, a delivery funnel and the business that followed.
 */
import type { ObjectMeta } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeFilter, type Filter, FilterBuilder } from '../components/ListTools';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, patch, post } from '../lib/api';
import { dateTime, money, number, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';

type Json = Record<string, any>;

const STATUS: Record<string, [string, string]> = {
  draft: ['Draft', ''],
  scheduled: ['Scheduled', 'info'],
  sending: ['Sending', 'info'],
  sent: ['Sent', 'good'],
  cancelled: ['Cancelled', ''],
  failed: ['Stopped', 'bad'],
};
const REASONS: Record<string, string> = {
  no_consent: 'No marketing consent',
  opted_out: 'Opted out',
  blocked: 'Blocked or erased',
  duplicate: 'Same number twice',
  no_mobile: 'No mobile number',
  no_email: 'No email',
  no_address: 'No address',
  not_visible: 'No longer visible to the sender',
  cancelled: 'Campaign cancelled',
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function CampaignsPage() {
  const { id } = useParams();
  if (id === 'new') return <CampaignEditor />;
  if (id) return <CampaignDetail id={id} />;
  return <CampaignList />;
}

function CampaignList() {
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => get<{ items: Json[] }>('/api/admin/campaigns'), refetchInterval: 20_000 });
  const nav = useNavigate();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>Send an approved WhatsApp template or an email to the people who agreed to hear from you.</p>
        </div>
        <Link className="btn primary" to="/campaigns/new">
          New campaign
        </Link>
      </div>
      {!q.data ? (
        <Spinner />
      ) : !q.data.items.length ? (
        <Empty title="No campaigns yet">Festive offers, new collections, service reminders: pick an audience, a template and send. Synapse skips anyone without consent or who opted out.</Empty>
      ) : (
        <section className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th className="num">Sent</th>
                <th className="num">Delivered</th>
                <th className="num">Read</th>
                <th className="num">Replied</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id} className="click" onClick={() => nav(`/campaigns/${c.id}`)}>
                  <td>
                    <b>{c.name}</b>
                    <div className="muted small">
                      {c.channel === 'whatsapp' ? `WhatsApp · ${c.template_name ?? ''}` : 'Email'} · {c.created_by_name} · {relative(c.created_at)}
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${STATUS[c.status]?.[1] ?? ''}`}>{STATUS[c.status]?.[0] ?? c.status}</span>
                    {c.status === 'scheduled' && <div className="muted small">{dateTime(c.scheduled_at)}</div>}
                  </td>
                  <td className="num">{number(c.sent)}</td>
                  <td className="num">{pct(c.delivered, c.sent)}</td>
                  <td className="num">{pct(c.read, c.sent)}</td>
                  <td className="num">{pct(c.replied, c.sent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function CampaignEditor() {
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const channels = useQuery({ queryKey: ['admin-channels'], queryFn: () => get<{ items: Json[] }>('/api/admin/channels') });
  const [f, setF] = useState({ name: '', channel: 'whatsapp' as 'whatsapp' | 'email', channelAccountId: '', templateId: '', subject: '', body: '', object: 'lead' as 'lead' | 'contact' });
  const [vars, setVars] = useState<Json[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [filtering, setFiltering] = useState(false);
  const [preview, setPreview] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = (channels.data?.items ?? []).filter((c) => c.channel === f.channel && c.status === 'active');
  const accountId = f.channelAccountId || accounts[0]?.id || '';
  const tpls = useQuery({ queryKey: ['wa-templates-admin', accountId], queryFn: () => get<{ items: Json[] }>(`/api/admin/whatsapp/${accountId}/templates`), enabled: f.channel === 'whatsapp' && !!accountId });
  const approved = (tpls.data?.items ?? []).filter((t) => t.status === 'APPROVED' && (!t.header_type || t.header_type === 'TEXT'));
  const tpl = approved.find((t) => t.id === f.templateId);
  const obj = meta?.objects.find((o) => o.key === f.object) as ObjectMeta | undefined;
  const textFields = useMemo(() => (obj?.fields ?? []).filter((x) => ['text', 'email', 'phone', 'picklist', 'number', 'currency', 'date', 'url'].includes(x.type)), [obj]);
  const audience = { object: f.object, filters };
  const purpose = f.channel === 'email' || tpl?.category === 'MARKETING' ? 'marketing' : 'transactional';
  const body = () => ({
    name: f.name,
    channel: f.channel,
    channelAccountId: accountId,
    templateId: f.channel === 'whatsapp' ? f.templateId || null : null,
    variables: f.channel === 'whatsapp' ? vars : [],
    subject: f.channel === 'email' ? f.subject : null,
    body: f.channel === 'email' ? f.body : null,
    audience,
  });
  const runPreview = async () => {
    try {
      setPreview(await post<Json>('/api/admin/campaigns/preview', { channel: f.channel, audience, purpose }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const save = async (start: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>('/api/admin/campaigns', body());
      if (start) await post(`/api/admin/campaigns/${r.id}/start`, {});
      toast(start ? 'Campaign started' : 'Draft saved');
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      nav(`/campaigns/${r.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!channels.data || !meta) return <Spinner />;
  const noChannel = !accounts.length;
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/campaigns" className="small">
            ← Campaigns
          </Link>
          <h1>New campaign</h1>
        </div>
      </div>
      <div className="campaign-editor">
        <section className="panel panel-body stack">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Diwali modular kitchen offer" />
          </label>
          <div className="seg" role="tablist" aria-label="Channel">
            <button role="tab" aria-selected={f.channel === 'whatsapp'} onClick={() => setF({ ...f, channel: 'whatsapp', channelAccountId: '', templateId: '' })}>
              WhatsApp
            </button>
            <button role="tab" aria-selected={f.channel === 'email'} onClick={() => setF({ ...f, channel: 'email', channelAccountId: '', templateId: '' })}>
              Email
            </button>
          </div>
          {noChannel ? (
            <p className="muted">
              Connect a {f.channel === 'whatsapp' ? 'WhatsApp number' : 'sending email address'} in <Link to="/settings#channels">Settings → Channels</Link> first.
            </p>
          ) : (
            <>
              {accounts.length > 1 && (
                <label className="field">
                  From
                  <select value={accountId} onChange={(e) => setF({ ...f, channelAccountId: e.target.value, templateId: '' })}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {f.channel === 'whatsapp' ? (
                <>
                  <label className="field">
                    Approved template
                    <select
                      value={f.templateId}
                      onChange={(e) => {
                        const t = approved.find((x) => x.id === e.target.value);
                        setF({ ...f, templateId: e.target.value });
                        setVars(Array.from({ length: t?.variable_count ?? 0 }, (_, i) => (i === 0 ? { source: 'field', field: 'first_name', fallback: 'there' } : { source: 'text', value: '' })));
                      }}
                    >
                      <option value="">Choose…</option>
                      {approved.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.category === 'MARKETING' ? 'marketing' : 'utility'}, {t.language})
                        </option>
                      ))}
                    </select>
                  </label>
                  {!approved.length && tpls.data && <p className="muted small">No approved templates. Create or sync them in Settings → Channels.</p>}
                  {tpl && (
                    <>
                      <div className="tpl-preview pre-wrap">{tpl.body_text}</div>
                      {vars.map((v, i) => (
                        <div key={i} className="row var-row">
                          <span className="mono small">{`{{${i + 1}}}`}</span>
                          <select value={v.source === 'field' ? v.field : '__text'} onChange={(e) => setVars(vars.map((x, j) => (j === i ? (e.target.value === '__text' ? { source: 'text', value: '' } : { source: 'field', field: e.target.value, fallback: x.fallback ?? '' }) : x)))} style={{ width: 'auto' }}>
                            <option value="__text">Fixed text</option>
                            {textFields.map((x) => (
                              <option key={x.key} value={x.key}>
                                {x.label}
                              </option>
                            ))}
                          </select>
                          {v.source === 'text' ? (
                            <input placeholder="Same for everyone" value={v.value} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                          ) : (
                            <input placeholder="If empty, use…" value={v.fallback ?? ''} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, fallback: e.target.value } : x)))} />
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <>
                  <label className="field">
                    Subject
                    <input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="{{first_name}}, our Diwali collection is here" />
                  </label>
                  <label className="field">
                    Message
                    <textarea rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={'Hi {{first_name|there}},\n\n…'} />
                  </label>
                  <p className="muted small">Merge fields: {'{{first_name}}'}, {'{{company}}'} or any field key; {'{{field|fallback}}'} sets a default. An unsubscribe link is added to every email.</p>
                </>
              )}
            </>
          )}
        </section>
        <section className="panel panel-body stack">
          <h3 style={{ margin: 0 }}>Audience</h3>
          <div className="seg">
            {(['lead', 'contact'] as const).map((o) => (
              <button key={o} aria-pressed={f.object === o} onClick={() => (setF({ ...f, object: o }), setFilters([]), setPreview(null))}>
                {meta.objects.find((x) => x.key === o)?.plural ?? o}
              </button>
            ))}
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {filters.length ? filters.map((x, i) => obj && <span key={i} className="chip info">{describeFilter(obj, x)}</span>) : <span className="muted small">Everyone you can see</span>}
            <button className="btn sm" onClick={() => setFiltering(true)}>
              {filters.length ? 'Change filters' : 'Add filters'}
            </button>
          </div>
          <button className="btn" onClick={runPreview}>
            Check who will receive it
          </button>
          {preview && (
            <div className="audience-check">
              <div className="kpi-inline">
                <b>{number(preview.eligible)}</b> will receive it <span className="muted">of {number(preview.total)}</span>
              </div>
              {Object.entries(preview.skipped as Record<string, number>).map(([k, n]) => (
                <div key={k} className="small spread">
                  <span>{REASONS[k] ?? k}</span>
                  <span>{number(n)}</span>
                </div>
              ))}
              {preview.capped && <p className="small warn-text">Only the first {number(preview.max)} people are included.</p>}
              {purpose === 'marketing' && <p className="muted small">This is a marketing message: only people with recorded consent receive it.</p>}
            </div>
          )}
          <div className="row" style={{ marginTop: 'auto' }}>
            <button className="btn" disabled={busy || noChannel || !f.name} onClick={() => save(false)}>
              Save draft
            </button>
            <button className="btn primary" disabled={busy || noChannel || !f.name || !preview?.eligible} onClick={() => window.confirm(`Send to ${preview?.eligible} people now?`) && save(true)}>
              Send now
            </button>
          </div>
        </section>
      </div>
      {filtering && obj && (
        <FilterBuilder
          obj={obj}
          value={filters}
          onClose={() => setFiltering(false)}
          onChange={(x) => {
            setFilters(x);
            setPreview(null);
            setFiltering(false);
          }}
        />
      )}
    </>
  );
}

function CampaignDetail({ id }: { id: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [status, setStatus] = useState('any');
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState('');
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => get<Json>(`/api/admin/campaigns/${id}`), refetchInterval: (d) => (['sending', 'scheduled'].includes(d.state.data?.campaign?.status) ? 10_000 : false) });
  const rec = useQuery({ queryKey: ['campaign-recipients', id, status], queryFn: () => get<{ items: Json[] }>(`/api/admin/campaigns/${id}/recipients?status=${status}`) });
  if (!q.data) return <Spinner />;
  const c = q.data.campaign;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['campaign', id] });
      qc.invalidateQueries({ queryKey: ['campaign-recipients', id] });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const reached = c.total - c.skipped;
  const funnel: [string, number][] = [
    ['Sent', c.sent],
    ['Delivered', c.delivered],
    ['Read', c.read],
    ['Replied', c.replied],
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/campaigns" className="small">
            ← Campaigns
          </Link>
          <h1>{c.name}</h1>
          <p>
            <span className={`chip ${STATUS[c.status]?.[1] ?? ''}`}>{STATUS[c.status]?.[0]}</span> {c.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} · {c.purpose}
            {c.started_at && ` · started ${dateTime(c.started_at)}`}
            {c.status === 'scheduled' && ` · goes out ${dateTime(c.scheduled_at)}`}
          </p>
          {c.last_error && <p className="bad-text small">{c.last_error}</p>}
        </div>
        <div className="row">
          {c.status === 'draft' && (
            <>
              <button className="btn danger" onClick={() => window.confirm('Delete this draft?') && act(() => del(`/api/admin/campaigns/${id}`), 'Deleted').then(() => nav('/campaigns'))}>
                Delete
              </button>
              <button className="btn" onClick={() => setSchedule(true)}>
                Schedule
              </button>
              <button className="btn primary" onClick={() => window.confirm('Send this campaign now?') && act(() => post(`/api/admin/campaigns/${id}/start`, {}), 'Campaign started')}>
                Send now
              </button>
            </>
          )}
          {['sending', 'scheduled'].includes(c.status) && (
            <button className="btn danger" onClick={() => window.confirm('Stop sending? People not yet reached will be skipped.') && act(() => post(`/api/admin/campaigns/${id}/cancel`), 'Cancelled')}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="kpis">
        <div className="panel kpi">
          <div className="l">Audience</div>
          <div className="v">{number(c.total)}</div>
          <div className="small muted">{number(c.skipped)} skipped</div>
        </div>
        {funnel.map(([l, n]) => (
          <div key={l} className="panel kpi">
            <div className="l">{l}</div>
            <div className="v">{number(n)}</div>
            <div className="small muted">{l === 'Sent' ? `${pct(n, reached)} of reachable` : `${pct(n, c.sent)} of sent`}</div>
          </div>
        ))}
        <div className="panel kpi">
          <div className="l">Business in 30 days</div>
          <div className="v tone-good">{money(q.data.outcome.wonAmount)}</div>
          <div className="small muted">
            {q.data.outcome.wonDeals} deals won · {q.data.outcome.converted} leads converted
          </div>
        </div>
      </div>
      <div className="grid2" style={{ marginBottom: 16 }}>
        <section className="panel panel-body">
          <h3>Why people were skipped</h3>
          {q.data.skipped.length ? (
            q.data.skipped.map((s: Json) => (
              <div key={s.reason} className="spread small">
                <span>{REASONS[s.reason] ?? s.reason}</span>
                <b>{number(s.n)}</b>
              </div>
            ))
          ) : (
            <p className="muted small">Nobody was skipped.</p>
          )}
        </section>
        <section className="panel panel-body">
          <h3>Failures</h3>
          {q.data.errors.length ? (
            q.data.errors.map((s: Json) => (
              <div key={s.error} className="spread small">
                <span>{s.error}</span>
                <b>{number(s.n)}</b>
              </div>
            ))
          ) : (
            <p className="muted small">No failures.</p>
          )}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Recipients</h2>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
            {['any', 'queued', 'sent', 'delivered', 'read', 'replied', 'skipped', 'failed'].map((s) => (
              <option key={s} value={s}>
                {s === 'any' ? 'Everyone' : s}
              </option>
            ))}
          </select>
        </div>
        <table className="data">
          <tbody>
            {rec.data?.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/o/${r.subject_object}/${r.subject_id}`}>{r.name}</Link>
                </td>
                <td className="mono small">{r.address}</td>
                <td>
                  <span className="chip">{r.status}</span> {r.skip_reason && <span className="muted small">{REASONS[r.skip_reason] ?? r.skip_reason}</span>}
                  {r.error && <div className="small bad-text">{r.error}</div>}
                </td>
                <td className="muted small">{r.sent_at ? relative(r.sent_at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {schedule && (
        <Modal
          title="Schedule the campaign"
          onClose={() => setSchedule(false)}
          footer={
            <button className="btn primary" disabled={!when} onClick={() => act(() => post(`/api/admin/campaigns/${id}/start`, { scheduleAt: new Date(when).toISOString() }), 'Scheduled').then(() => setSchedule(false))}>
              Schedule
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Send at
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <p className="muted small">The audience is fixed now; consent is checked again when each message goes out. Messages go out in batches every few minutes.</p>
          </div>
        </Modal>
      )}
    </>
  );
}

export { patch };
