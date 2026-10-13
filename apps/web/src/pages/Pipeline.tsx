import type { RecordDto } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, ScoreRing, Spinner, useToast } from '../components/ui';
import { get, patch } from '../lib/api';
import { moneyShort } from '../lib/format';
import { useObject, usePipelines } from '../lib/hooks';

export function PipelinePage() {
  const { object = 'deal' } = useParams();
  const obj = useObject(object);
  const pipelines = usePipelines(object);
  const [pipelineId, setPipelineId] = useState<string>('');
  const pipe = pipelines.find((p) => p.id === pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  useEffect(() => setPipelineId(''), [object]);
  const qc = useQueryClient();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const key = ['board', object, pipe?.id];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/${object}?pipeline=${pipe!.id}&limit=200&sort=updated_at`),
    enabled: !!pipe,
  });

  if (!obj) return <Spinner />;
  if (!pipe) return <Empty title={`No pipeline for ${obj.plural.toLowerCase()}`}>An admin can add one in Settings → Pipelines.</Empty>;

  const move = async (recordId: string, stageId: string) => {
    const rec = data?.items.find((r) => r.id === recordId);
    if (!rec || rec.stage_id === stageId) return;
    // optimistic move
    qc.setQueryData<{ items: RecordDto[] }>(key, (d) => (d ? { items: d.items.map((r) => (r.id === recordId ? { ...r, stage_id: stageId } : r)) } : d));
    try {
      await patch(`/api/v1/records/${object}/${recordId}`, { stage_id: stageId }, { 'if-match': String(rec.version) });
    } catch (e) {
      toast((e as Error).message, true);
    }
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{obj.label} board</h1>
          <p>Drag a card to move it to another stage.</p>
        </div>
        {pipelines.length > 1 && (
          <select value={pipe.id} onChange={(e) => setPipelineId(e.target.value)} style={{ width: 'auto' }} aria-label="Pipeline">
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="board">
          {pipe.stages.map((s) => {
            const cards = data?.items.filter((r) => r.stage_id === s.id) ?? [];
            const total = cards.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
            return (
              <div
                key={s.id}
                className={`column${over === s.id ? ' over' : ''}`}
                style={{ ['--c' as string]: s.color ?? undefined }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(s.id);
                }}
                onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) move(id, s.id);
                }}
              >
                <div className="column-head">
                  <div className="spread">
                    <h3>{s.label}</h3>
                    <span className="muted small">{cards.length}</span>
                  </div>
                  <div className="sum">
                    {object === 'deal' ? `${moneyShort(total)} · ` : ''}
                    {s.probability}% likely
                  </div>
                </div>
                <div className="column-body">
                  {cards.map((r) => (
                    <div
                      key={r.id}
                      className="deal-card"
                      draggable
                      aria-grabbed={dragging === r.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', r.id);
                        setDragging(r.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <div className="spread">
                        <Link to={`/o/${object}/${r.id}`} style={{ fontWeight: 600 }}>
                          {r.title}
                        </Link>
                        {object === 'lead' && <ScoreRing value={r.ai_score as number | null} />}
                      </div>
                      {object === 'deal' && <div className="amt">{r.amount != null ? moneyShort(r.amount) : 'No amount'}</div>}
                      {r.close_date ? <div className="muted small">Closes {new Date(String(r.close_date)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div> : null}
                      {/* keyboard alternative to drag and drop */}
                      <label className="sr-only" htmlFor={`mv-${r.id}`}>
                        Move {r.title} to stage
                      </label>
                      <select id={`mv-${r.id}`} className="sr-only" value={s.id} onChange={(e) => move(r.id, e.target.value)}>
                        {pipe.stages.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
