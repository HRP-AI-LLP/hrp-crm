/** Payment reminders: the workspace's settings (Books → Settings) and "Send reminder" on an invoice. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api';
import { useToast } from '../ui';

type Json = Record<string, any>;

export function ReminderSettings() {
  const { data } = useQuery({ queryKey: ['books', 'reminders'], queryFn: () => get<Json>('/api/v1/books/reminders') });
  const [f, setF] = useState<Json | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (data) setF({ ...data, afterText: (data.afterDays ?? []).join(', ') });
  }, [data]);
  if (!f) return null;
  const save = async () => {
    try {
      const afterDays = String(f.afterText)
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => n > 0)
        .slice(0, 8);
      await put('/api/v1/books/reminders', { enabled: !!f.enabled, beforeDays: Number(f.beforeDays) || 0, onDue: !!f.onDue, afterDays, skipGovernment: !!f.skipGovernment, cc: f.cc ?? '', note: f.note ?? '' });
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="panel" style={{ padding: 14 }}>
      <h3 style={{ marginTop: 0 }}>Payment reminders to customers</h3>
      <p className="small muted" style={{ marginTop: 4 }}>
        A polite email with the invoice details (and the online payment link, when there is one) to the invoice's contact, or the customer's first contact with an email. Replies come to the address below, or to the company email.
      </p>
      <div className="stack">
        <label className="row">
          <input type="checkbox" checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Send reminders automatically
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label className="field">
            Days before the due date (0 = none)
            <input type="number" min={0} max={30} value={f.beforeDays} onChange={(e) => setF({ ...f, beforeDays: e.target.value })} />
          </label>
          <label className="field">
            Days after the due date
            <input value={f.afterText} onChange={(e) => setF({ ...f, afterText: e.target.value })} placeholder="7, 15, 30" />
          </label>
          <label className="field">
            Copy to / replies to
            <input type="email" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} placeholder="accounts@yourcompany.in" />
          </label>
        </div>
        <label className="row">
          <input type="checkbox" checked={!!f.onDue} onChange={(e) => setF({ ...f, onDue: e.target.checked })} /> Also on the due date
        </label>
        <label className="row">
          <input type="checkbox" checked={!!f.skipGovernment} onChange={(e) => setF({ ...f, skipGovernment: e.target.checked })} /> Not to government buyers (they pay through their own process)
        </label>
        <label className="field">
          A line to add (bank details, UPI id …)
          <textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Bank: Yes Bank · A/c 0000000000 · IFSC YESB0000000" />
        </label>
        <div>
          <button className="btn primary" onClick={save}>
            Save reminders
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemindButton({ invoiceId }: { invoiceId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sent = useQuery({ queryKey: ['books', 'reminders', invoiceId], queryFn: () => get<Json[]>(`/api/v1/books/invoices/${invoiceId}/reminders`), retry: false });
  const [busy, setBusy] = useState(false);
  const last = sent.data?.[0];
  return (
    <button
      className="btn sm"
      disabled={busy}
      title={last ? `Last reminder ${new Date(last.sent_at).toLocaleDateString('en-IN')} to ${last.sent_to}` : 'Email the customer a payment reminder now'}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await post<Json>(`/api/v1/books/invoices/${invoiceId}/remind`, {});
          toast(`Reminder sent to ${r.to}`);
          qc.invalidateQueries({ queryKey: ['books', 'reminders', invoiceId] });
          qc.invalidateQueries({ queryKey: ['timeline', 'invoice', invoiceId] });
        } catch (e) {
          toast((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Sending…' : `Send reminder${sent.data?.length ? ` (${sent.data.length} sent)` : ''}`}
    </button>
  );
}
