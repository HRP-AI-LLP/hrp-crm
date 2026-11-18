/**
 * Home, "today": a header with the day's numbers, then what needs attention — tasks and meetings,
 * deals going quiet, GeM bids closing, money to chase and pay, and work waiting in the accounts desk.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { money2 } from '../lib/format';
import { inrShort } from './books/BooksDashboard';
import { NI } from './NavIcons';

type Json = Record<string, any>;

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const left = (iso: string) => {
  const h = Math.round((Date.parse(iso) - Date.now()) / 3_600_000);
  return h < 24 ? `${Math.max(h, 0)}h left` : `${Math.round(h / 24)}d left`;
};
const relLink = (o: string | null, id: string | null) => (o && id ? `/o/${o}/${id}` : null);

function Box({ title, icon, action, children, empty }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode; empty?: string | false }) {
  return (
    <section className="panel" style={{ minWidth: 0 }}>
      <div className="panel-head">
        <h2 className="row" style={{ gap: 8 }}>
          <span style={{ color: 'var(--brand-600)', display: 'inline-flex' }}>
            <NI name={icon} size={17} className="" />
          </span>
          {title}
        </h2>
        {action}
      </div>
      <div style={{ padding: '4px 18px 10px' }}>{empty ? <p className="muted small" style={{ margin: '14px 0' }}>{empty}</p> : children}</div>
    </section>
  );
}

export function TodayHero({ name }: { name: string }) {
  const { data } = useQuery({ queryKey: ['home', 'today'], queryFn: () => get<Json>('/api/v1/home/today'), staleTime: 60_000 });
  const hour = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const tasks = (data?.tasks ?? []) as Json[];
  const overdueAmt = ((data?.overdue ?? []) as Json[]).reduce((t, x) => t + Number(x.balance ?? 0), 0);
  const date = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  return (
    <div className="hero">
      <div>
        <h1>
          {greet}, {name}
        </h1>
        <p>{date} · here is what needs you today.</p>
      </div>
      <div className="stats">
        <div>
          <b>{tasks.length}</b>
          <span>tasks due{tasks.some((t) => t.overdue) ? ` · ${tasks.filter((t) => t.overdue).length} late` : ''}</span>
        </div>
        <div>
          <b>{(data?.events ?? []).length}</b>
          <span>meetings today</span>
        </div>
        {data?.bids && (
          <div>
            <b>{data.bids.length}</b>
            <span>GeM bids closing this week</span>
          </div>
        )}
        {data?.overdue && (
          <div>
            <b>{inrShort(overdueAmt)}</b>
            <span>overdue to collect</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TodayPanels() {
  const { data } = useQuery({ queryKey: ['home', 'today'], queryFn: () => get<Json>('/api/v1/home/today'), staleTime: 60_000 });
  if (!data) return null;
  const tasks = (data.tasks ?? []) as Json[];
  const events = (data.events ?? []) as Json[];
  const deals = data.deals as Json[] | undefined;
  const bids = data.bids as Json[] | undefined;
  const overdue = data.overdue as Json[] | undefined;
  const bills = data.billsDue as Json[] | undefined;
  const desk = data.desk as Json | undefined;
  const deskItems = desk
    ? ([
        [desk.bank_lines, 'bank lines to match', '/books#banking'],
        [desk.proposals, 'bookkeeper suggestions to review', '/books#desk'],
        [desk.imports, 'imported invoices to approve', '/books#desk'],
        [desk.mail, 'bills and statements from mail', '/intake/documents'],
      ].filter(([n]) => Number(n) > 0) as [number, string, string][])
    : [];
  return (
    <div className="home-grid">
      <Box
        title="Today"
        icon="check"
        action={
          <Link to="/tasks" className="small">
            All tasks →
          </Link>
        }
        empty={!tasks.length && !events.length && 'Nothing due today. A good day to call a customer.'}
      >
        {events.map((e) => (
          <div className="attn" key={e.id}>
            <span className="pill info">{time(e.starts_at)}</span>
            <div className="t">
              {relLink(e.related_object, e.related_id) ? <Link to={relLink(e.related_object, e.related_id)!}>{e.title}</Link> : <b style={{ fontWeight: 500 }}>{e.title}</b>}
              <div className="meta">
                {e.kind}
                {e.location ? ` · ${e.location}` : ''}
              </div>
            </div>
          </div>
        ))}
        {tasks.map((t) => (
          <div className="attn" key={t.id}>
            <span className={`pill ${t.overdue ? 'bad' : 'warn'}`}>{t.overdue ? 'late' : 'today'}</span>
            <div className="t">
              <Link to={relLink(t.related_object, t.related_id) ?? '/tasks'}>{t.title}</Link>
              <div className="meta">{t.due ? `due ${t.due.replace('T', ' ')}` : ''}</div>
            </div>
          </div>
        ))}
      </Box>
      {deals && (
        <Box
          title="Deals that need a nudge"
          icon="target"
          action={
            <Link to="/pipeline/deal" className="small">
              Deal board →
            </Link>
          }
          empty={!deals.length && 'Every open deal of yours has been touched in the last two weeks.'}
        >
          {deals.map((d) => (
            <div className="attn" key={d.id}>
              <div className="t">
                <Link to={`/o/deal/${d.id}`}>{d.name}</Link>
                <div className="meta">
                  {d.stage} · {d.why === 'past_close' ? <span style={{ color: 'var(--bad)' }}>close date {d.close_date} has passed</span> : `last touched ${ago(d.last_touch)}`}
                </div>
              </div>
              {d.amount != null && <span className="amt">{inrShort(d.amount)}</span>}
            </div>
          ))}
        </Box>
      )}
      {bids && (
        <Box
          title="GeM bids closing soon"
          icon="gavel"
          action={
            <Link to="/intake/gem" className="small">
              All bids →
            </Link>
          }
          empty={!bids.length && 'No open bids close in the next seven days.'}
        >
          {bids.map((b) => (
            <div className="attn" key={b.id}>
              <span className={`pill ${Date.parse(b.end_at) - Date.now() < 2 * 86_400_000 ? 'bad' : 'warn'}`}>{left(b.end_at)}</span>
              <div className="t">
                <Link to={`/intake/gem?bid=${b.id}`}>{b.title || b.bid_number}</Link>
                <div className="meta">
                  {b.bid_number} · {b.status}
                  {b.matched_keywords?.length ? ` · matches ${b.matched_keywords.join(', ')}` : ''}
                </div>
              </div>
              {b.emd ? <span className="amt small">EMD {inrShort(b.emd)}</span> : null}
            </div>
          ))}
        </Box>
      )}
      {overdue && (
        <Box
          title="Money to collect"
          icon="rupee"
          action={
            <Link to="/books" className="small">
              Books →
            </Link>
          }
          empty={!overdue.length && 'No overdue invoices.'}
        >
          {overdue.map((x) => (
            <div className="attn" key={x.id}>
              <span className="pill bad">{x.days}d late</span>
              <div className="t">
                <Link to={`/o/invoice/${x.id}`}>{x.party}</Link>
                <div className="meta">{x.number}</div>
              </div>
              <span className="amt">{money2(x.balance)}</span>
            </div>
          ))}
        </Box>
      )}
      {(bills?.length || deskItems.length) ? (
        <Box title="Accounts" icon="book">
          {bills?.map((b) => (
            <div className="attn" key={b.id}>
              <span className={`pill ${b.due && b.due < new Date().toISOString().slice(0, 10) ? 'bad' : 'warn'}`}>{b.due ? `due ${b.due.slice(5)}` : 'due'}</span>
              <div className="t">
                <Link to={`/o/bill/${b.id}`}>{b.vendor}</Link>
                <div className="meta">bill to pay</div>
              </div>
              <span className="amt">{money2(b.balance)}</span>
            </div>
          ))}
          {deskItems.map(([n, l, to]) => (
            <div className="attn" key={l}>
              <span className="pill info">{n}</span>
              <div className="t">
                <Link to={to}>{l}</Link>
              </div>
            </div>
          ))}
        </Box>
      ) : null}
    </div>
  );
}
