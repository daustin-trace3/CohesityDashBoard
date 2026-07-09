import { useState, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { platforms } from './platforms/registry';
import DataProtectionPage from './pages/DataProtectionPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ReportingPage from './pages/ReportingPage';
import LicensingPage from './pages/LicensingPage';
import ReplicationPage from './pages/ReplicationPage';
import GovernancePage from './pages/GovernancePage';
import SettingsPage from './pages/SettingsPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import AIAdvisorPage from './pages/AIAdvisorPage';
import ErrorBoundary from './components/ErrorBoundary';
import LicenseGate from './components/LicenseGate';
import { ToastProvider } from './components/ui/Toaster';
import GlobalLoadingBar from './components/ui/GlobalLoadingBar';
import { SearchContext, PlatformContext, useSearch, usePlatform } from './context';

// Re-export for backwards compatibility with existing imports.
export { SearchContext, PlatformContext, useSearch, usePlatform };

// Wrap a page element in an ErrorBoundary so a crash on one page
// doesn't blank the entire application.
function withBoundary(element) {
  return <ErrorBoundary>{element}</ErrorBoundary>;
}

export default function App() {
  const [search, setSearch] = useState('');
  const [activePlatform, setActivePlatform] = useState('cohesity');

  return (
    <PlatformContext.Provider value={{ activePlatform, setActivePlatform }}>
      <SearchContext.Provider value={{ search, setSearch }}>
        <ToastProvider>
          <GlobalLoadingBar />
          <LicenseGate>
          <BrowserRouter>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                {platforms.flatMap(platform => platform.routes.map(r => (
                  <Route
                    key={r.path}
                    path={r.path}
                    element={r.element ?? withBoundary(<r.Component />)}
                  />
                )))}
                <Route path="data-protection" element={withBoundary(<DataProtectionPage />)} />
                <Route path="replication"     element={withBoundary(<ReplicationPage />)} />
                <Route path="analytics"       element={withBoundary(<AnalyticsPage />)} />
                <Route path="governance"      element={withBoundary(<GovernancePage />)} />
                <Route path="reporting"       element={withBoundary(<ReportingPage />)} />
                <Route path="licensing"       element={withBoundary(<LicensingPage />)} />
                <Route path="ai-advisor"      element={withBoundary(<AIAdvisorPage />)} />
                <Route path="settings"        element={withBoundary(<SettingsPage />)} />
                <Route path="admin"           element={withBoundary(<AdminSettingsPage />)} />
              </Route>
            </Routes>
            </Suspense>
          </BrowserRouter>
          </LicenseGate>
        </ToastProvider>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
