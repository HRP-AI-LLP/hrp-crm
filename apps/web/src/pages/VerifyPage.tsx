/** /verify/:tenant/:code — anyone holding a signed document checks its signature here. */
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { date, money2 } from '../lib/format';
import { Spinner } from '../components/ui';

const TYPES: Record<string, string> = { invoice: 'Tax invoice', quote: 'Quotation', sales_order: 'Sales order', purchase_order: 'Purchase order' };

export function VerifyPage() {
  const { tenant = '', code = '' } = useParams();
  const q = useQuery({
    queryKey: ['verify', tenant, code],
    queryFn: async () => {
      const r = await fetch(`/api/public/verify/${encodeURIComponent(tenant)}/${encodeURIComponent(code)}`);
      if (!r.ok) throw new Error('not found');
      return r.json() as Promise<Record<string, any>>;
    },
    retry: false,
  });
  return (
    <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
      <div className="panel">
        <div className="panel-head">
          <h2>Signature check</h2>
          <span className="mono small">{code.toUpperCase()}</span>
        </div>
        <div className="panel-body stack">
          {q.isLoading ? (
            <Spinner />
          ) : !q.data?.found ? (
            <p>
              <b>No signature has this code.</b> Check the code printed on the document.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 18, margin: 0 }}>
                {q.data.valid ? (
                  <span className="chip good">✓ Valid signature</span>
                ) : q.data.revoked ? (
                  <span className="chip bad">The signature was withdrawn</span>
                ) : (
                  <span className="chip bad">✗ The document no longer matches what was signed{q.data.document.status === 'cancelled' ? ' (it was cancelled)' : ''}</span>
                )}
              </p>
              <table className="data">
                <tbody>
                  <tr>
                    <th>Issued by</th>
                    <td>{q.data.issuer ?? '—'}</td>
                  </tr>
                  <tr>
                    <th>Document</th>
                    <td>
                      {TYPES[q.data.document.type] ?? q.data.document.type} {q.data.document.number ?? ''}
                    </td>
                  </tr>
                  <tr>
                    <th>Date</th>
                    <td>{q.data.document.date ? date(q.data.document.date) : '—'}</td>
                  </tr>
                  {q.data.document.total != null && (
                    <tr>
                      <th>Total</th>
                      <td>{money2(q.data.document.total)}</td>
                    </tr>
                  )}
                  <tr>
                    <th>Signed by</th>
                    <td>
                      {q.data.signer.name}
                      {q.data.signer.designation ? `, ${q.data.signer.designation}` : ''}
                    </td>
                  </tr>
                  <tr>
                    <th>Signed on</th>
                    <td>{new Date(q.data.signedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small" style={{ margin: 0 }}>
                Compare these details with the document you hold. “Valid” means the number, date, customer, totals and every line are as they were when it was signed.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
