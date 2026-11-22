/**
 * Diagrams in the browser: Mermaid → SVG, SVG → PNG / JPG, draw.io files and the "Open in draw.io"
 * link. Mermaid is loaded only when a diagram is shown.
 */
import { drawioWithImage } from '@synapse/shared/diagrams';
import { deflateSync, strToU8 } from 'fflate';

type MermaidApi = typeof import('mermaid').default;
let loading: Promise<MermaidApi> | null = null;
let seq = 0;

function mermaid(): Promise<MermaidApi> {
  if (!loading)
    loading = import('mermaid').then((m) => {
      const api = m.default;
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'default',
        // plain SVG text (no HTML inside the SVG), so pictures convert to PNG / JPG
        htmlLabels: false,
        flowchart: { htmlLabels: false, curve: 'basis', padding: 12 },
        sequence: { useMaxWidth: false },
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
      });
      return api;
    });
  return loading;
}

/** Mermaid source → SVG markup. Throws with Mermaid's message when the source is wrong. */
export async function renderMermaid(src: string): Promise<string> {
  const api = await mermaid();
  const id = `mmd-${Date.now().toString(36)}-${seq++}`;
  try {
    await api.parse(src);
    const { svg } = await api.render(id, src);
    return svg;
  } finally {
    // Mermaid leaves its scratch element behind when rendering fails
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

function sizeOf(svg: string) {
  const vb = /viewBox="([\d.\-e]+)[ ,]+([\d.\-e]+)[ ,]+([\d.e]+)[ ,]+([\d.e]+)"/.exec(svg);
  const w = vb ? Number(vb[3]) : Number(/width="([\d.]+)/.exec(svg)?.[1] ?? 800);
  const h = vb ? Number(vb[4]) : Number(/height="([\d.]+)/.exec(svg)?.[1] ?? 600);
  return { w: Math.max(1, Math.ceil(w)), h: Math.max(1, Math.ceil(h)) };
}

/** The SVG with fixed pixel size (Mermaid emits width="100%"), standalone. */
export function standaloneSvg(svg: string) {
  const { w, h } = sizeOf(svg);
  let out = svg.replace(/<svg([^>]*?)\swidth="[^"]*"/, '<svg$1').replace(/<svg([^>]*?)\sheight="[^"]*"/, '<svg$1');
  out = out.replace(/<svg/, `<svg width="${w}" height="${h}"`).replace(/max-width:\s*[\d.]+px;?/, '');
  if (!/xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(out)) out = out.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${out}`, w, h };
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${b64(standaloneSvg(svg).svg)}`;

/** SVG → PNG or JPG (white background), at `scale` × its size. */
export async function rasterize(svg: string, type: 'png' | 'jpeg', scale = 2): Promise<{ blob: Blob; w: number; h: number }> {
  const { w, h } = standaloneSvg(svg);
  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((ok, fail) => {
    img.onload = () => ok();
    img.onerror = () => fail(new Error('Could not draw the picture'));
    img.src = svgDataUrl(svg);
  });
  const k = Math.min(scale, 16000 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, type === 'png' ? 'image/png' : 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not make the picture');
  return { blob, w, h };
}

/** A draw.io file holding the picture, for diagrams without editable shapes. */
export function drawioFromSvg(title: string, svg: string) {
  const { w, h } = standaloneSvg(svg);
  return drawioWithImage(title, svgDataUrl(svg), w, h);
}

/** Opens the diagram in diagrams.net, editable (nothing is uploaded: it travels in the link). */
export function drawioLink(xml: string) {
  const packed = deflateSync(strToU8(encodeURIComponent(xml)), { level: 9 });
  let bin = '';
  for (let i = 0; i < packed.length; i += 0x8000) bin += String.fromCharCode(...packed.subarray(i, i + 0x8000));
  return `https://app.diagrams.net/?title=diagram.drawio#R${encodeURIComponent(btoa(bin))}`;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const saveText = (text: string, name: string, type = 'text/plain') => saveBlob(new Blob([text], { type: `${type};charset=utf-8` }), name);
export const fileName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'diagram';
