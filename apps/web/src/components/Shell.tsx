import { areaOfObject, BRAND, canUseArea, hasAdmin, objectPerm } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { setPdfContext } from '../lib/table-pdf';
import { startTablePdfButtons } from '../lib/table-pdf-buttons';
import { initials, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';
import { Icon, Spinner } from './ui';
import { useApprovalCount } from './Approvals';
import { useOnline } from '../lib/outbox';
import { CommandPalette, type Command, useCommandPaletteShortcut } from './CommandPalette';
import { NI, OBJECT_ICON } from './NavIcons';
import { useTheme } from '../lib/theme';
import { NavTrail } from './NavTrail';
import { AssistantLauncher } from './assistant/Assistant';

/** Which work area each screen belongs to (screens not listed are for everyone). */
const NAV_AREAS: [string, string][] = [
  ['/copilot', 'crm'], ['/sales-ops', 'sales'], ['/forecast', 'crm'], ['/field', 'operations'], ['/inventory', 'operations'], ['/schedule', 'operations'],
  ['/after-sales', 'service'], ['/billing', 'billing'], ['/books', 'books'], ['/reconcile', 'billing'], ['/ca', 'gst'], ['/manufacturing', 'manufacturing'],
  ['/projects', 'projects'], ['/work', 'projects'], ['/sdlc', 'projects'], ['/timesheet', 'projects'], ['/calls', 'calls'], ['/it', 'it'],
  ['/inbox', 'inbox'], ['/campaigns', 'marketing'], ['/intake', 'intake'], ['/health', 'insights'], ['/reports', 'insights'], ['/dashboards', 'insights'],
  ['/knowledge', 'knowledge'],
];

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
  // every data table gets an "Export PDF" button; reports say who made them, for which company
  useEffect(() => {
    if (me) setPdfContext({ user: me.user.fullName, workspace: me.tenant.name });
    startTablePdfButtons();
  }, [me]);
  const { data: meta } = useMeta();
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);
  const std = ['lead', 'contact', 'account', 'deal', 'quote', 'product'];
  const opsKeys = ['sales_order', 'purchase_order', 'vendor', 'shipment', 'installation', 'ticket', 'invoice', 'payment', 'bill', 'vendor_payment', 'expense'];
  const objects = meta?.objects ?? [];
  const custom = objects.filter((o) => !std.includes(o.key) && !opsKeys.includes(o.key) && !o.moduleKey?.startsWith('app.'));
  const apps = new Set((meta?.modules ?? []).filter((m) => m.enabled && m.key.startsWith('app.')).map((m) => m.key.slice(4)));
  const opsObjects = opsKeys.map((k) => objects.find((o) => o.key === k)).filter((o): o is NonNullable<typeof o> => !!o);
  // the business's CA sees their portal and nothing of the CRM
  const caOnly = !!me && hasAdmin(me.permissions, 'compliance') && !hasAdmin(me.permissions, 'books') && !me.user.isOwner;
  const navTo = useNavigate();
  useEffect(() => {
    if (caOnly && loc.pathname === '/') navTo('/ca', { replace: true });
  }, [caOnly, loc.pathname]);
  const approvals = useApprovalCount(!!me && !caOnly);
  const inbox = useQuery({ queryKey: ['inbox-badge'], queryFn: () => get<{ counts: { unread: number } }>('/api/v1/inbox?view=mine&status=open'), enabled: !!me && !caOnly, refetchInterval: 60_000, staleTime: 30_000 });
  const copilot = useQuery({ queryKey: ['copilot'], queryFn: () => get<{ insights: unknown[] }>('/api/v1/intel/copilot'), enabled: !!me && !caOnly, refetchInterval: 300_000, staleTime: 120_000 });
  const online = useOnline();
  // people an admin named to manage the organisation profile reach it without the rest of Settings
  const orgQ = useQuery({ queryKey: ['organisation'], queryFn: () => get<Record<string, any>>('/api/v1/organisation'), enabled: !!me, staleTime: 300_000, retry: false });
  const orgManager = !!orgQ.data?.canManage;
  const [palette, setPalette] = useState(false);
  // the main menu folds to icons (remembered)
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem('synapse.nav.rail') === '1';
    } catch {
      return false;
    }
  });
  const toggleRail = () =>
    setRail((r) => {
      try {
        localStorage.setItem('synapse.nav.rail', r ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !r;
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') window.history.back();
      if (e.altKey && e.key === 'ArrowRight') window.history.forward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openPalette = useCallback(() => setPalette(true), []);
  useCommandPaletteShortcut(openPalette);
  const [theme, setTheme] = useTheme();
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('synapse.nav.closed') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGroup = (k: string) =>
    setClosed((c) => {
      const n = new Set(c);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      try {
        localStorage.setItem('synapse.nav.closed', JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  const areas = me?.permissions.apps;
  const mayOpen = (to: string) => {
    const path = to.split(/[?#]/)[0]!;
    const obj = /^\/o\/([a-z0-9_]+)/.exec(path)?.[1] ?? /^\/pipeline\/([a-z0-9_]+)/.exec(path)?.[1];
    if (obj) return !!me && objectPerm(me.permissions, obj).read !== 'none' && canUseArea(areas, areaOfObject(obj));
    const area = NAV_AREAS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1];
    return !area || canUseArea(areas, area);
  };
  const admin = me && (can('organisation') || can('metadata') || can('users') || can('roles') || can('modules') || can('workflows') || can('audit') || can('channels') || can('domains') || can('privacy') || can('developers') || can('ai'));

  // the sidebar, as data: drawn below and offered in the command palette
  type Item = { to: string; label: string; icon: string; badge?: number | null; end?: boolean };
  const groups: { key: string; label: string | null; items: Item[] }[] = [
    {
      key: 'top',
      label: null,
      items: [
        { to: '/', label: 'Home', icon: 'home', end: true },
        { to: '/assistant', label: 'Assistant', icon: 'spark' },
        { to: '/copilot', label: 'Copilot', icon: 'spark', badge: copilot.data?.insights?.length || null },
        { to: '/field', label: 'My day', icon: 'sun' },
        { to: '/tasks', label: 'My tasks', icon: 'check' },
      ],
    },
    {
      key: 'sales',
      label: 'Sales',
      items: [
        ...std.map((k) => objects.find((o) => o.key === k)).filter(Boolean).map((o) => ({ to: `/o/${o!.key}`, label: o!.plural, icon: OBJECT_ICON[o!.key] ?? 'file' })),
        ...(objects.some((o) => o.key === 'deal') ? [{ to: '/pipeline/deal', label: 'Deal board', icon: 'board' }] : []),
        { to: '/sales-ops', label: 'Sales operations', icon: 'trend' },
      ],
    },
    {
      key: 'ops',
      label: 'Operations',
      items: [
        ...opsObjects.map((o) => ({ to: `/o/${o.key}`, label: o.plural, icon: OBJECT_ICON[o.key] ?? 'file' })),
        ...(apps.has('inventory') ? [{ to: '/inventory', label: 'Inventory', icon: 'box' }] : []),
        ...(apps.has('delivery') ? [{ to: '/schedule', label: 'Field schedule', icon: 'calendar' }] : []),
        ...(apps.has('service') ? [{ to: '/after-sales', label: 'After-sales', icon: 'wrench' }] : []),
        ...(apps.has('billing') ? [{ to: '/billing', label: 'Billing & GST', icon: 'stamp' }] : []),
        ...(apps.has('books') && me && hasAdmin(me.permissions, 'books') ? [{ to: '/books', label: 'Books', icon: 'book' }] : []),
        ...(apps.has('billing') || apps.has('books') ? [{ to: '/reconcile', label: 'Match & reconcile', icon: 'repeat' }] : []),
      ],
    },
    ...(apps.has('manufacturing')
      ? [{ key: 'mfg', label: 'Manufacturing', items: [{ to: '/manufacturing', label: 'Production', icon: 'factory' }, { to: '/o/work_order', label: 'Work orders', icon: 'factory' }, { to: '/o/job_work', label: 'Job work', icon: 'wrench' }] }]
      : []),
    ...(apps.has('projects')
      ? [
          {
            key: 'projects',
            label: 'Projects',
            items: [
              { to: '/projects', label: 'Projects', icon: 'folder' },
              { to: '/work', label: 'Work items', icon: 'search', end: true },
              { to: '/work/roadmap', label: 'Roadmap', icon: 'layers' },
              { to: '/sdlc', label: 'AI delivery', icon: 'spark' },
              { to: '/calls', label: 'Calls', icon: 'video' },
              { to: '/timesheet', label: 'Timesheet', icon: 'clock' },
              { to: '/it/subscriptions', label: 'Subscriptions', icon: 'repeat' },
              { to: '/it/contracts', label: 'Contracts', icon: 'contract' },
              { to: '/it/products', label: 'Products & roadmap', icon: 'layers' },
              { to: '/it/capacity', label: 'Capacity', icon: 'gauge' },
              { to: '/it/assets', label: 'Client IT', icon: 'box' },
            ],
          },
        ]
      : []),
    {
      key: 'engage',
      label: 'Engage',
      items: [
        { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: inbox.data?.counts?.unread || null },
        ...(can('campaigns') ? [{ to: '/campaigns', label: 'Campaigns', icon: 'megaphone' }] : []),
        { to: '/intake/gem', label: 'GeM bids', icon: 'gavel' },
        { to: '/intake/documents', label: 'Bills from mail', icon: 'mail' },
      ],
    },
    {
      key: 'plan',
      label: 'Plan',
      items: [
        { to: '/health', label: 'Business health', icon: 'heart' },
        ...(apps.has('books') && me && hasAdmin(me.permissions, 'books') ? [{ to: '/books#compliance', label: 'Compliance', icon: 'stamp' }] : []),
        { to: '/calendar', label: 'Calendar', icon: 'calendar' },
        { to: '/forecast', label: 'Forecast', icon: 'trend' },
        { to: '/reports', label: 'Reports', icon: 'chart' },
        { to: '/dashboards', label: 'Dashboards', icon: 'grid' },
        { to: '/approvals', label: 'Approvals', icon: 'stamp', badge: approvals.data?.pending || null },
      ],
    },
    ...(custom.length ? [{ key: 'custom', label: 'Your objects', items: custom.map((o) => ({ to: `/o/${o.key}`, label: o.plural, icon: 'grid' })) }] : []),
    {
      key: 'assist',
      label: 'Assist',
      items: [
        { to: '/knowledge', label: 'Knowledge base', icon: 'bulb' },
        ...(can('developers') || can('channels') || can('users') ? [{ to: '/developers', label: 'Developers', icon: 'code' }] : []),
        ...(admin || orgManager ? [{ to: '/organisation', label: 'Organisation', icon: 'org' }] : []),
        ...(admin ? [{ to: '/settings', label: 'Settings', icon: 'gear' }] : []),
      ],
    },
  ]
    // only the work areas the person's role includes (Settings → Roles), and objects they can read
    .map((g) => ({ ...g, items: g.items.filter((i) => mayOpen(i.to)) }))
    .filter((g) => g.items.length);
  if (caOnly)
    groups.splice(0, groups.length,
      { key: 'top', label: null, items: [{ to: '/ca', label: 'Filings', icon: 'stamp', end: false } as Item] },
      {
        key: 'ca',
        label: 'Records',
        items: [
          { to: '/o/invoice', label: 'Invoices', icon: 'file' },
          { to: '/o/payment', label: 'Receipts', icon: 'rupee' },
          { to: '/o/bill', label: 'Bills', icon: 'receipt' },
          { to: '/o/vendor_payment', label: 'Vendor payments', icon: 'wallet' },
          { to: '/o/expense', label: 'Expenses', icon: 'card' },
        ],
      },
    );
  const commands: Command[] = [
    ...groups.flatMap((g) => g.items.map((i) => ({ id: `go:${i.to}`, label: i.label, group: 'Go to' as const, icon: i.icon, to: i.to, hint: g.label ?? undefined }))),
    ...objects
      .filter((o) => !caOnly && [...std, ...opsKeys].includes(o.key))
      .map((o) => ({ id: `new:${o.key}`, label: `New ${o.label.toLowerCase()}`, group: 'Create' as const, icon: 'plus', to: `/o/${o.key}?new=1`, keywords: `add create ${o.label}` })),
    { id: 'act:theme', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', group: 'Actions', icon: theme === 'dark' ? 'sun' : 'moon', run: () => setTheme(theme === 'dark' ? 'light' : 'dark'), keywords: 'dark mode night appearance' },
    { id: 'act:account', label: 'My account and security', group: 'Actions', icon: 'user', to: '/account' },
    { id: 'act:out', label: 'Sign out', group: 'Actions', icon: 'arrow', run: () => logout() },
  ];

  return (
    <div className={`shell${rail ? ' rail' : ''}`}>
      <nav className={`nav${navOpen ? ' open' : ''}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark"><img src="/logo-mark.png" alt="HRP AI" /></span>
          <div>
            <b>{BRAND.name}</b>
            <span>{me?.tenant.name}</span>
          </div>
        </div>
        <button className="nav-quick" onClick={() => setPalette(true)}>
          <NI name="search" size={15} className="" /> <span>Jump to…</span> <kbd>Ctrl K</kbd>
        </button>
        {groups.map((g) => (
          <div key={g.key} className={`nav-group${g.label && closed.has(g.key) ? ' closed' : ''}`} style={g.label ? undefined : { marginTop: 0 }}>
            {g.label && (
              <button className="ng-head" onClick={() => toggleGroup(g.key)} aria-expanded={!closed.has(g.key)}>
                {g.label}
                <NI name="chev" size={13} className="" />
              </button>
            )}
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} title={rail ? i.label : undefined}>
                <NI name={i.icon} />
                <span className="nl">{i.label}</span>
                {i.badge ? <span className="nav-badge">{i.badge}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
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
          <button className="icon-btn desktop-only" onClick={toggleRail} title={rail ? 'Show the menu' : 'Collapse the menu'} aria-label="Menu" aria-expanded={!rail}>
            <NI name="menu" size={18} className="" />
          </button>
          <NavTrail />
          <GlobalSearch />
          <span className={`offline-pill${online ? '' : ' on'}`} role="status">
            {online ? '' : 'Offline'}
          </span>
          <button className="icon-btn push" title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <NI name={theme === 'dark' ? 'sun' : 'moon'} size={18} className="" />
          </button>
          <Notifications />
        </header>
        {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
        <main className="content">
          <Suspense fallback={<Spinner />}>
            {me && !mayOpen(loc.pathname) ? (
              <div className="panel panel-body" style={{ maxWidth: 560 }}>
                <h2 style={{ marginTop: 0 }}>Not part of your role</h2>
                <p className="muted">This part of SanchalanOS is not included in your role. If you need it, ask an administrator to add it in Settings → Roles.</p>
                <Link className="btn" to="/">
                  Go home
                </Link>
              </div>
            ) : (
              <Outlet />
            )}
          </Suspense>
        </main>
        <TabBar onMenu={() => setNavOpen(true)} />
        {!caOnly && <AssistantLauncher />}
      </div>
    </div>
  );
}
