/**
 * Signatures on a document (invoice, quote, order, purchase order): who signed and when, whether the
 * document is unchanged since, and signing with one of the saved signatures the person may use.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DSC_KINDS, signWithPfx, signWithToken } from '../lib/dsc';
import { dateTime } from '../lib/format';
import { Modal, useToast } from './ui';

type Json = Record<string, any>;

export function useDocSignatures(object: string, id: string) {
  return useQuery({ queryKey: ['doc-signatures', object, id], queryFn: () => get<Json[]>(`/api/v1/documents/${object}/${id}/signatures`), staleTime: 30_000 });
}

export function SignaturesPanel({ object, id, signable, why }: { object: string; id: string; signable: boolean; why?: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sigs = useDocSignatures(object, id);
  const mine = useQuery({ queryKey: ['org-signatures'], queryFn: () => get<Json[]>('/api/v1/organisation/signatures'), staleTime: 60_000 });
  const [revoke, setRevoke] = useState<Json | null>(null);
  const [reason, setReason] = useState('');
  const { me } = useAuth();
  const dscQ = useQuery({ queryKey: ['org-dsc'], queryFn: () => get<Json>('/api/v1/organisation/dsc'), staleTime: 60_000, enabled: DSC_KINDS.includes(object), retry: false });
  const certs = ((dscQ.data?.certificates ?? []) as Json[]).filter((c) => c.canSign && !c.expired);
  const [busy, setBusy] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<Json | null>(null);
  const [pin, setPin] = useState('');
  const dscSign = async (c: Json, tokenPin?: string) => {
    setBusy(c.id);
    try {
      if (c.kind === 'pfx') await signWithPfx(object, id, c.id, me);
      else await signWithToken(object, id, c.id, tokenPin ?? '', me!, dscQ.data?.signers ?? []);
      qc.invalidateQueries({ queryKey: ['doc-signatures', object, id] });
      qc.invalidateQueries({ queryKey: ['files', object, id] });
      toast(`Signed with ${c.subjectCn}'s DSC; the signed PDF is in Files`);
      setPinFor(null);
      setPin('');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const usable = (mine.data ?? []).filter((s) => s.canSign && !(sigs.data ?? []).some((d) => !d.revoked && d.signerName === s.signerName));
  const list = sigs.data ?? [];
  if (!list.length && !usable.length && !certs.length) return null;
  const sign = async (signatureId: string) => {
    try {
      await post(`/api/v1/documents/${object}/${id}/sign`, { signatureId });
      qc.invalidateQueries({ queryKey: ['doc-signatures', object, id] });
      toast('Signed');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>Signatures</h2>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {usable.map((s) => (
            <button key={s.id} className="btn sm" disabled={!signable} title={signable ? '' : why} onClick={() => sign(s.id)}>
              Sign as {s.signerName}
            </button>
          ))}
          {certs.map((c) => (
            <button key={c.id} className="btn sm primary" disabled={!signable || !!busy} title={signable ? `${c.subject}` : why} onClick={() => (c.kind === 'token' ? setPinFor(c) : dscSign(c))}>
              {busy === c.id ? 'Signing…' : `Sign with DSC: ${c.subjectCn}${c.kind === 'token' ? ' (token)' : ''}`}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body stack">
        {!signable && usable.length > 0 && why && <p className="muted small" style={{ margin: 0 }}>{why}</p>}
        {list.map((s) => (
          <div key={s.id} className="row" style={{ gap: 12, alignItems: 'center', opacity: s.revoked ? 0.55 : 1 }}>
            {s.image ? (
              <img src={s.image} alt={`Signature of ${s.signerName}`} style={{ height: 40, maxWidth: 140, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)', borderRadius: 6 }} />
            ) : (
              <span className="chip" style={{ minWidth: 60, textAlign: 'center' }}>
                DSC
              </span>
            )}
            <div className="small" style={{ flex: 1 }}>
              <b>{s.signerName}</b>
              {s.designation ? `, ${s.designation}` : ''} · signed {dateTime(s.signedAt)} · code <span className="mono">{s.verifyCode}</span>
              {s.method !== 'image' && (
                <span>
                  {' '}
                  · digital signature ({s.method === 'dsc_token' ? 'USB token' : 'certificate file'}){s.fileUrl && (
                    <>
                      {' '}
                      ·{' '}
                      <a href={s.fileUrl} target="_blank" rel="noreferrer">
                        signed PDF
                      </a>
                    </>
                  )}
                </span>
              )}
              <div>
                {s.revoked ? (
                  <span className="chip bad">Withdrawn{s.revokeReason ? `: ${s.revokeReason}` : ''}</span>
                ) : s.valid ? (
                  <span className="chip good">Valid: the document is unchanged since</span>
                ) : (
                  <span className="chip bad">The document changed after signing</span>
                )}
              </div>
            </div>
            {!s.revoked && (
              <button className="btn ghost sm" onClick={() => setRevoke(s)}>
                Withdraw
              </button>
            )}
          </div>
        ))}
      </div>
      {pinFor && (
        <Modal
          title={`Sign with ${pinFor.subjectCn}'s token`}
          onClose={() => setPinFor(null)}
          footer={
            <button className="btn primary" disabled={!pin || !!busy} onClick={() => dscSign(pinFor, pin)}>
              {busy ? 'Signing…' : 'Sign'}
            </button>
          }
        >
          <div className="modal-body stack">
            <p className="small muted" style={{ margin: 0 }}>
              Plug in the token and keep the DSC signer running on this computer. The PIN goes only to the signer here, never to the server.
            </p>
            <label className="field">
              Token PIN
              <input type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && pin && dscSign(pinFor, pin)} />
            </label>
          </div>
        </Modal>
      )}
      {revoke && (
        <Modal
          title={`Withdraw ${revoke.signerName}'s signature`}
          onClose={() => setRevoke(null)}
          footer={
            <button
              className="btn primary"
              disabled={reason.trim().length < 3}
              onClick={async () => {
                try {
                  await post(`/api/v1/documents/${object}/${id}/signatures/${revoke.id}/revoke`, { reason });
                  qc.invalidateQueries({ queryKey: ['doc-signatures', object, id] });
                  setRevoke(null);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Withdraw
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Why
              <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
          </div>
        </Modal>
      )}
    </section>
  );
}
