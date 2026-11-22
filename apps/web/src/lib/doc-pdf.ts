/**
 * A document as a PDF, made in the browser for digital signing: the document is drawn (in its
 * template) inside a hidden frame at A4 width, captured as an image, cut into A4 pages at blank rows,
 * and put into a PDF. With a letterhead, the letterhead is the background of every page and the
 * document fills the space inside its margins.
 */
import { toCanvas } from 'html-to-image';
import { PDFDocument } from 'pdf-lib';

const A4_W = 794; // CSS px at 96 dpi
const A4_H = 1123;
const MM = 3.7795;
const PT = 0.75; // px → pt

export interface PdfLayout {
  letterhead?: string | null;
  margins?: { top: number; bottom: number; left: number; right: number } | null;
}

/** Draws into a hidden same-origin frame with the app's styles, so the document looks as on screen. */
async function frame(): Promise<{ iframe: HTMLIFrameElement; doc: Document; host: HTMLDivElement }> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;left:-12000px;top:0;width:${A4_W}px;height:${A4_H}px;border:0;visibility:hidden`;
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write('<!doctype html><html><head></head><body style="margin:0;background:#fff"></body></html>');
  doc.close();
  for (const el of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(el.cloneNode(true));
  const host = doc.createElement('div');
  host.style.width = `${A4_W}px`;
  doc.body.appendChild(host);
  return { iframe, doc, host };
}

async function settle(doc: Document) {
  await new Promise((r) => setTimeout(r, 120));
  await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
  await Promise.all(Array.from(doc.images).map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
  await new Promise((r) => setTimeout(r, 80));
}

/** The row nearest `y` (searching upward) where the image is blank across, so no line of text is cut. */
function blankRowAbove(ctx: CanvasRenderingContext2D, width: number, y: number, maxBack: number) {
  const data = ctx.getImageData(0, Math.max(0, y - maxBack), width, Math.min(maxBack, y)).data;
  const rows = Math.min(maxBack, y);
  for (let r = rows - 1; r >= 0; r--) {
    let blank = true;
    for (let x = 0; x < width; x += 3) {
      const i = (r * width + x) * 4;
      if (data[i]! < 245 || data[i + 1]! < 245 || data[i + 2]! < 245) {
        blank = false;
        break;
      }
    }
    if (blank) return y - (rows - 1 - r);
  }
  return y;
}

async function embedImage(pdf: PDFDocument, dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]!), (c) => c.charCodeAt(0));
  return dataUrl.startsWith('data:image/png') ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

/**
 * Renders with `draw` (into the frame), captures `selector` (or the whole drawing) and paginates.
 * Returns the PDF bytes.
 */
export async function documentToPdf(draw: (host: HTMLDivElement, doc: Document) => Promise<void> | void, layout: PdfLayout = {}, selector = '.qdoc, .qdoc-html'): Promise<Uint8Array> {
  const { iframe, doc, host } = await frame();
  try {
    await draw(host, doc);
    await settle(doc);
    let target = (host.querySelector(selector) as HTMLElement | null) ?? host;
    const lh = layout.letterhead ?? null;
    const m = layout.margins ?? null;
    if (lh && m) {
      // the letterhead goes on as the page background: draw only the content, at the content width
      target.querySelector('.qdoc-lh')?.remove();
      for (const td of Array.from(target.querySelectorAll('.qdoc-lh-wrap > thead td, .qdoc-lh-wrap > tfoot td'))) (td as HTMLElement).style.height = '0';
      target.style.minHeight = '0';
      target.style.padding = '0';
      target.style.boxShadow = 'none';
      target.style.width = `${A4_W - (m.left + m.right) * MM}px`;
      target.style.maxWidth = 'none';
    } else {
      target.style.boxShadow = 'none';
      target.style.maxWidth = `${A4_W}px`;
      target.style.width = `${A4_W}px`;
    }
    const shadow = target.shadowRoot;
    if (shadow) {
      // HTML templates draw in a shadow root, which the capture doesn't see: copy it into the light DOM
      const copy = doc.createElement('div');
      copy.innerHTML = shadow.innerHTML.replace(':host', '.tpl-host');
      copy.className = 'tpl-host';
      copy.style.cssText = `background:#fff;padding:12mm;width:${A4_W}px;box-sizing:border-box`;
      target.replaceWith(copy);
      target = copy;
      await settle(doc);
    }
    const ratio = 2;
    const canvas = await toCanvas(target, { pixelRatio: ratio, backgroundColor: '#ffffff', width: target.scrollWidth, height: target.scrollHeight, cacheBust: false });
    const ctx = canvas.getContext('2d')!;
    const pdf = await PDFDocument.create();
    const lhImg = lh ? await embedImage(pdf, lh) : null;
    const top = lh && m ? m.top * MM : 14 * MM;
    const bottom = lh && m ? m.bottom * MM : 12 * MM;
    const left = lh && m ? m.left * MM : 0;
    let y = 0;
    let pageNo = 0;
    while (y < canvas.height - 2) {
      // the first page of a design without letterhead starts at the top: its own padding is the margin
      const padTop = lh ? top : pageNo === 0 ? 0 : top;
      const room = Math.floor((A4_H - padTop - bottom) * ratio);
      let cut = Math.min(canvas.height, y + room);
      if (cut < canvas.height) cut = blankRowAbove(ctx, canvas.width, cut, Math.floor(80 * ratio));
      if (cut <= y) cut = Math.min(canvas.height, y + room);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = cut - y;
      slice.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, cut - y, 0, 0, canvas.width, cut - y);
      const page = pdf.addPage([A4_W * PT, A4_H * PT]);
      if (lhImg) page.drawImage(lhImg, { x: 0, y: 0, width: A4_W * PT, height: A4_H * PT });
      const img = await pdf.embedJpg(Uint8Array.from(atob(slice.toDataURL('image/jpeg', 0.92).split(',')[1]!), (c) => c.charCodeAt(0)));
      const w = (canvas.width / ratio) * PT;
      const h = (slice.height / ratio) * PT;
      page.drawImage(img, { x: left * PT, y: A4_H * PT - padTop * PT - h, width: w, height: h });
      y = cut;
      pageNo++;
    }
    pdf.setProducer('SanchalanOS');
    pdf.setCreator('SanchalanOS');
    return pdf.save();
  } finally {
    iframe.remove();
  }
}

export const bytesToB64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function sha256Hex(u: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, '0')).join('');
}
