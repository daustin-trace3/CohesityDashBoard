import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import AlertsPage from './pages/AlertsPage';
import HardwarePage from './pages/HardwarePage';
import ClusterManagement from './pages/ClusterManagement';
import PureOverviewPage from './pages/pure/PureOverviewPage';
import PureCapacityPage from './pages/pure/PureCapacityPage';
import PureVolumesPage from './pages/pure/PureVolumesPage';
import PureReplicationPage from './pages/pure/PureReplicationPage';
import PureHardwarePage from './pages/pure/PureHardwarePage';
import PureAlertsPage from './pages/pure/PureAlertsPage';
import PureSettingsPage from './pages/pure/PureSettingsPage';
import NetAppOverviewPage from './pages/netapp/NetAppOverviewPage';
import NetAppCapacityPage from './pages/netapp/NetAppCapacityPage';
import NetAppVolumesPage from './pages/netapp/NetAppVolumesPage';
import NetAppAlertsPage from './pages/netapp/NetAppAlertsPage';
import NetAppHardwarePage from './pages/netapp/NetAppHardwarePage';
import NetAppSettingsPage from './pages/netapp/NetAppSettingsPage';
import DataProtectionPage from './pages/DataProtectionPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ReportingPage from './pages/ReportingPage';
import LicensingPage from './pages/LicensingPage';
import ReplicationPage from './pages/ReplicationPage';
import GovernancePage from './pages/GovernancePage';
import SettingsPage from './pages/SettingsPage';
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
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard"       element={withBoundary(<Dashboard />)} />
                <Route path="alerts"          element={withBoundary(<AlertsPage />)} />
                <Route path="hardware"        element={withBoundary(<HardwarePage />)} />
                <Route path="clusters"        element={withBoundary(<ClusterManagement />)} />
                <Route path="pure"            element={withBoundary(<PureOverviewPage />)} />
                <Route path="pure/capacity"   element={withBoundary(<PureCapacityPage />)} />
                <Route path="pure/volumes"    element={withBoundary(<PureVolumesPage />)} />
                <Route path="pure/replication" element={withBoundary(<PureReplicationPage />)} />
                <Route path="pure/hardware"   element={withBoundary(<PureHardwarePage />)} />
                <Route path="pure/alerts"     element={withBoundary(<PureAlertsPage />)} />
                <Route path="pure/settings"   element={withBoundary(<PureSettingsPage />)} />
                <Route path="netapp"          element={withBoundary(<NetAppOverviewPage />)} />
                <Route path="netapp/capacity" element={withBoundary(<NetAppCapacityPage />)} />
                <Route path="netapp/volumes"  element={withBoundary(<NetAppVolumesPage />)} />
                <Route path="netapp/alerts"   element={withBoundary(<NetAppAlertsPage />)} />
                <Route path="netapp/hardware" element={withBoundary(<NetAppHardwarePage />)} />
                <Route path="netapp/settings" element={withBoundary(<NetAppSettingsPage />)} />
                <Route path="data-protection" element={withBoundary(<DataProtectionPage />)} />
                <Route path="replication"     element={withBoundary(<ReplicationPage />)} />
                <Route path="analytics"       element={withBoundary(<AnalyticsPage />)} />
                <Route path="governance"      element={withBoundary(<GovernancePage />)} />
                <Route path="reporting"       element={withBoundary(<ReportingPage />)} />
                <Route path="licensing"       element={withBoundary(<LicensingPage />)} />
                <Route path="ai-advisor"      element={withBoundary(<AIAdvisorPage />)} />
                <Route path="settings"        element={withBoundary(<SettingsPage />)} />
              </Route>
            </Routes>
          </BrowserRouter>
          </LicenseGate>
        </ToastProvider>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
