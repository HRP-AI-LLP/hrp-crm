/**
 * Viewing and signing any attached document. A PDF or photo opens in a viewer with the people who
 * signed it; anyone who may change the record can put a saved signature on it (chosen pages and
 * corner) or digitally sign it with a DSC kept in SanchalanOS (.pfx) or on a USB token through the local
 * signer. Each signing keeps a new "… - signed.pdf" next to the original.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { signFileWithToken } from '../lib/dsc';
import { dateTime } from '../lib/format';
import { Modal, Spinner, useToast } from './ui';

type Json = Record<string, any>;
type Pos = 'bottom-right' | 'bottom-left' | 'bottom-center' | 'top-right' | 'top-left';
const POSITIONS: [Pos, string][] = [
  ['top-left', 'Top left'],
  ['top-right', 'Top right'],
  ['bottom-left', 'Bottom left'],
  ['bottom-center', 'Bottom centre'],
  ['bottom-right', 'Bottom right'],
];

/** A small button that opens the viewer: drop it wherever a file is listed. */
export function ViewSignButton({ fileId, name, label = 'View / sign', className = 'btn sm', onSigned }: { fileId: string; name?: string; label?: string; className?: string; onSigned?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={name ? `View or sign ${name}` : undefined}>
        {label}
      </button>
      {open && <DocumentViewer fileId={fileId} onClose={() => setOpen(false)} onSigned={onSigned} />}
    </>
  );
}

function PositionPicker({ value, onChange }: { value: Pos; onChange: (p: Pos) => void }) {
  // a page with five spots to put the signature
  return (
    <div className="sig-page" role="radiogroup" aria-label="Where on the page">
      {POSITIONS.map(([p, l]) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} title={l} className={`spot ${p}${value === p ? ' on' : ''}`} onClick={() => onChange(p)}>
          <span className="sr-only">{l}</span>
        </button>
      ))}
    </div>
  );
}

function PagePicker({ pages, value, onChange, allowAll }: { pages: number; value: string | number; onChange: (v: string | number) => void; allowAll: boolean }) {
  const custom = typeof value === 'number';
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {(['last', 'first', ...(allowAll ? ['all'] : [])] as const).map((p) => (
        <button key={p} type="button" className={`btn sm${value === p ? ' primary' : ''}`} onClick={() => onChange(p)}>
          {p === 'last' ? 'Last page' : p === 'first' ? 'First page' : 'Every page'}
        </button>
      ))}
      {pages > 2 && (
        <label className="row small" style={{ gap: 4 }}>
          Page
          <input type="number" min={1} max={pages} value={custom ? value : ''} placeholder="#" style={{ width: 64 }} onChange={(e) => onChange(Math.min(pages, Math.max(1, Number(e.target.value) || 1)))} />
          <span className="muted">of {pages}</span>
        </label>
      )}
    </div>
  );
}

export function DocumentViewer({ fileId, onClose, onSigned }: { fileId: string; onClose: () => void; onSigned?: () => void }) {
  const [current, setCurrent] = useState(fileId);
  const q = useQuery({ queryKey: ['file-signing', current], queryFn: () => get<Json>(`/api/v1/files/${current}/signing`) });
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [mode, setMode] = useState<'view' | 'sign' | 'dsc'>('view');
  const [page, setPage] = useState<string | number>('last');
  const [pos, setPos] = useState<Pos>('bottom-right');
  const [sigId, setSigId] = useState('');
  const [certId, setCertId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const d = q.data;
  useEffect(() => {
    if (d?.imageSignatures?.length && !sigId) setSigId(d.imageSignatures[0].id);
    if (d?.certificates?.length && !certId) setCertId(d.certificates[0].id);
  }, [d, sigId, certId]);
  useEffect(() => {
    setText(null);
    if (d?.preview === 'text') fetch(d.file.url).then((r) => r.text()).then((t) => setText(t.slice(0, 200_000)), () => setText('Could not load the text.'));
  }, [d?.preview, d?.file?.url]);

  const done = (r: Json, what: string) => {
    toast(`${what} — the signed copy is saved next to the original`);
    qc.invalidateQueries({ queryKey: ['files'] });
    qc.invalidateQueries({ queryKey: ['file-signing'] });
    onSigned?.();
    setMode('view');
    setPin('');
    if (r.fileId) setCurrent(r.fileId);
  };
  const run = async (fn: () => Promise<Json>, what: string) => {
    setBusy(true);
    try {
      done(await fn(), what);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const cert = (d?.certificates ?? []).find((c: Json) => c.id === certId);
  const signDsc = () =>
    run(async () => {
      const placement = { page: page === 'all' ? 'last' : page, position: pos };
      if (cert?.kind === 'token') return signFileWithToken(current, certId, pin, placement, me!, d!.signers ?? []);
      return post<Json>(`/api/v1/files/${current}/dsc/pfx`, { certificateId: certId, ...placement });
    }, `Digitally signed with ${cert?.subjectCn ?? 'the DSC'}`);

  return (
    <Modal title={d?.file?.name ?? 'Document'} xl onClose={onClose}>
      <div className="doc-viewer" style={{ padding: '14px 18px' }}>
        <div className="doc-stage">
          {!d ? (
            <Spinner />
          ) : d.preview === 'pdf' ? (
            <iframe title={d.file.name} src={`${d.file.url}#view=FitH`} />
          ) : d.preview === 'image' ? (
            <img src={d.file.url} alt={d.file.name} />
          ) : d.preview === 'video' ? (
            <video src={d.file.url} controls />
          ) : d.preview === 'text' ? (
            <pre className="doc-text">{text ?? 'Loading…'}</pre>
          ) : (
            <div className="doc-none">
              <p>This kind of file cannot be shown in the browser.</p>
              <a className="btn primary" href={d.file.downloadUrl}>
                Download to open it
              </a>
            </div>
          )}
        </div>
        <aside className="doc-side">
          {d && (
            <>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <a className="btn sm" href={d.file.url} target="_blank" rel="noreferrer">
                  Open in a tab
                </a>
                <a className="btn sm" href={d.file.downloadUrl}>
                  Download
                </a>
                {current !== fileId && (
                  <button type="button" className="btn sm ghost" onClick={() => setCurrent(fileId)}>
                    ← Original
                  </button>
                )}
              </div>

              {d.digital && (
                <div className={`notice small ${d.digital.valid ? '' : 'warn'}`}>
                  {d.digital.valid ? '🔏 Digitally signed — the signature is valid and the PDF is unchanged since.' : `⚠️ Digital signature does not verify: ${d.digital.reason ?? 'changed after signing'}.`}
                  {d.digital.signer && <div className="muted">{d.digital.signer}</div>}
                </div>
              )}

              <div>
                <b className="small">Signatures</b>
                {d.signatures.length ? (
                  <ul className="sig-list">
                    {d.signatures.map((s: Json) => (
                      <li key={s.id} style={{ opacity: s.revoked ? 0.55 : 1 }}>
                        {s.image ? <img src={s.image} alt="" /> : <span className="chip">DSC</span>}
                        <div className="small">
                          <b>{s.signerName}</b>
                          {s.designation ? `, ${s.designation}` : ''}
                          <div className="muted">
                            {s.method === 'image' ? 'Signature' : s.method === 'dsc_token' ? 'DSC (USB token)' : 'DSC (certificate)'} · {dateTime(s.signedAt)} · <span className="mono">{s.verifyCode}</span>
                          </div>
                          {s.revoked ? (
                            <span className="chip bad">Withdrawn{s.revokeReason ? `: ${s.revokeReason}` : ''}</span>
                          ) : (
                            <span className="row" style={{ gap: 6 }}>
                              {s.fileId && !s.isThisFile && (
                                <button type="button" className="link-btn" onClick={() => setCurrent(s.fileId)}>
                                  View signed copy
                                </button>
                              )}
                              {d.canChange && (
                                <button
                                  type="button"
                                  className="link-btn muted"
                                  onClick={async () => {
                                    const reason = window.prompt('Why withdraw this signature?');
                                    if (!reason || reason.trim().length < 3) return;
                                    try {
                                      await post(`/api/v1/files/${current}/signatures/${s.id}/revoke`, { reason });
                                      qc.invalidateQueries({ queryKey: ['file-signing'] });
                                    } catch (e) {
                                      toast((e as Error).message, true);
                                    }
                                  }}
                                >
                                  Withdraw
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small" style={{ margin: '4px 0 0' }}>
                    Not signed yet.
                  </p>
                )}
              </div>

              {!d.canSign ? (
                d.whyNot && <p className="muted small">{d.whyNot}</p>
              ) : (
                <>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className={`btn sm${mode === 'sign' ? ' primary' : ''}`} onClick={() => setMode(mode === 'sign' ? 'view' : 'sign')}>
                      ✍️ Add signature
                    </button>
                    <button type="button" className={`btn sm${mode === 'dsc' ? ' primary' : ''}`} onClick={() => setMode(mode === 'dsc' ? 'view' : 'dsc')}>
                      🔏 Digital sign (DSC)
                    </button>
                  </div>

                  {mode === 'sign' &&
                    (d.imageSignatures.length ? (
                      <div className="stack panel" style={{ padding: 10 }}>
                        <div className="small">Signature</div>
                        <div className="sig-choices">
                          {d.imageSignatures.map((s: Json) => (
                            <button key={s.id} type="button" className={`sig-choice${sigId === s.id ? ' on' : ''}`} onClick={() => setSigId(s.id)}>
                              <img src={s.image} alt="" />
                              <span className="small">
                                {s.signerName}
                                {s.designation ? ` · ${s.designation}` : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="small">On</div>
                        <PagePicker pages={d.pages} value={page} onChange={setPage} allowAll />
                        <div className="small">Where</div>
                        <PositionPicker value={pos} onChange={setPos} />
                        <button type="button" className="btn primary" disabled={!sigId || busy} onClick={() => run(() => post<Json>(`/api/v1/files/${current}/sign-image`, { signatureId: sigId, page, position: pos }), 'Signed')}>
                          {busy ? 'Signing…' : 'Sign the document'}
                        </button>
                        <p className="muted small" style={{ margin: 0 }}>
                          The signature, name, date and a verification code go on the page. Add it before any digital signature.
                        </p>
                      </div>
                    ) : (
                      <p className="notice small">No saved signature you may use. Add yours under Settings → Organisation → Signatures (and name yourself as a signer).</p>
                    ))}

                  {mode === 'dsc' &&
                    (d.certificates.length ? (
                      <div className="stack panel" style={{ padding: 10 }}>
                        <label className="field" style={{ margin: 0 }}>
                          Certificate
                          <select value={certId} onChange={(e) => setCertId(e.target.value)}>
                            {d.certificates.map((c: Json) => (
                              <option key={c.id} value={c.id}>
                                {c.subjectCn} {c.kind === 'token' ? '(USB token)' : '(certificate file)'} · valid to {String(c.validTo).slice(0, 10)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="small">Stamp on</div>
                        <PagePicker pages={d.pages} value={page === 'all' ? 'last' : page} onChange={setPage} allowAll={false} />
                        <div className="small">Where</div>
                        <PositionPicker value={pos} onChange={setPos} />
                        {cert?.kind === 'token' && (
                          <label className="field" style={{ margin: 0 }}>
                            Token PIN <span className="muted small">(goes only to the signer on this computer)</span>
                            <input type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pin && signDsc()} />
                          </label>
                        )}
                        <button type="button" className="btn primary" disabled={!certId || busy || (cert?.kind === 'token' && !pin)} onClick={signDsc}>
                          {busy ? 'Signing…' : 'Digitally sign'}
                        </button>
                        <p className="muted small" style={{ margin: 0 }}>
                          A PAdES signature Adobe Reader shows as valid. After it, the PDF cannot be changed without breaking the signature.
                        </p>
                      </div>
                    ) : (
                      <p className="notice small">No digital signature certificate you may use. Add one under Settings → Organisation → Digital signatures and name yourself on it.</p>
                    ))}
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </Modal>
  );
}
