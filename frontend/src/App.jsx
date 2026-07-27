import { useState, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import DataProtectionPage from './pages/DataProtectionPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ReportingPage from './pages/ReportingPage';
import LicensingPage from './pages/LicensingPage';
import ViewsPage from './pages/ViewsPage';
import WorkloadsPage from './pages/WorkloadsPage';
import SourcesPage from './pages/SourcesPage';
import ReplicationPage from './pages/ReplicationPage';
import GovernancePage from './pages/GovernancePage';
import SettingsPage from './pages/SettingsPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminPluginsPage from './pages/AdminPluginsPage';
import AIAdvisorPage from './pages/AIAdvisorPage';
import OpsMonitorPage from './pages/ops/OpsMonitorPage';
import ErrorBoundary from './components/ErrorBoundary';
import LicenseGate from './components/LicenseGate';
import LoginPage from './pages/LoginPage';
import { ToastProvider } from './components/ui/Toaster';
import GlobalLoadingBar from './components/ui/GlobalLoadingBar';
import { SearchContext, PlatformContext, useSearch, usePlatform } from './context';
import { AuthProvider } from './auth/AuthContext';
import { PlatformsProvider, usePlatforms } from './platforms/PlatformsContext';

// Re-export for backwards compatibility with existing imports.
export { SearchContext, PlatformContext, useSearch, usePlatform };

// Wrap a page element in an ErrorBoundary so a crash on one page
// doesn't blank the entire application.
function withBoundary(element) {
  return <ErrorBoundary>{element}</ErrorBoundary>;
}

function AppRoutes() {
  const { platforms } = usePlatforms();

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/ops" replace />} />
          <Route path="ops" element={withBoundary(<OpsMonitorPage />)} />
          <Route path="dashboard" element={<Navigate to="/cohesity" replace />} />
          <Route path="alerts" element={<Navigate to="/cohesity/alerts" replace />} />
          <Route path="hardware" element={<Navigate to="/cohesity/hardware" replace />} />
          <Route path="clusters" element={<Navigate to="/cohesity/clusters" replace />} />
          {platforms.flatMap(platform => platform.routes.map(r => (
            <Route
              key={r.path}
              path={r.path}
              element={r.element ?? withBoundary(<r.Component />)}
            />
          )))}
          <Route path="data-protection" element={withBoundary(<DataProtectionPage />)} />
          <Route path="replication"     element={withBoundary(<ReplicationPage />)} />
          <Route path="views"           element={withBoundary(<ViewsPage />)} />
          <Route path="workloads"       element={withBoundary(<WorkloadsPage />)} />
          <Route path="sources"         element={withBoundary(<SourcesPage />)} />
          <Route path="analytics"       element={withBoundary(<AnalyticsPage />)} />
          <Route path="governance"      element={withBoundary(<GovernancePage />)} />
          <Route path="reporting"       element={withBoundary(<ReportingPage />)} />
          <Route path="licensing"       element={withBoundary(<LicensingPage />)} />
          <Route path="ai-advisor"      element={withBoundary(<AIAdvisorPage />)} />
          <Route path="settings"        element={withBoundary(<SettingsPage />)} />
          <Route path="admin"           element={withBoundary(<AdminSettingsPage />)} />
          <Route path="admin/users"     element={withBoundary(<AdminUsersPage />)} />
          <Route path="admin/plugins"   element={withBoundary(<AdminPluginsPage />)} />
          <Route path="admin/:section"  element={withBoundary(<AdminSettingsPage />)} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const [search, setSearch] = useState('');
  const [activePlatform, setActivePlatform] = useState('cohesity');

  return (
    <PlatformContext.Provider value={{ activePlatform, setActivePlatform }}>
      <SearchContext.Provider value={{ search, setSearch }}>
        <ToastProvider>
          <GlobalLoadingBar />
          <BrowserRouter>
          <AuthProvider>
          <PlatformsProvider>
          <LicenseGate>
            <AppRoutes />
          </LicenseGate>
          </PlatformsProvider>
          </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
