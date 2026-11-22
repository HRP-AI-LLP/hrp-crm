import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Bold (**x**), `code` and links ([text](https://…) or [text](/a/page/in/the/app)) inside one line; everything else is plain text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|\/(?!\/)[^)\s]*)\)|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<b key={i++}>{m[1]}</b>);
    else if (m[4]) out.push(<code key={i++}>{m[4]}</code>);
    else if (m[3]!.startsWith('/'))
      out.push(
        <Link key={i++} to={m[3]!}>
          {m[2]}
        </Link>,
      );
    else
      out.push(
        <a key={i++} href={m[3]} target="_blank" rel="noopener noreferrer">
          {m[2]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);
const numeric = (v: string) => /^[-+]?[₹$€£]?\s?[-+]?[\d,]+(\.\d+)?%?$|^[-+]?[\d,]+(\.\d+)?\s?(INR|USD|EUR)$/i.test(v.replace(/\*\*/g, '').trim());

/** A small, safe Markdown subset for notices, help text and the assistant: headings, lists (bulleted and numbered), tables, paragraphs. No HTML. */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r/g, '').split('\n');
  let list: string[] = [];
  let ordered = false;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    if (list.length) {
      const items = list.map((l, i) => <li key={i}>{inline(l)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    para = [];
    list = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trimEnd();
    // a table: a | row, then a |---| row
    if (/^\s*\|.*\|/.test(line) && n + 1 < lines.length && isRule(lines[n + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      n += 2;
      while (n < lines.length && /^\s*\|/.test(lines[n]!)) rows.push(cells(lines[n++]!));
      n--;
      const right = head.map((_, i) => rows.length > 0 && rows.every((r) => !r[i] || numeric(r[i]!)));
      blocks.push(
        <div className="md-table" key={blocks.length}>
          <table>
            <thead>
              <tr>
                {head.map((h, i) => (
                  <th key={i} style={right[i] ? { textAlign: 'right' } : undefined}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {head.map((_, i) => (
                    <td key={i} style={right[i] ? { textAlign: 'right', whiteSpace: 'nowrap' } : undefined}>
                      {inline(r[i] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+/.test(line);
    const num = /^\s*\d+[.)]\s+/.test(line);
    if (h) {
      flush();
      const Tag = (`h${Math.min(4, h[1]!.length + 1)}` as 'h2' | 'h3' | 'h4');
      blocks.push(<Tag key={blocks.length}>{inline(h[2]!)}</Tag>);
    } else if (bullet || num) {
      if (para.length) {
        const p = para;
        para = [];
        blocks.push(<p key={blocks.length}>{inline(p.join(' '))}</p>);
      }
      if (list.length && ordered !== num) flush();
      ordered = num;
      list.push(line.replace(/^\s*([-*]|\d+[.)])\s+/, ''));
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
