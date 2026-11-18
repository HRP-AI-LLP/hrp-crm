/**
 * Where you have been: Back and Forward buttons (the browser's own history, so every screen and every
 * section you opened is a step), and a trail of the last pages you visited — click any to jump back.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { NI } from './NavIcons';

interface Crumb {
  path: string;
  title: string;
}
const KEY = 'synapse.trail';
const MAX = 8;

const read = (): Crumb[] => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Crumb[];
  } catch {
    return [];
  }
};
const write = (t: Crumb[]) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t.slice(-MAX)));
  } catch {
    /* ignore */
  }
};

/** A readable name for the page: its heading, else the address. */
function titleOf(path: string) {
  const h = document.querySelector('.content h1')?.textContent?.trim();
  if (h) return h.slice(0, 48);
  const seg = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]!.replace(/[-_]/g, ' ') : 'Home';
}

export function NavTrail() {
  const loc = useLocation();
  const nav = useNavigate();
  const type = useNavigationType();
  const [trail, setTrail] = useState<Crumb[]>(read);
  const [depth, setDepth] = useState(() => Number(sessionStorage.getItem('synapse.depth') ?? '0'));
  const path = `${loc.pathname}${loc.search}${loc.hash}`;
  useEffect(() => {
    // count how far into this tab's history we are, so Back is disabled at the start
    const d = type === 'PUSH' ? depth + 1 : type === 'POP' ? Math.max(0, (window.history.state?.idx as number | undefined) ?? depth) : depth;
    setDepth(d);
    try {
      sessionStorage.setItem('synapse.depth', String(d));
    } catch {
      /* ignore */
    }
    // the title appears once the page has rendered
    const t = setTimeout(() => {
      const crumb = { path, title: titleOf(loc.pathname) };
      setTrail((cur) => {
        const base = cur.filter((c) => c.path !== crumb.path && c.title !== crumb.title);
        const next = [...base, crumb].slice(-MAX);
        write(next);
        return next;
      });
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const idx = (window.history.state?.idx as number | undefined) ?? depth;
  const prev = trail.slice(0, -1);
  return (
    <div className="trail" aria-label="Where you have been">
      <button className="icon-btn" onClick={() => nav(-1)} disabled={idx <= 0} title="Back (Alt + ←)" aria-label="Back">
        <NI name="arrow" size={17} className="flip" />
      </button>
      <button className="icon-btn" onClick={() => nav(1)} title="Forward (Alt + →)" aria-label="Forward">
        <NI name="arrow" size={17} className="" />
      </button>
      {prev.length > 0 && (
        <nav className="trail-crumbs">
          {prev.slice(-5).map((c) => (
            <button key={c.path} onClick={() => nav(c.path)} title={c.path}>
              {c.title}
            </button>
          ))}
          <span className="here">{trail[trail.length - 1]?.title}</span>
        </nav>
      )}
    </div>
  );
}
