import type { EffectivePermissions } from '@synapse/shared';
import { hasAdmin } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, onExpired, post, refreshSession, setAccessToken, setWorkspace } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string; isOwner: boolean; roles: string[]; attributes: Record<string, unknown> };
  tenant: { id: string; slug: string; name: string };
  permissions: EffectivePermissions;
}

interface AuthState {
  me: Me | null;
  ready: boolean;
  login(workspace: string | null, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(area: string): boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();

  const loadMe = useCallback(async () => setMe(await api<Me>('/api/auth/me')), []);

  useEffect(() => {
    onExpired(() => {
      setAccessToken(null);
      setMe(null);
      qc.clear();
    });
    (async () => {
      if (await refreshSession()) await loadMe().catch(() => setMe(null));
      setReady(true);
    })();
  }, [loadMe, qc]);

  const login = async (workspace: string | null, email: string, password: string) => {
    if (workspace) setWorkspace(workspace);
    const r = await post<{ accessToken: string }>('/api/auth/login', { email, password });
    setAccessToken(r.accessToken);
    await loadMe();
  };

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setMe(null);
    qc.clear();
  };

  const can = (area: string) => !!me && hasAdmin(me.permissions, area);

  return <Ctx.Provider value={{ me, ready, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
