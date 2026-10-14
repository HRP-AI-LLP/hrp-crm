import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../../lib/api';
import { dateTime, money2 } from '../../lib/format';
import { useIntegrationStatus } from '../MailboxPanel';
import { Modal, useToast } from '../ui';

type Json = Record<string, any>;
const STATUS: Record<string, string> = { created: 'info', paid: 'good', partially_paid: 'warn', cancelled: '', expired: '', failed: 'bad' };

/**
 * "Collect online": Razorpay payment links for an invoice or an order (optionally one milestone).
 * Paid links record the receipt automatically through Razorpay's webhook.
 */
export function PaymentLinks({ invoiceId, salesOrderId, milestones, due, canCreate }: { invoiceId?: string; salesOrderId?: string; milestones?: Json[]; due: number; canCreate: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const st = useIntegrationStatus();
  const key = ['payment-links', invoiceId ?? salesOrderId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => get<{ items: Json[] }>(`/api/v1/payment-links?${invoiceId ? `invoiceId=${invoiceId}` : `salesOrderId=${salesOrderId}`}`),
    enabled: !!st.data?.payments,
  });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ url: string; amount: number; purpose: string; phone: string | null } | null>(null);
  if (!st.data?.payments) return null;
  const items = data?.items ?? [];
  const share = (url: string, amount: number, purpose: string, phone: string | null) =>
    `https://wa.me/${(phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(`Please pay ${money2(amount)} for ${purpose}: ${url}`)}`;
  return (
    <div className="pay-links">
      <div className="spread">
        <b>Online payment</b>
        {canCreate && due > 0 && (
          <button className="btn sm" onClick={() => setOpen(true)}>
            Collect online
          </button>
        )}
      </div>
      {items.length ? (
        <table className="data">
          <tbody>
            {items.map((l) => (
              <tr key={l.id}>
                <td>
                  <a href={l.short_url} target="_blank" rel="noopener noreferrer">
                    {l.short_url?.replace('https://', '')}
                  </a>
                  <div className="muted small">
                    {l.purpose} · {dateTime(l.created_at)}
                    {l.created_by_name ? ` · ${l.created_by_name}` : ''}
                  </div>
                </td>
                <td className="num">{money2(l.amount)}</td>
                <td>
                  <span className={`chip ${STATUS[l.status] ?? ''}`}>{String(l.status).replace('_', ' ')}</span>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {l.status === 'created' && (
                    <>
                      <button
                        className="link"
                        onClick={async () => {
                          await navigator.clipboard?.writeText(l.short_url).catch(() => undefined);
                          toast('Link copied');
                        }}
                      >
                        Copy
                      </button>
                      <button
                        className="link danger"
                        onClick={async () => {
                          try {
                            await post(`/api/v1/payment-links/${l.id}/cancel`);
                            qc.invalidateQueries({ queryKey: key });
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          Send a Razorpay link — the customer pays by UPI, card or net banking and the receipt is recorded here automatically.
        </p>
      )}
      {open && (
        <CollectModal
          due={due}
          invoiceId={invoiceId}
          salesOrderId={salesOrderId}
          milestones={milestones}
          onClose={() => setOpen(false)}
          onCreated={(r) => {
            setOpen(false);
            setCreated(r);
            qc.invalidateQueries({ queryKey: key });
          }}
        />
      )}
      {created && (
        <Modal
          title="Payment link ready"
          onClose={() => setCreated(null)}
          footer={
            <>
              <button
                className="btn"
                onClick={async () => {
                  await navigator.clipboard?.writeText(created.url).catch(() => undefined);
                  toast('Link copied');
                }}
              >
                Copy link
              </button>
              <a className="btn primary" href={share(created.url, created.amount, created.purpose, created.phone)} target="_blank" rel="noopener noreferrer">
                Send on WhatsApp
              </a>
            </>
          }
        >
          <div className="modal-body" style={{ gridTemplateColumns: '1fr' }}>
            <p style={{ margin: 0 }}>
              {money2(created.amount)} for {created.purpose}
            </p>
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} className="mono" />
            <p className="muted small" style={{ margin: 0 }}>
              Razorpay also sends it by SMS and email when the customer has a phone number or email. Reminders go out automatically until it is paid.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CollectModal({ due, invoiceId, salesOrderId, milestones, onClose, onCreated }: { due: number; invoiceId?: string; salesOrderId?: string; milestones?: Json[]; onClose: () => void; onCreated: (r: { url: string; amount: number; purpose: string; phone: string | null }) => void }) {
  const toast = useToast();
  const open = (milestones ?? []).filter((m) => Number(m.amount) - Number(m.amount_paid ?? 0) > 0.009 && m.status !== 'waived');
  const [milestoneId, setMilestoneId] = useState<string>(open[0]?.id ?? '');
  const ms = open.find((m) => m.id === milestoneId);
  const max = ms ? Number(ms.amount) - Number(ms.amount_paid ?? 0) : due;
  const [amount, setAmount] = useState(String(Math.round(max * 100) / 100));
  const [sms, setSms] = useState(true);
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ url: string; amount: number; purpose: string; phone: string | null }>('/api/v1/payment-links', {
        invoiceId: invoiceId ?? null,
        salesOrderId: invoiceId ? null : salesOrderId,
        milestoneId: invoiceId ? null : milestoneId || null,
        amount: Number(amount),
        notifySms: sms,
        notifyEmail: email,
      });
      onCreated(r);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Collect payment online"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !(Number(amount) >= 1)} onClick={submit}>
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ gridTemplateColumns: '1fr' }}>
        {!invoiceId && open.length > 0 && (
          <label className="field">
            <span>For</span>
            <select
              value={milestoneId}
              onChange={(e) => {
                setMilestoneId(e.target.value);
                const m = open.find((x) => x.id === e.target.value);
                setAmount(String(m ? Number(m.amount) - Number(m.amount_paid ?? 0) : due));
              }}
            >
              {open.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {money2(Number(m.amount) - Number(m.amount_paid ?? 0))} due
                </option>
              ))}
              <option value="">Whole order balance — {money2(due)}</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Amount (₹)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="row">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> Razorpay sends it by SMS
        </label>
        <label className="row">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> …and by email
        </label>
      </div>
    </Modal>
  );
}
