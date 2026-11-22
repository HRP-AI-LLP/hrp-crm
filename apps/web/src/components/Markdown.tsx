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

/** A small, safe Markdown subset for notices and help text: headings, lists, paragraphs. No HTML. */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r/g, '').split('\n');
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    if (list.length)
      blocks.push(
        <ul key={blocks.length}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
    para = [];
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const Tag = (`h${Math.min(4, h[1]!.length + 1)}` as 'h2' | 'h3' | 'h4');
      blocks.push(<Tag key={blocks.length}>{inline(h[2]!)}</Tag>);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) {
        const p = para;
        para = [];
        blocks.push(<p key={blocks.length}>{inline(p.join(' '))}</p>);
      }
      list.push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
