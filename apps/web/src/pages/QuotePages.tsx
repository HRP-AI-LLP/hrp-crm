import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QuoteDocument, type QuoteDoc } from '../components/QuoteDocument';
import { Spinner } from '../components/ui';
import { ApiError, get } from '../lib/api';

/** Printable quote for staff (Ctrl/⌘+P → Save as PDF gives an A4 PDF). */
export function QuotePrintPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['quote', id], queryFn: () => get<QuoteDoc>(`/api/v1/quotes/${id}`) });
  useEffect(() => {
    if (data) document.title = `${data.quote.quote_number ?? 'Quote'} — ${data.quote.name}`;
  }, [data]);
  if (error) return <p style={{ padding: 32 }}>This quote is not available.</p>;
  if (!data) return <div style={{ padding: 32 }}><Spinner /></div>;
  return (
    <div className="print-page">
      <div className="print-bar no-print">
        <Link to={`/o/quote/${id}`}>← Back to the quote</Link>
        <span className="muted small">Tip: choose “Save as PDF” as the printer to download a PDF.</span>
        <button className="btn primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>
      <QuoteDocument doc={data} />
    </div>
  );
}

/** What the customer sees at /q/:token — review, then accept or decline. */
export function PublicQuotePage() {
  const { token = '' } = useParams();
  const [doc, setDoc] = useState<QuoteDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch(`/api/public/quotes/${encodeURIComponent(token)}`);
    if (!r.ok) {
      setError('This quote link is not valid any more. Please ask your contact for a new one.');
      return;
    }
    const j = (await r.json()) as QuoteDoc;
    setDoc(j);
    document.title = `${j.quote.quote_number ?? 'Quote'} from ${j.company.name}`;
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/public/quotes/${encodeURIComponent(token)}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept, name: name.trim(), comment: comment.trim() || null }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, 'error', j?.error?.message ?? 'Something went wrong');
      setDone(accept ? 'Thank you — the quote is accepted. We will be in touch with the next steps.' : 'Thanks for letting us know. We have recorded your response.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !doc) return <div className="public-wrap"><p>{error}</p></div>;
  if (!doc) return <div className="public-wrap"><Spinner /></div>;
  const status = String(doc.quote.status);
  return (
    <div className="print-page public-quote">
      <div className="print-bar no-print">
        <b>{doc.company.name}</b>
        <span className={`chip${status === 'accepted' ? ' good' : status === 'rejected' || status === 'expired' ? ' bad' : ''}`}>{status === 'sent' ? 'Awaiting your response' : status[0]!.toUpperCase() + status.slice(1)}</span>
        <button className="btn" onClick={() => window.print()}>
          Download PDF
        </button>
      </div>
      <QuoteDocument doc={doc} />
      {status === 'sent' && !done && (
        <section className="respond no-print" aria-label="Respond to this quote">
          <h2>Your response</h2>
          <div className="grid2">
            <label className="field">
              Your full name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
            <label className="field">
              Comments (optional)
              <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
            </label>
          </div>
          <label className="row small" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read the quotation and its terms.
          </label>
          {error && <p className="field-error">{error}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || name.trim().length < 2 || !agree} onClick={() => respond(true)}>
              Accept quote
            </button>
            <button className="btn" disabled={busy || name.trim().length < 2} onClick={() => respond(false)}>
              Decline
            </button>
          </div>
        </section>
      )}
      {done && <section className="respond no-print"><p>{done}</p></section>}
      <p className="muted small no-print" style={{ textAlign: 'center', margin: '24px 0' }}>
        Sent with SanchalanOS
      </p>
    </div>
  );
}
