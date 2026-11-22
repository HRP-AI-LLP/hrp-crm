/**
 * Documents (markdown with Mermaid figures) → HTML, Word (.docx) and PDF (print), with the figures
 * drawn as pictures.
 */
import DOMPurify from 'dompurify';
import { strToU8, zipSync } from 'fflate';
import { marked, type Token, type Tokens } from 'marked';
import { rasterize, renderMermaid, standaloneSvg } from './diagrams';

const FENCE = /```mermaid[^\n]*\n([\s\S]*?)\n```(?:\s*\n<!-- diagram:([0-9a-f-]{36}) -->)?/g;

/** Mermaid fences become placeholders the viewer fills with the drawn figure. */
export function toViewHtml(md: string) {
  const pre = md.replace(FENCE, (_m, src: string, id?: string) => `\n<div class="mmd-fig" data-src="${encodeURIComponent(src)}"${id ? ` data-id="${id}"` : ''}></div>\n`);
  const html = marked.parse(pre, { gfm: true, breaks: false, async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

export const mermaidBlocks = (md: string) => [...md.matchAll(FENCE)].map((m) => ({ src: m[1]!, id: m[2] ?? null }));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PRINT_CSS = `body{font-family:Inter,"Segoe UI",Arial,sans-serif;color:#1f2937;max-width:820px;margin:32px auto;padding:0 24px;line-height:1.55;font-size:14px}
h1{font-size:26px;border-bottom:2px solid #111827;padding-bottom:6px}h2{font-size:20px;margin-top:28px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}h3{font-size:16px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}
code{background:#f3f4f6;padding:1px 4px;border-radius:4px;font-size:12px}pre{background:#f8fafc;border:1px solid #e5e7eb;padding:10px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{border-left:3px solid #d1d5db;margin:8px 0;padding:2px 12px;color:#4b5563}figure{margin:14px 0;text-align:center;break-inside:avoid}figure svg{max-width:100%;height:auto}
@media print{body{margin:0}h2{break-after:avoid}a{color:inherit}}`;

/** A standalone HTML file (figures as inline SVG). */
export async function toStandaloneHtml(title: string, md: string) {
  const blocks = mermaidBlocks(md);
  const svgs = await Promise.all(blocks.map((b) => renderMermaid(b.src).catch(() => null)));
  let i = 0;
  const pre = md.replace(FENCE, () => {
    const svg = svgs[i++];
    return svg ? `\n<figure>${standaloneSvg(svg).svg.replace(/^<\?xml[^>]*>\s*/, '')}</figure>\n` : '\n<p><em>(diagram)</em></p>\n';
  });
  const body = DOMPurify.sanitize(marked.parse(pre, { gfm: true, async: false }) as string, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

/** Print to PDF: the document in a new window with the print dialog. */
export async function printPdf(title: string, md: string) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to save as PDF');
  w.document.write('<p style="font-family:sans-serif">Preparing…</p>');
  const html = await toStandaloneHtml(title, md);
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

/* ───────────────────────── Word ───────────────────────── */

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type Run = { text: string; b?: boolean; i?: boolean; code?: boolean; strike?: boolean; link?: boolean };

function runs(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs((t as Tokens.Strong).tokens, { ...style, b: true }));
        break;
      case 'em':
        out.push(...runs((t as Tokens.Em).tokens, { ...style, i: true }));
        break;
      case 'del':
        out.push(...runs((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push({ ...style, code: true, text: decode((t as Tokens.Codespan).text) });
        break;
      case 'link':
        out.push(...runs((t as Tokens.Link).tokens, { ...style, link: true }));
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'text':
        if ((t as Tokens.Text).tokens?.length) out.push(...runs((t as Tokens.Text).tokens, style));
        else out.push({ ...style, text: decode((t as Tokens.Text).text) });
        break;
      case 'escape':
        out.push({ ...style, text: (t as Tokens.Escape).text });
        break;
      case 'html':
        break;
      default:
        if ('text' in t) out.push({ ...style, text: decode(String((t as { text: string }).text)) });
    }
  }
  return out;
}
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function runXml(r: Run) {
  const props = [r.b ? '<w:b/>' : '', r.i ? '<w:i/>' : '', r.strike ? '<w:strike/>' : '', r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : '', r.link ? '<w:color w:val="1D4ED8"/><w:u w:val="single"/>' : ''].join('');
  return r.text
    .split('\n')
    .map((part, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(part)}</w:t></w:r>`)
    .join('');
}
const para = (content: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;

interface Img {
  rid: string;
  name: string;
  data: Uint8Array;
  w: number;
  h: number;
}

/** A Word document from the markdown; figures become pictures. */
export async function toDocx(title: string, md: string): Promise<Blob> {
  const blocks = mermaidBlocks(md);
  const images: Img[] = [];
  for (const [i, b] of blocks.entries()) {
    try {
      const svg = await renderMermaid(b.src);
      const { blob, w, h } = await rasterize(svg, 'png', 2);
      images.push({ rid: `rIdImg${i + 1}`, name: `figure${i + 1}.png`, data: new Uint8Array(await blob.arrayBuffer()), w, h });
    } catch {
      images.push({ rid: '', name: '', data: new Uint8Array(), w: 0, h: 0 });
    }
  }
  let n = 0;
  const pre = md.replace(FENCE, () => `\n\n@@FIGURE${n++}@@\n\n`);
  const tokens = marked.lexer(pre, { gfm: true });
  const body: string[] = [];
  let docPr = 1;

  const picture = (img: Img) => {
    const maxW = 6.3 * 914400;
    let cx = img.w * 9525;
    let cy = img.h * 9525;
    if (cx > maxW) {
      cy = Math.round((cy * maxW) / cx);
      cx = maxW;
    }
    const id = docPr++;
    return para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Figure ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${img.name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      '<w:jc w:val="center"/>',
    );
  };

  const walk = (toks: Token[], depth = 0, quote = false) => {
    for (const t of toks) {
      const ind = quote ? '<w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="D1D5DB"/></w:pBdr>' : '';
      switch (t.type) {
        case 'heading': {
          const h = t as Tokens.Heading;
          body.push(para(runs(h.tokens).map(runXml).join(''), `<w:pStyle w:val="Heading${Math.min(h.depth, 4)}"/>`));
          break;
        }
        case 'paragraph': {
          const p = t as Tokens.Paragraph;
          const fig = /^@@FIGURE(\d+)@@$/.exec(p.text.trim());
          if (fig) {
            const img = images[Number(fig[1])];
            if (img?.rid) body.push(picture(img));
            else body.push(para(runXml({ text: '(diagram)', i: true })));
          } else body.push(para(runs(p.tokens).map(runXml).join(''), ind));
          break;
        }
        case 'list': {
          const l = t as Tokens.List;
          l.items.forEach((it, i) => {
            const mark = it.task ? (it.checked ? '☑ ' : '☐ ') : l.ordered ? `${(Number(l.start) || 1) + i}. ` : '• ';
            const inner = it.tokens.filter((k) => k.type !== 'list');
            const text = inner.flatMap((k) => ('tokens' in k && k.tokens ? runs(k.tokens as Token[]) : 'text' in k ? [{ text: decode(String((k as { text: string }).text)) }] : []));
            body.push(para(runXml({ text: mark }) + text.map(runXml).join(''), `<w:ind w:left="${360 + depth * 360}" w:hanging="280"/><w:spacing w:after="40"/>`));
            const sub = it.tokens.filter((k) => k.type === 'list');
            if (sub.length) walk(sub, depth + 1);
          });
          break;
        }
        case 'table': {
          const tb = t as Tokens.Table;
          const cell = (c: Tokens.TableCell, head: boolean) =>
            `<w:tc><w:tcPr>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ''}</w:tcPr>${para(runs(c.tokens, head ? { b: true } : {}).map(runXml).join(''), '<w:spacing w:after="0"/>')}</w:tc>`;
          body.push(
            `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
              `<w:tr><w:trPr><w:tblHeader/></w:trPr>${tb.header.map((c) => cell(c, true)).join('')}</w:tr>` +
              tb.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`).join('') +
              '</w:tbl>',
          );
          body.push(para(''));
          break;
        }
        case 'code': {
          const c = t as Tokens.Code;
          for (const line of c.text.split('\n')) body.push(para(runXml({ text: line || ' ', code: true }), '<w:pStyle w:val="Code"/>'));
          break;
        }
        case 'blockquote':
          walk((t as Tokens.Blockquote).tokens, depth, true);
          break;
        case 'hr':
          body.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr>'));
          break;
        default:
          break;
      }
    }
  };
  walk(tokens);

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const hs = (lvl: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${lvl}"><w:name w:val="heading ${lvl}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${lvl === 1 ? 0 : 280}" w:after="120"/><w:outlineLvl w:val="${lvl - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${lvl === 1 ? '111827' : '1F2937'}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${hs(1, 36)}${hs(2, 30)}${hs(3, 26)}${hs(4, 23)}<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`;
  const used = images.filter((i) => i.rid);
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${used.map((i) => `<Relationship Id="${i.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${i.name}"/>`).join('')}</Relationships>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    'docProps/core.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>SanchalanOS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
    ),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
    'word/_rels/document.xml.rels': strToU8(rels),
  };
  for (const i of used) files[`word/media/${i.name}`] = i.data;
  return new Blob([zipSync(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
