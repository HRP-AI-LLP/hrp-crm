import { useQuery, useQueryClient } from '@tanstack/react-query';
import { post } from '../lib/api';
import { relative } from '../lib/format';
import { enablePush, forgetDevice, isStandalone, pushConfig, pushSupported, removeDevice, useCurrentEndpoint, useInstallPrompt } from '../lib/pwa';
import { useToast } from './ui';

/** "Phone & notifications" panel on My account: install the app, enrol devices for push. */
export function PushDevices() {
  const toast = useToast();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['push-config'], queryFn: pushConfig });
  const [endpoint, refresh] = useCurrentEndpoint();
  const inst = useInstallPrompt();
  const reload = () => {
    refresh();
    qc.invalidateQueries({ queryKey: ['push-config'] });
  };
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Phone &amp; notifications</h2>
      </div>
      <div className="panel-body stack">
        {!isStandalone() && (
          <p className="small">
            {inst.canInstall ? (
              <>
                Install Synapse as an app for full-screen use, offline visit logging and reminders.{' '}
                <button className="link" onClick={() => void inst.install()}>
                  Install app
                </button>
              </>
            ) : inst.iosHint ? (
              'On iPhone or iPad: open this site in Safari, tap Share and choose “Add to Home Screen”. Notifications need iOS 16.4 or later.'
            ) : (
              'Open this site on your phone in Chrome and choose “Install app” (or “Add to Home screen”) to use Synapse as an app.'
            )}
          </p>
        )}
        {!cfg.data?.enabled ? (
          <p className="muted small">Push notifications are not configured for this server yet.</p>
        ) : !pushSupported() ? (
          <p className="muted small">This browser cannot receive push notifications.</p>
        ) : blocked ? (
          <p className="muted small">Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.</p>
        ) : endpoint ? (
          <div className="row">
            <span className="chip good">On for this device</span>
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  const t = await post<{ sent: number }>('/api/v1/push/test');
                  toast(t.sent ? 'Test notification sent' : 'No device accepted the test — try turning notifications off and on', !t.sent);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Send a test
            </button>
            <button
              className="btn ghost sm"
              onClick={async () => {
                await forgetDevice();
                reload();
              }}
            >
              Turn off here
            </button>
          </div>
        ) : (
          <div>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await enablePush(cfg.data!.publicKey!);
                  reload();
                  toast('Notifications are on for this device');
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Turn on notifications for this device
            </button>
          </div>
        )}
        {(cfg.data?.devices.length ?? 0) > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Device</th>
                <th>Added</th>
                <th>Last delivered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cfg.data!.devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.label ?? d.endpoint_host}
                  </td>
                  <td>{relative(d.created_at)}</td>
                  <td>{d.last_success_at ? relative(d.last_success_at) : '—'}</td>
                  <td>
                    <button
                      className="link danger"
                      onClick={async () => {
                        await removeDevice(d.id).catch((e) => toast((e as Error).message, true));
                        reload();
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
