import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Spinner, useToast } from '../components/ui';
import { get, patch, post } from '../lib/api';
import { dateTime } from '../lib/format';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  related_object: string | null;
  related_id: string | null;
  assignee_name: string | null;
  source: string;
}

export function TaskList({ relatedObject, relatedId, compact }: { relatedObject?: string; relatedId?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [remind, setRemind] = useState('');
  const [showDone, setShowDone] = useState(false);
  const qs = new URLSearchParams();
  if (relatedObject && relatedId) {
    qs.set('relatedObject', relatedObject);
    qs.set('relatedId', relatedId);
  } else qs.set('mine', '1');
  if (!showDone) qs.set('status', 'open,in_progress');
  const { data, isLoading } = useQuery({ queryKey: ['tasks', qs.toString()], queryFn: () => get<{ items: Task[] }>(`/api/v1/tasks?${qs}`) });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const dueAt = due ? new Date(due) : null;
      const remindAt = dueAt && remind !== '' ? new Date(dueAt.getTime() - Number(remind) * 60_000).toISOString() : null;
      await post('/api/v1/tasks', { title, dueAt: dueAt?.toISOString() ?? null, remindAt, relatedObject, relatedId });
      setTitle('');
      setDue('');
      qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const toggle = async (t: Task) => {
    await patch(`/api/v1/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const now = Date.now();

  return (
    <div className="stack">
      <form className="row" onSubmit={add}>
        <input placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" style={{ width: 210 }} />
        {due && (
          <select value={remind} onChange={(e) => setRemind(e.target.value)} aria-label="Reminder" style={{ width: 150 }}>
            <option value="">No reminder</option>
            <option value="0">At due time</option>
            <option value="15">15 min before</option>
            <option value="60">1 hour before</option>
            <option value="1440">1 day before</option>
          </select>
        )}
        <button className="btn primary" disabled={!title.trim()}>
          Add
        </button>
      </form>
      {isLoading ? (
        <Spinner />
      ) : data?.items.length ? (
        <table className="data">
          <tbody>
            {data.items.map((t) => {
              const overdue = t.due_at && new Date(t.due_at).getTime() < now && t.status !== 'done';
              return (
                <tr key={t.id}>
                  <td style={{ width: 28 }}>
                    <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label={`Mark ${t.title} done`} />
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <span style={{ textDecoration: t.status === 'done' ? 'line-through' : undefined, fontWeight: 600 }}>{t.title}</span>
                    {t.priority === 'high' || t.priority === 'urgent' ? <span className="chip bad" style={{ marginLeft: 8 }}>{t.priority}</span> : null}
                    {t.source === 'workflow' && <span className="chip" style={{ marginLeft: 8 }}>automated</span>}
                    {!compact && t.related_object && t.related_id && (
                      <div className="small">
                        <Link to={`/o/${t.related_object}/${t.related_id}`}>Open {t.related_object}</Link>
                      </div>
                    )}
                  </td>
                  <td className={overdue ? 'field-error' : 'muted'} style={{ width: 150 }}>
                    {t.due_at ? dateTime(t.due_at) : 'No due date'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty title={compact ? 'No open tasks for this record' : 'You are all caught up'} />
      )}
      <label className="row small muted">
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed
      </label>
    </div>
  );
}

export function TasksPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My tasks</h1>
          <p>Tasks assigned to you or created by you, soonest first.</p>
        </div>
      </div>
      <section className="panel panel-body">
        <TaskList />
      </section>
    </>
  );
}
