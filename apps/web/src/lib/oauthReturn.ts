import { useEffect } from 'react';
import { useToast } from '../components/ui';

const NAMES: Record<string, string> = { google: 'Gmail', microsoft: 'Outlook', meta: 'Facebook', zoom: 'Zoom', gmeet: 'Google Meet', msmeet: 'Microsoft Teams' };

/** After an OAuth round trip the API sends people back with ?integration=…&connected=…|error=… */
export function useOAuthReturn(onDone?: () => void) {
  const toast = useToast();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = q.get('integration');
    if (!p) return;
    const name = NAMES[p] ?? p;
    if (q.get('error')) toast(`${name}: ${q.get('error')}`, true);
    else toast(`${name} connected${q.get('connected') ? `: ${q.get('connected')}` : ''}`);
    if (q.get('failed')) toast(`Not connected: ${q.get('failed')}`, true);
    for (const k of ['integration', 'connected', 'error', 'failed']) q.delete(k);
    history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}${window.location.hash}`);
    onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
