import type { RecordDto } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dateTime, money2 } from '../lib/format';
import { Modal, useToast } from './ui';

type Json = Record<string, any>;

const STATUS_TEXT: Record<string, string> = {
  required: 'Needs approval before it can be sent',
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Approval was declined — change it and submit again',
};

/** Approval state of a record with submit / recall, plus the decision history. */
export function ApprovalBar({ object, record, canEdit }: { object: string; record: RecordDto; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const status = String(record.approval_status ?? 'not_required');
  const hist = useQuery({ queryKey: ['approval-history', object, record.id], queryFn: () => get<{ items: Json[] }>(`/api/v1/approvals/history/${object}/${record.id}`), enabled: status !== 'not_required' || showHistory });
  if (status === 'not_required' && !hist.data?.items.length) return null;
  const last = hist.data?.items[0];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['record', object, record.id] });
    qc.invalidateQueries({ queryKey: ['quote', record.id] });
    qc.invalidateQueries({ queryKey: ['approval-history', object, record.id] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
  };
  return (
    <div className={`approval-bar ${status}`}>
      <div>
        <b>{STATUS_TEXT[status] ?? 'No approval needed'}</b>
        {last && (
          <div className="muted small">
            {last.rule_name}
            {last.status === 'pending' && last.approver ? ` · with ${last.approver}` : ''}
            {last.decided_by_name ? ` · ${last.status} by ${last.decided_by_name} ${dateTime(last.decided_at)}` : ''}
            {last.decision_comment ? ` — “${last.decision_comment}”` : ''}
          </div>
        )}
      </div>
      <div className="row">
        {!!hist.data?.items.length && (
          <button className="btn sm ghost" onClick={() => setShowHistory(true)}>
            History
          </button>
        )}
        {canEdit && (status === 'required' || status === 'rejected') && (
          <button className="btn sm primary" onClick={() => setAsking(true)}>
            Submit for approval
          </button>
        )}
        {status === 'pending' && last?.status === 'pending' && (
          <button
            className="btn sm"
            onClick={async () => {
              try {
                await post(`/api/v1/approvals/${last.id}/recall`);
                toast('Request recalled');
                refresh();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Recall
          </button>
        )}
      </div>
      {asking && (
        <Modal
          title="Submit for approval"
          onClose={() => setAsking(false)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await post(`/api/v1/approvals/submit/${object}/${record.id}`, { note: note.trim() || null });
                  toast('Sent for approval');
                  setAsking(false);
                  setNote('');
                  refresh();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Submit
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <label className="field">
              Note for the approver (optional)
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this price or discount makes sense" autoFocus />
            </label>
          </div>
        </Modal>
      )}
      {showHistory && (
        <Modal title="Approval history" onClose={() => setShowHistory(false)}>
          <div className="modal-body" style={{ display: 'block' }}>
            <ul className="timeline">
              {hist.data?.items.map((h) => (
                <li key={h.id}>
                  <span className="ico" aria-hidden="true">
                    {h.status === 'approved' ? '✓' : h.status === 'rejected' ? '✕' : '…'}
                  </span>
                  <div>
                    <div className="spread">
                      <b>
                        {h.rule_name} · {h.status}
                      </b>
                      <span className="muted small">{dateTime(h.created_at)}</span>
                    </div>
                    <div className="muted small">
                      Requested by {h.requested_by_name ?? '—'}
                      {h.decided_by_name ? ` · decided by ${h.decided_by_name}` : h.approver ? ` · approver ${h.approver}` : ''}
                    </div>
                    {h.note && <div className="body">{h.note}</div>}
                    {h.decision_comment && <div className="body">“{h.decision_comment}”</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Revision family of a quote (R1, R2 …) with links between versions. */
export function QuoteRevisions({ quoteId }: { quoteId: string }) {
  const { data } = useQuery({ queryKey: ['quote-revisions', quoteId], queryFn: () => get<{ items: Json[] }>(`/api/v1/quotes/${quoteId}/revisions`) });
  if (!data || data.items.length < 2) return null;
  return (
    <div className="rev-strip" aria-label="Revisions">
      <span className="muted small">Revisions:</span>
      {data.items.map((r) =>
        r.id === quoteId ? (
          <span key={r.id} className="cur" aria-current="page">
            R{r.revision} · {r.status}
          </span>
        ) : (
          <Link key={r.id} to={`/o/quote/${r.id}`}>
            R{r.revision} · {r.status} · {money2(Number(r.grand_total))}
          </Link>
        ),
      )}
    </div>
  );
}

export function useApprovalCount(enabled = true) {
  return useQuery({ queryKey: ['approvals', 'count'], queryFn: () => get<{ pending: number }>('/api/v1/approvals/count'), refetchInterval: 120_000, enabled });
}
