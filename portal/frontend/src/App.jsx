import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import client, { setCsrfToken } from './api/client';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import PortalHome from './pages/PortalHome';
import TenantsAdminPage from './pages/TenantsAdminPage';
import UsersPage from './pages/UsersPage';

export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const { data } = await client.get('/auth/session');
      setCsrfToken(data.csrfToken);
      setUser(data.user);
    } catch {
      setCsrfToken(null);
      setUser(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => { loadSession(); }, [loadSession]);

  const logout = async () => {
    try { await client.post('/auth/logout'); } catch { /* session already gone */ }
    setCsrfToken(null);
    setUser(null);
  };

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="skeleton w-64 h-8" />
      </div>
    );
  }

  if (!user) return <LoginPage onAuthed={loadSession} />;

  return (
    <Layout user={user} onLogout={logout}>
      <Routes>
        <Route path="/" element={<PortalHome />} />
        <Route path="/tenants" element={<TenantsAdminPage />} />
        <Route path="/users" element={<UsersPage currentUser={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
