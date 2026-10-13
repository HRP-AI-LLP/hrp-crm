import type { RecordDto } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Empty, ScoreRing, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { moneyShort } from '../lib/format';
import { useMeta } from '../lib/hooks';

interface Stats {
  dealsByStage?: { stage_id: string; count: number; amount: number | null }[];
  wonThisMonth?: { count: number; amount: number | null };
  leads?: { open: number; new_7d: number; hot: number };
  hotLeads?: RecordDto[];
  tasks: { overdue: number; due_today: number; open: number };
}

export function DashboardPage() {
  const { me } = useAuth();
  const { data: meta } = useMeta();
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => get<Stats>('/api/v1/dashboard') });
  const pipe = meta?.pipelines.find((p) => p.objectKey === 'deal' && p.isDefault);
  const byStage = new Map((data?.dealsByStage ?? []).map((s) => [s.stage_id, s]));
  const openStages = pipe?.stages.filter((s) => s.category === 'open') ?? [];
  const maxAmount = Math.max(1, ...openStages.map((s) => Number(byStage.get(s.id)?.amount ?? 0)));
  const weighted = openStages.reduce((sum, s) => sum + Number(byStage.get(s.id)?.amount ?? 0) * (s.probability / 100), 0);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  if (isLoading) return <Spinner />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {greet}, {me?.user.fullName.split(' ')[0]}
          </h1>
          <p>
            {data?.tasks.overdue ? `${data.tasks.overdue} overdue and ` : ''}
            {data?.tasks.due_today ?? 0} due today on your list.
          </p>
        </div>
        <Link className="btn primary" to="/tasks">
          Open my tasks
        </Link>
      </div>

      <div className="kpis">
        <div className="panel kpi">
          <div className="l">Open leads</div>
          <div className="v">{data?.leads?.open ?? '—'}</div>
          <div className="muted small">{data?.leads?.new_7d ?? 0} new this week</div>
        </div>
        <div className="panel kpi">
          <div className="l">Hot leads (score 70+)</div>
          <div className="v" style={{ color: '#9a6a00' }}>{data?.leads?.hot ?? '—'}</div>
          <div className="muted small">Ranked by Synapse AI</div>
        </div>
        <div className="panel kpi">
          <div className="l">Weighted pipeline</div>
          <div className="v">{data?.dealsByStage ? moneyShort(weighted) : '—'}</div>
          <div className="muted small">Amount × stage probability</div>
        </div>
        <div className="panel kpi">
          <div className="l">Won this month</div>
          <div className="v">{data?.wonThisMonth?.amount != null ? moneyShort(data.wonThisMonth.amount) : '—'}</div>
          <div className="muted small">{data?.wonThisMonth?.count ?? 0} deals closed</div>
        </div>
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Pipeline by stage</h2>
            <Link to="/pipeline/deal" className="small">
              Open board
            </Link>
          </div>
          <div className="panel-body">
            {openStages.length === 0 && <Empty title="No deal pipeline yet" />}
            {openStages.map((s) => {
              const st = byStage.get(s.id);
              return (
                <div className="funnel-row" key={s.id}>
                  <span>{s.label}</span>
                  <div className="funnel-bar" aria-hidden="true">
                    <div style={{ width: `${(Number(st?.amount ?? 0) / maxAmount) * 100}%`, background: s.color ?? undefined }} />
                  </div>
                  <span className="small" style={{ textAlign: 'right' }}>
                    {moneyShort(st?.amount ?? 0)} · {st?.count ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Call these leads first</h2>
          </div>
          {data?.hotLeads?.length ? (
            <table className="data">
              <tbody>
                {data.hotLeads.map((l) => (
                  <tr key={l.id}>
                    <td style={{ width: 44 }}>
                      <ScoreRing value={l.ai_score as number} />
                    </td>
                    <td>
                      <Link to={`/o/lead/${l.id}`}>{l.title}</Link>
                      <div className="muted small">{String(l.company ?? l.source ?? '')}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No scored leads yet">New leads are scored automatically within a few seconds of being created.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
