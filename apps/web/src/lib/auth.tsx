import type { EffectivePermissions } from '@synapse/shared';
import { hasAdmin } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, onExpired, onMfaRequired, post, refreshSession, setAccessToken, setWorkspace } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string; isOwner: boolean; roles: string[]; attributes: Record<string, unknown> };
  tenant: { id: string; slug: string; name: string };
  permissions: EffectivePermissions;
  security?: { mfaEnabled: boolean; mfaRequired: boolean };
}

export type LoginResult = { ok: true } | { mfaChallenge: string };

interface AuthState {
  me: Me | null;
  ready: boolean;
  /** resolves with a challenge when two-factor sign-in is needed */
  login(workspace: string | null, email: string, password: string): Promise<LoginResult>;
  verifyMfa(challenge: string, code: { code?: string; recoveryCode?: string }): Promise<void>;
  /** sign in with a token issued by invite acceptance */
  adopt(accessToken: string): Promise<void>;
  reload(): Promise<void>;
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
    onMfaRequired(() => void loadMe().catch(() => undefined));
    (async () => {
      if (await refreshSession()) await loadMe().catch(() => setMe(null));
      setReady(true);
    })();
  }, [loadMe, qc]);

  const login = async (workspace: string | null, email: string, password: string): Promise<LoginResult> => {
    if (workspace) setWorkspace(workspace);
    const r = await post<{ accessToken?: string; mfaRequired?: boolean; challenge?: string }>('/api/auth/login', { email, password });
    if (r.mfaRequired && r.challenge) return { mfaChallenge: r.challenge };
    setAccessToken(r.accessToken!);
    await loadMe();
    return { ok: true };
  };

  const verifyMfa = async (challenge: string, c: { code?: string; recoveryCode?: string }) => {
    const r = await post<{ accessToken: string }>('/api/auth/mfa/verify', { challenge, ...c });
    setAccessToken(r.accessToken);
    await loadMe();
  };

  const adopt = async (accessToken: string) => {
    setAccessToken(accessToken);
    await loadMe();
  };

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setMe(null);
    qc.clear();
  };

  const can = (area: string) => !!me && hasAdmin(me.permissions, area);

  return <Ctx.Provider value={{ me, ready, login, verifyMfa, adopt, reload: loadMe, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
