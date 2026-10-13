import type { RecordDto } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { get } from '../lib/api';
import { useUsers } from '../lib/hooks';

const startOfWeek = (d: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Week view of installations and deliveries, by technician / coordinator. */
export function FieldSchedulePage() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [owner, setOwner] = useState('');
  const users = useUsers();
  const to = new Date(week.getTime() + 7 * 86_400_000);
  const { data, isLoading } = useQuery({
    queryKey: ['field-schedule', ymd(week), owner],
    queryFn: () => get<{ installations: RecordDto[]; shipments: RecordDto[] }>(`/api/v1/field/schedule?from=${encodeURIComponent(week.toISOString())}&to=${encodeURIComponent(to.toISOString())}${owner ? `&owner=${owner}` : ''}`),
  });
  const name = (id: unknown) => users.data?.items.find((u) => u.id === id)?.full_name ?? '';
  const days = [...Array(7)].map((_, i) => new Date(week.getTime() + i * 86_400_000));
  const today = ymd(new Date());
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Field schedule</h1>
          <p>Installations and deliveries for the week.</p>
        </div>
        <div className="row">
          <select value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 'auto' }} aria-label="Person">
            <option value="">Everyone</option>
            {users.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <button className="btn" aria-label="Previous week" onClick={() => setWeek(new Date(week.getTime() - 7 * 86_400_000))}>
            ←
          </button>
          <button className="btn" onClick={() => setWeek(startOfWeek(new Date()))}>
            This week
          </button>
          <button className="btn" aria-label="Next week" onClick={() => setWeek(new Date(week.getTime() + 7 * 86_400_000))}>
            →
          </button>
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="week-grid">
          {days.map((d) => {
            const key = ymd(d);
            const jobs = (data?.installations ?? []).filter((j) => j.scheduled_start && ymd(new Date(String(j.scheduled_start))) === key);
            const drops = (data?.shipments ?? []).filter((s) => String(s.planned_date ?? '').slice(0, 10) === key);
            return (
              <section key={key} className={`week-day${key === today ? ' today' : ''}`} aria-label={d.toDateString()}>
                <h3>{d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</h3>
                {jobs.map((j) => (
                  <Link key={j.id} to={`/o/installation/${j.id}`} className={`job-chip ${String(j.status)}`}>
                    <b>{new Date(String(j.scheduled_start)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</b> {j.title}
                    <div className="muted small">
                      {name(j.owner_id)} · {String(j.status).replace(/_/g, ' ')}
                    </div>
                  </Link>
                ))}
                {drops.map((s) => (
                  <Link key={s.id} to={`/o/shipment/${s.id}`} className={`job-chip ship ${String(s.status)}`}>
                    🚚 {String(s.shipment_number)}
                    <div className="muted small">
                      {s.title} · {String(s.status)}
                    </div>
                  </Link>
                ))}
                {!jobs.length && !drops.length && <span className="muted small">—</span>}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
