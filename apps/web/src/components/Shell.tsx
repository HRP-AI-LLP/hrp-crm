import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';
import { useMeta } from '../lib/hooks';
import { Icon } from './ui';

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const loc = useLocation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const { data } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => get<{ results: { object: string; label: string; items: { id: string; title: string }[] }[] }>(`/api/v1/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  return (
    <div className="search" ref={box}>
      <Icon.search />
      <input
        type="search"
        placeholder="Search people, companies, deals…"
        aria-label="Search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && debounced.length >= 2 && data && (
        <div className="search-pop">
          {data.results.length === 0 && <div className="grp">No matches for “{debounced}”</div>}
          {data.results.map((g) => (
            <div key={g.object}>
              <div className="grp">{g.label}</div>
              {g.items.map((i) => (
                <Link key={i.id} to={`/o/${g.object}/${i.id}`}>
                  {i.title || 'Untitled'}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const { me, logout, can } = useAuth();
  const { data: meta } = useMeta();
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);
  const std = ['lead', 'contact', 'account', 'deal'];
  const objects = meta?.objects ?? [];
  const custom = objects.filter((o) => !std.includes(o.key));
  const admin = me && (can('metadata') || can('users') || can('roles') || can('modules') || can('workflows') || can('audit') || can('channels') || can('domains'));

  return (
    <div className="shell">
      <nav className={`nav${navOpen ? ' open' : ''}`} aria-label="Main">
        <div className="brand">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <div>
            <b>HRP Synapse</b>
            <span>{me?.tenant.name}</span>
          </div>
        </div>
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/tasks">My tasks</NavLink>
        <div className="nav-group">
          <div>Sales</div>
          {std
            .map((k) => objects.find((o) => o.key === k))
            .filter(Boolean)
            .map((o) => (
              <NavLink key={o!.key} to={`/o/${o!.key}`}>
                {o!.plural}
              </NavLink>
            ))}
          {objects.some((o) => o.key === 'deal') && <NavLink to="/pipeline/deal">Deal board</NavLink>}
        </div>
        {custom.length > 0 && (
          <div className="nav-group">
            <div>Your objects</div>
            {custom.map((o) => (
              <NavLink key={o.key} to={`/o/${o.key}`}>
                {o.plural}
              </NavLink>
            ))}
          </div>
        )}
        <div className="nav-group">
          <div>Assist</div>
          <NavLink to="/knowledge">Knowledge base</NavLink>
          {admin && <NavLink to="/settings">Settings</NavLink>}
        </div>
        <div className="nav-foot">
          <span className="avatar">{initials(me?.user.fullName ?? '')}</span>
          <div className="grow">
            <div style={{ color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.user.fullName}</div>
            <button className="btn ghost sm" style={{ color: '#8fb6c0', padding: 0, height: 20 }} onClick={() => logout()}>
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost sm mobile-only" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
            <Icon.menu />
          </button>
          <GlobalSearch />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
