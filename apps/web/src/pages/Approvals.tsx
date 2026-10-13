import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money2, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';

type Json = Record<string, any>;
const BOXES = [
  ['inbox', 'Waiting for me'],
  ['mine', 'My requests'],
  ['all', 'All requests'],
] as const;

/** Approval inbox: decide on requests addressed to you, follow your own, (admins) see everything. */
export function ApprovalsPage() {
  const { me, can } = useAuth();
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const box = (params.get('box') as 'inbox' | 'mine' | 'all') ?? 'inbox';
  const [status, setStatus] = useState<string>(box === 'inbox' ? 'pending' : '');
  const [deciding, setDeciding] = useState<{ item: Json; approve: boolean } | null>(null);
  const [comment, setComment] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['approvals', box, status],
    queryFn: () => get<{ items: Json[] }>(`/api/v1/approvals?box=${box}${status ? `&status=${status}` : ''}`),
  });
  const highlight = params.get('request');
  const showAll = me?.user.isOwner || can('workflows');
  const label = (k: string) => meta?.objects.find((o) => o.key === k)?.label ?? k;

  const submit = async () => {
    if (!deciding) return;
    try {
      await post(`/api/v1/approvals/${deciding.item.id}/decide`, { approve: deciding.approve, comment: comment.trim() || null });
      toast(deciding.approve ? 'Approved' : 'Rejected');
      setDeciding(null);
      setComment('');
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['record', deciding.item.objectKey, deciding.item.recordId] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>Discounts, purchase orders and other records that need a second pair of eyes.</p>
        </div>
      </div>
      <div className="spread" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" style={{ border: 0 }}>
          {BOXES.filter(([k]) => k !== 'all' || showAll).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={box === k}
              onClick={() => {
                setParams({ box: k });
                setStatus(k === 'inbox' ? 'pending' : '');
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
          <option value="">Any status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <section className="panel">
        {isLoading ? (
          <div className="panel-body">
            <Spinner />
          </div>
        ) : !data?.items.length ? (
          <Empty title={box === 'inbox' ? 'Nothing waiting for you' : 'No requests'}>{box === 'inbox' ? 'Requests addressed to you appear here, and you get a notification.' : 'Requests appear once someone submits a record for approval.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Rule</th>
                  <th className="num">Amount</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} className={highlight === a.id ? 'row-highlight' : undefined}>
                    <td>
                      <Link to={`/o/${a.objectKey}/${a.recordId}`}>
                        <b>{a.summary?.title ?? label(a.objectKey)}</b>
                      </Link>
                      <div className="muted small">
                        {label(a.objectKey)}
                        {a.summary?.quote_number ? ` · ${a.summary.quote_number}` : a.summary?.po_number ? ` · ${a.summary.po_number}` : ''}
                        {a.summary?.max_discount_pct ? ` · up to ${a.summary.max_discount_pct}% off` : ''}
                      </div>
                      {a.note && <div className="small">“{a.note}”</div>}
                    </td>
                    <td className="small">{a.ruleName}</td>
                    <td className="num">{a.summary?.grand_total !== undefined ? money2(a.summary.grand_total) : '—'}</td>
                    <td className="small">
                      {a.requestedByName ?? '—'}
                      <div className="muted">{relative(a.createdAt)}</div>
                    </td>
                    <td>
                      <span className={`chip ${a.status === 'approved' ? 'good' : a.status === 'rejected' ? 'bad' : a.status === 'pending' ? 'info' : ''}`}>{a.status}</span>
                      {a.decidedByName && <div className="muted small">by {a.decidedByName}</div>}
                      {a.status === 'pending' && !a.decidedByName && <div className="muted small">{a.approverName ?? (a.approverRole ? `role: ${a.approverRole}` : '')}</div>}
                    </td>
                    <td>
                      {a.canDecide && (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn sm primary" onClick={() => setDeciding({ item: a, approve: true })}>
                            Approve
                          </button>
                          <button className="btn sm" onClick={() => setDeciding({ item: a, approve: false })}>
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {deciding && (
        <Modal
          title={deciding.approve ? 'Approve request' : 'Reject request'}
          onClose={() => setDeciding(null)}
          footer={
            <button className={`btn ${deciding.approve ? 'primary' : 'danger'}`} disabled={!deciding.approve && !comment.trim()} onClick={submit}>
              {deciding.approve ? 'Approve' : 'Reject'}
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <p style={{ marginTop: 0 }}>
              <b>{deciding.item.summary?.title}</b> · {deciding.item.ruleName}
            </p>
            <label className="field">
              {deciding.approve ? 'Comment (optional)' : 'Reason (required)'}
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
