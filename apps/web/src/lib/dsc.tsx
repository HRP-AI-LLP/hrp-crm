/**
 * Signing a document with a digital signature certificate: the document becomes a PDF in its
 * template, then either Synapse signs it with the uploaded .pfx, or the local signer signs it with the
 * USB token (PIN typed here, sent only to the signer on this computer).
 */
import { createRoot } from 'react-dom/client';
import { TemplatedDocument } from '../components/DocTemplateView';
import type { DocLabels, DocTemplate } from '../components/QuoteDocument';
import { shape, SOURCES } from '../pages/DocPrint';
import { get, post } from './api';
import { bytesToB64, documentToPdf, sha256Hex } from './doc-pdf';

type Json = Record<string, any>;

export const DSC_KINDS = ['invoice', 'sales_order', 'purchase_order'];

/** The document as a PDF, in its default template, with the signatures already on it. */
export async function documentPdf(kind: string, id: string, me: { tenant: { id: string } } | null) {
  const src = SOURCES[kind];
  if (!src) throw new Error('This document cannot be turned into a PDF');
  const [data, tpl, sigs] = await Promise.all([get<Json>(src(id)), get<DocTemplate | null>(`/api/v1/doc-templates/for/${kind}`), get<Json[]>(`/api/v1/documents/${kind}/${id}/signatures`)]);
  const s = shape(kind, data);
  if (!s) throw new Error('This document cannot be turned into a PDF');
  const labels: DocLabels = {
    ...s.labels,
    // signature images already on the document print on it; the DSC adds its own stamp
    signatures: sigs.filter((x) => !x.revoked && x.method === 'image') as NonNullable<DocLabels['signatures']>,
    verifyBase: me ? `${location.origin}/verify/${me.tenant.id}` : null,
  };
  return documentToPdf(
    (host) =>
      new Promise<void>((resolve) => {
        createRoot(host).render(<TemplatedDocument doc={s.doc} labels={labels} template={tpl} />);
        setTimeout(resolve, 60);
      }),
    tpl?.base === 'letterhead' ? { letterhead: tpl.letterhead, margins: tpl.settings.margins } : {},
  );
}

export async function signWithPfx(kind: string, id: string, certificateId: string, me: { tenant: { id: string } } | null) {
  const pdf = await documentPdf(kind, id, me);
  return post<Json>(`/api/v1/documents/${kind}/${id}/dsc/pfx`, { certificateId, pdf: bytesToB64(pdf) });
}

const PORT_KEY = 'synapse.dscSignerPort';
export function signerPort() {
  try {
    return Number(localStorage.getItem(PORT_KEY)) || 47321;
  } catch {
    return 47321;
  }
}
export function setSignerPort(p: number) {
  try {
    localStorage.setItem(PORT_KEY, String(p));
  } catch {
    /* per-browser convenience only */
  }
}

/** Talks to the signer on this computer. */
export async function local<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${signerPort()}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('The DSC signer is not running on this computer (pnpm local starts it; or run tools/dsc-signer/start-signer.bat), or the browser blocked it');
  }
  const j = (await r.json().catch(() => ({}))) as Json;
  if (!r.ok) throw new Error(j.error ?? `The signer answered ${r.status}`);
  return j as T;
}

/** Which paired signer of this workspace is running here. */
export async function localSigner(tenantId: string, paired: { id: string }[]) {
  const st = await local<{ signers: { tenant: string; signer: string }[] }>('/v1/status');
  const mine = st.signers.find((s) => s.tenant === tenantId && paired.some((p) => p.id === s.signer));
  if (!mine) throw new Error('The signer on this computer is not paired with this workspace (Settings → Organisation → Digital signatures → Pair a signer)');
  return mine.signer;
}

export async function signWithToken(kind: string, id: string, certificateId: string, pin: string, me: { tenant: { id: string } }, paired: { id: string }[]) {
  const signerId = await localSigner(me.tenant.id, paired);
  const pdf = await documentPdf(kind, id, me);
  const t = await post<{ ticket: string }>(`/api/v1/documents/${kind}/${id}/dsc/ticket`, { certificateId, signerId, pdfSha256: await sha256Hex(pdf), pdfLength: pdf.length });
  const signed = await local<{ pdf: string }>('/v1/sign', { ticket: t.ticket, pdf: bytesToB64(pdf), pin });
  return post<Json>(`/api/v1/documents/${kind}/${id}/dsc/token`, { ticket: t.ticket, pdf: signed.pdf });
}
