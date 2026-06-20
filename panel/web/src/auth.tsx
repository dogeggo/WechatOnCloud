import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isUnauthorizedError, type PanelUser } from './api';

interface AuthCtx {
  user: PanelUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);
const AUTH_KEEP_ALIVE_MS = 5 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PanelUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch (error) {
      if (isUnauthorizedError(error)) setUser(null);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  const initialRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void initialRefresh();
  }, [initialRefresh]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, AUTH_KEEP_ALIVE_MS);
    return () => window.clearInterval(timer);
  }, [refresh, user]);

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
