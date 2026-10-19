import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';
import { Icon, Spinner } from './ui';
import { useApprovalCount } from './Approvals';
import { useOnline } from '../lib/outbox';

const svg = (d: string) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Phone navigation: the five places people on the move need, thumb-reachable. */
function TabBar({ onMenu }: { onMenu: () => void }) {
  return (
    <nav className="tabbar" aria-label="Quick">
      <NavLink to="/field">
        {svg('M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z')}
        My day
      </NavLink>
      <NavLink to="/o/lead">
        {svg('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6')}
        Leads
      </NavLink>
      <NavLink to="/tasks">
        {svg('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9')}
        Tasks
      </NavLink>
      <NavLink to="/calendar">
        {svg('M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z')}
        Calendar
      </NavLink>
      <button type="button" onClick={onMenu}>
        {svg('M4 6h16M4 12h16M4 18h16')}
        More
      </button>
    </nav>
  );
}

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
  const opsKeys = ['sales_order', 'purchase_order', 'vendor', 'shipment', 'installation', 'ticket', 'invoice', 'payment'];
  const objects = meta?.objects ?? [];
  const custom = objects.filter((o) => !std.includes(o.key) && !opsKeys.includes(o.key) && !o.moduleKey?.startsWith('app.'));
  const apps = new Set((meta?.modules ?? []).filter((m) => m.enabled && m.key.startsWith('app.')).map((m) => m.key.slice(4)));
  const opsObjects = opsKeys.map((k) => objects.find((o) => o.key === k)).filter((o): o is NonNullable<typeof o> => !!o);
  const approvals = useApprovalCount(!!me);
  const inbox = useQuery({ queryKey: ['inbox-badge'], queryFn: () => get<{ counts: { unread: number } }>('/api/v1/inbox?view=mine&status=open'), enabled: !!me, refetchInterval: 60_000, staleTime: 30_000 });
  const online = useOnline();
  const admin = me && (can('metadata') || can('users') || can('roles') || can('modules') || can('workflows') || can('audit') || can('channels') || can('domains') || can('privacy') || can('developers') || can('ai'));

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
        <NavLink to="/field">My day</NavLink>
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
        {(opsObjects.length > 0 || apps.has('inventory')) && (
          <div className="nav-group">
            <div>Operations</div>
            {opsObjects.map((o) => (
              <NavLink key={o.key} to={`/o/${o.key}`}>
                {o.plural}
              </NavLink>
            ))}
            {apps.has('inventory') && <NavLink to="/inventory">Inventory</NavLink>}
            {apps.has('delivery') && <NavLink to="/schedule">Field schedule</NavLink>}
            {apps.has('billing') && <NavLink to="/billing">Billing &amp; GST</NavLink>}
          </div>
        )}
        <div className="nav-group">
          <div>Engage</div>
          <NavLink to="/inbox">
            Inbox{inbox.data?.counts?.unread ? <span className="nav-badge">{inbox.data.counts.unread}</span> : null}
          </NavLink>
          {can('campaigns') && <NavLink to="/campaigns">Campaigns</NavLink>}
        </div>
        <div className="nav-group">
          <div>Plan</div>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/forecast">Forecast</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/dashboards">Dashboards</NavLink>
          <NavLink to="/approvals">
            Approvals{approvals.data?.pending ? <span className="nav-badge">{approvals.data.pending}</span> : null}
          </NavLink>
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
          <span className={`offline-pill${online ? '' : ' on'}`} role="status">
            {online ? '' : 'Offline'}
          </span>
          <Notifications />
        </header>
        <main className="content">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </main>
        <TabBar onMenu={() => setNavOpen(true)} />
      </div>
    </div>
  );
}
