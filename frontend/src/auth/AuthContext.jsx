import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import client, { setCsrfToken } from '../api/client';
import { hasPermission as checkPermission } from './permissions';
import { routerBasename, currentTenant, tenantHome } from '../tenant';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  // Tenants this account may enter, and whether the install has more than
  // one (then every page must sit under /t/<tenant>/).
  const [tenants, setTenants] = useState([]);
  const [multiTenant, setMultiTenant] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const { data } = await client.get('/auth/session');
      setUser(data.user);
      setPermissions(data.user?.permissions || []);
      setAuthEnabled(data.authEnabled !== false);
      setCsrfToken(data.csrfToken);
      setTenants(data.tenants || []);
      setMultiTenant(!!data.multiTenant);
      // The URL names no tenant on an install that has several: go to the
      // only one this account may enter, or let the picker page choose.
      const path = window.location.pathname;
      if (data.multiTenant && !currentTenant() && !path.startsWith('/login') && !path.startsWith('/tenants')) {
        const list = data.tenants || [];
        if (list.length === 1) window.location.replace(tenantHome(list[0].id) + path.replace(/^\//, ''));
        else window.location.replace('/tenants');
      }
      return data.user;
    } catch {
      setUser(null);
      setPermissions([]);
      setAuthEnabled(true);
      setCsrfToken(null);
      setTenants([]);
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
      window.location.assign(`${routerBasename()}/login`);
    }
  }, []);

  const hasPermission = useCallback((required) => checkPermission(permissions, required), [permissions]);

  const value = { user, permissions, authEnabled, loading, login, logout, refresh: loadSession, hasPermission, tenants, multiTenant, tenant: currentTenant() };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
