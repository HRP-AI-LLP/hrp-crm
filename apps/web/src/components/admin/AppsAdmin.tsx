import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../lib/api';
import { Spinner, useToast } from '../ui';

interface AppRow {
  key: string;
  name: string;
  description: string;
  requires: string[];
  enabled: boolean;
  objects: string[];
}

/** Settings → Apps: switch built-in operations apps on or off for the workspace. */
export function AppsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-apps'], queryFn: () => get<{ items: AppRow[] }>('/api/admin/apps') });
  if (!data) return <Spinner />;
  const toggle = async (a: AppRow) => {
    if (a.enabled && !window.confirm(`Switch off ${a.name}? Its screens disappear for everyone; the data stays and comes back when you switch it on again.`)) return;
    try {
      await post(`/api/admin/apps/${a.key}/${a.enabled ? 'disable' : 'enable'}`);
      toast(`${a.name} ${a.enabled ? 'switched off' : 'switched on'}`);
      qc.invalidateQueries({ queryKey: ['admin-apps'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Operations apps extend the CRM into fulfilment: orders, stock, purchasing, deliveries, service and billing. Switch on what your business runs; each app adds its own screens, roles and permissions.
      </p>
      <div className="app-grid">
        {data.items.map((a) => (
          <article key={a.key} className={`panel app-card${a.enabled ? ' on' : ''}`}>
            <div className="spread">
              <h3>{a.name}</h3>
              <label className="switch" aria-label={`${a.name} ${a.enabled ? 'on' : 'off'}`}>
                <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} />
                <span />
              </label>
            </div>
            <p className="small">{a.description}</p>
            {a.objects.length > 0 && <p className="muted small">Adds: {a.objects.join(', ')}</p>}
            {a.requires.length > 0 && <p className="muted small">Needs: {a.requires.join(', ')}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}
