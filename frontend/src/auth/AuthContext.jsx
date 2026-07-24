import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import client, { setCsrfToken } from '../api/client';
import { hasPermission as checkPermission } from './permissions';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  const loadSession = useCallback(async () => {
    try {
      const { data } = await client.get('/auth/session');
      setUser(data.user);
      setPermissions(data.user?.permissions || []);
      setAuthEnabled(data.authEnabled !== false);
      setCsrfToken(data.csrfToken);
      return data.user;
    } catch {
      setUser(null);
      setPermissions([]);
      setAuthEnabled(true);
      setCsrfToken(null);
      return null;
    }
  }, []);

  useEffect(() => {
    loadSession().finally(() => setLoading(false));
  }, [loadSession]);

  const login = useCallback(async (username, password) => {
    await client.post('/auth/login', { username, password });
    return loadSession();
  }, [loadSession]);

  const logout = useCallback(async () => {
    try {
      await client.post('/auth/logout');
    } finally {
      setUser(null);
      setPermissions([]);
      setCsrfToken(null);
      window.location.assign('/login');
    }
  }, []);

  const hasPermission = useCallback((required) => checkPermission(permissions, required), [permissions]);

  const value = { user, permissions, authEnabled, loading, login, logout, refresh: loadSession, hasPermission };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
