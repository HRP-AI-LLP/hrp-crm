/** Light or dark, as the person chose (light until they do); set on <html data-theme> inside the app only, so printed documents stay light. */
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'synapse.theme';

export function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(initialTheme);
  useEffect(() => {
    applyTheme(t);
    return () => applyTheme('light');
  }, [t]);
  return [
    t,
    (n: Theme) => {
      try {
        localStorage.setItem(KEY, n);
      } catch {
        /* ignore */
      }
      setT(n);
    },
  ];
}
