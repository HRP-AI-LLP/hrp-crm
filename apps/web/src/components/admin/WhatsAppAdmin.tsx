/** Settings → Channels: WhatsApp templates (sync, submit for approval) and inbox quick replies. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../lib/api';
import { relative } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

const TONE: Record<string, string> = { APPROVED: 'good', PENDING: 'info', IN_APPEAL: 'info', REJECTED: 'bad', PAUSED: 'warn', DISABLED: 'bad' };

export function TemplatesModal({ account, onClose }: { account: Json; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['wa-templates-admin', account.id];
  const q = useQuery({ queryKey: key, queryFn: () => get<{ items: Json[] }>(`/api/admin/whatsapp/${account.id}/templates`) });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await post<{ count: number }>(`/api/admin/whatsapp/${account.id}/templates/sync`);
      toast(`${r.count} templates synced`);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['wa-templates'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal wide title={`Templates · ${account.name}`} onClose={onClose}>
      <div className="modal-body stack">
        <div className="spread">
          <p className="muted small" style={{ margin: 0 }}>
            WhatsApp needs an approved template to start a conversation, or to reply more than 24 hours after the customer’s last message.
          </p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={sync}>
              {busy ? 'Syncing…' : 'Sync from WhatsApp'}
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              New template
            </button>
          </div>
        </div>
        {!q.data ? (
          <Spinner />
        ) : !q.data.items.length ? (
          <Empty title="No templates">Sync the templates you made in WhatsApp Manager, or create one here and submit it for approval.</Empty>
        ) : (
          <table className="data">
            <tbody>
              {q.data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <b>{t.name}</b>
                    <div className="muted small">
                      {t.language} · {t.category.toLowerCase()} · {t.variable_count} variables
                    </div>
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal', maxWidth: 380 }}>
                    {t.body_text}
                  </td>
                  <td>
                    <span className={`chip ${TONE[t.status] ?? ''}`} title={t.rejected_reason ?? undefined}>
                      {t.status.toLowerCase().replace('_', ' ')}
                    </span>
                    {t.synced_at && <div className="muted small">{relative(t.synced_at)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <NewTemplate
          accountId={account.id}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </Modal>
  );
}

function NewTemplate({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', language: 'en', category: 'MARKETING', header: '', body: '', footer: '' });
  const [examples, setExamples] = useState<string[]>([]);
  const [buttons, setButtons] = useState<Json[]>([]);
  const vars = [...f.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const n = vars.length ? Math.max(...vars) : 0;
  const submit = async () => {
    try {
      const r = await post<{ status: string }>(`/api/admin/whatsapp/${accountId}/templates`, { ...f, header: f.header || null, footer: f.footer || null, examples: examples.slice(0, n), buttons });
      toast(`Submitted. WhatsApp status: ${r.status.toLowerCase()}`);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      wide
      title="New WhatsApp template"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!f.name || !f.body} onClick={submit}>
          Submit for approval
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Name (lowercase, no spaces)
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="diwali_offer_2026" />
        </label>
        <div className="grid2">
          <label className="field">
            Category
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="MARKETING">Marketing (offers, launches)</option>
              <option value="UTILITY">Utility (orders, payments, service)</option>
            </select>
          </label>
          <label className="field">
            Language
            <select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>
              {[['en', 'English'], ['en_US', 'English (US)'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['bn', 'Bengali'], ['ml', 'Malayalam'], ['pa', 'Punjabi']].map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field wide">
          Header (optional)
          <input maxLength={60} value={f.header} onChange={(e) => setF({ ...f, header: e.target.value })} />
        </label>
        <label className="field wide">
          Message (use {'{{1}}'}, {'{{2}}'} for personal details)
          <textarea rows={5} maxLength={1024} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={'Hi {{1}}, our Diwali offer on modular kitchens ends on {{2}}. Reply YES for a free design visit.'} />
        </label>
        {Array.from({ length: n }, (_, i) => (
          <label key={i} className="field">
            Example for {`{{${i + 1}}}`}
            <input value={examples[i] ?? ''} onChange={(e) => setExamples(Array.from({ length: n }, (_, j) => (j === i ? e.target.value : (examples[j] ?? ''))))} />
          </label>
        ))}
        <label className="field wide">
          Footer (optional)
          <input maxLength={60} value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} placeholder="Reply STOP to opt out" />
        </label>
        <div className="wide stack">
          <div className="spread">
            <b className="small">Buttons</b>
            <div className="row">
              <button className="btn sm" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])}>
                + Quick reply
              </button>
              <button className="btn sm" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: 'https://' }])}>
                + Link
              </button>
            </div>
          </div>
          {buttons.map((b, i) => (
            <div key={i} className="row">
              <span className="chip">{b.type === 'URL' ? 'link' : 'reply'}</span>
              <input placeholder="Button text" maxLength={25} value={b.text} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              {b.type === 'URL' && <input placeholder="https://" value={b.url} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />}
              <button className="btn sm ghost" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} aria-label="Remove button">
                ✕
              </button>
            </div>
          ))}
          {f.category === 'MARKETING' && <p className="muted small">A “Stop promotions” button is added to marketing templates. Tapping it opts the person out automatically.</p>}
        </div>
      </div>
    </Modal>
  );
}

export function QuickReplies() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['quick-replies'], queryFn: () => get<{ items: Json[] }>('/api/v1/quick-replies') });
  const [f, setF] = useState({ shortcut: '', title: '', body: '' });
  const save = async () => {
    try {
      await post('/api/admin/quick-replies', f);
      setF({ shortcut: '', title: '', body: '' });
      qc.invalidateQueries({ queryKey: ['quick-replies'] });
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <section className="stack" style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Saved replies for the inbox</h3>
      <p className="muted small" style={{ margin: 0 }}>
        Type / and the shortcut in a reply to insert one.
      </p>
      <table className="data">
        <tbody>
          {q.data?.items.map((r) => (
            <tr key={r.id}>
              <td className="mono small">/{r.shortcut}</td>
              <td>
                <b>{r.title}</b>
                <div className="muted small">{r.body.slice(0, 120)}</div>
              </td>
              <td>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    await del(`/api/admin/quick-replies/${r.id}`);
                    qc.invalidateQueries({ queryKey: ['quick-replies'] });
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid2">
        <input placeholder="shortcut, e.g. price" value={f.shortcut} onChange={(e) => setF({ ...f, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} />
        <input placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <textarea className="wide" rows={2} placeholder="Reply text" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <div>
          <button className="btn" disabled={!f.shortcut || !f.title || !f.body} onClick={save}>
            Add saved reply
          </button>
        </div>
      </div>
    </section>
  );
}
