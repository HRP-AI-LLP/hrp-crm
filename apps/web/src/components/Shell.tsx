import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials, relative } from '../lib/format';
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

interface Note {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/** Bell with unread count; polls every minute while the tab is visible. */
function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<{ items: Note[]; unread: number }>('/api/v1/notifications'),
    refetchInterval: () => (document.visibilityState === 'visible' ? 60_000 : false),
    staleTime: 30_000,
  });
  const markRead = async (ids?: string[]) => {
    await post('/api/v1/notifications/read', ids ? { ids } : {}).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const unread = data?.unread ?? 0;
  return (
    <div className="notif">
      <button className="btn ghost sm notif-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="notif-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-pop" role="dialog" aria-label="Notifications">
          <div className="spread notif-head">
            <b>Notifications</b>
            {unread > 0 && (
              <button className="link" onClick={() => markRead()}>
                Mark all read
              </button>
            )}
          </div>
          {!data?.items.length && <p className="muted small" style={{ padding: 12 }}>You are all caught up.</p>}
          {data?.items.map((n) => (
            <button
              key={n.id}
              className={`notif-item${n.read_at ? '' : ' unread'}`}
              onClick={() => {
                setOpen(false);
                if (!n.read_at) void markRead([n.id]);
                if (n.link) nav(n.link);
              }}
            >
              <b>{n.title}</b>
              {n.body && <span>{n.body}</span>}
              <small>{relative(n.created_at)}</small>
            </button>
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
  const std = ['lead', 'contact', 'account', 'deal', 'quote', 'product'];
  const objects = meta?.objects ?? [];
  const custom = objects.filter((o) => !std.includes(o.key));
  const admin = me && (can('metadata') || can('users') || can('roles') || can('modules') || can('workflows') || can('audit') || can('channels') || can('domains'));

  return (
    <div className="shell">
      <nav className={`nav${navOpen ? ' open' : ''}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark"><img src="/logo-mark.png" alt="HRP AI" /></span>
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
        <div className="nav-group">
          <div>Plan</div>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/forecast">Forecast</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/dashboards">Dashboards</NavLink>
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
            <Link to="/account" style={{ color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', whiteSpace: 'nowrap' }} title="My account and security">
              {me?.user.fullName}
            </Link>
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
          <Notifications />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
