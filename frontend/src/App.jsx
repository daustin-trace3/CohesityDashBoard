import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import AlertsPage from './pages/AlertsPage';
import HardwarePage from './pages/HardwarePage';
import ClusterManagement from './pages/ClusterManagement';
import PureAlertsPage from './pages/pure/PureAlertsPage';
import Pure1FleetPage from './pages/pure/Pure1FleetPage';
import PureCapacityPage from './pages/pure/PureCapacityPage';
import PureVolumesPage from './pages/pure/PureVolumesPage';
import PureReplicationPage from './pages/pure/PureReplicationPage';
import PureHardwarePage from './pages/pure/PureHardwarePage';
import PureConnectivityPage from './pages/pure/PureConnectivityPage';
import PureSettingsPage from './pages/pure/PureSettingsPage';
import PureEstatePage from './pages/pure/PureEstatePage';
import NetAppOverviewPage from './pages/netapp/NetAppOverviewPage';
import NetAppCapacityPage from './pages/netapp/NetAppCapacityPage';
import NetAppVolumesPage from './pages/netapp/NetAppVolumesPage';
import NetAppNfsPage from './pages/netapp/NetAppNfsPage';
import NetAppCifsPage from './pages/netapp/NetAppCifsPage';
import NetAppReplicationPage from './pages/netapp/NetAppReplicationPage';
import NetAppAlertsPage from './pages/netapp/NetAppAlertsPage';
import NetAppHardwarePage from './pages/netapp/NetAppHardwarePage';
import NetAppSettingsPage from './pages/netapp/NetAppSettingsPage';
import ZertoOverviewPage from './pages/zerto/ZertoOverviewPage';
import ZertoVpgsPage from './pages/zerto/ZertoVpgsPage';
import ZertoReplicationPage from './pages/zerto/ZertoReplicationPage';
import ZertoSitesPage from './pages/zerto/ZertoSitesPage';
import ZertoAlertsPage from './pages/zerto/ZertoAlertsPage';
import ZertoVmsPage from './pages/zerto/ZertoVmsPage';
import ZertoSettingsPage from './pages/zerto/ZertoSettingsPage';
import VcOverviewPage from './pages/vcenter/VcOverviewPage';
import VcHostsPage from './pages/vcenter/VcHostsPage';
import VcInventoryPage from './pages/vcenter/VcInventoryPage';
import VcDatastoresPage from './pages/vcenter/VcDatastoresPage';
import VcNetworkPage from './pages/vcenter/VcNetworkPage';
import VcEventsPage from './pages/vcenter/VcEventsPage';
import VcGovernancePage from './pages/vcenter/VcGovernancePage';
import VcSettingsPage from './pages/vcenter/VcSettingsPage';
import DellOverviewPage from './pages/dell/DellOverviewPage';
import DellDevicesPage from './pages/dell/DellDevicesPage';
import DellAlertsPage from './pages/dell/DellAlertsPage';
import DellHardwarePage from './pages/dell/DellHardwarePage';
import DellSupportPage from './pages/dell/DellSupportPage';
import DellSettingsPage from './pages/dell/DellSettingsPage';
import DataProtectionPage from './pages/DataProtectionPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ReportingPage from './pages/ReportingPage';
import LicensingPage from './pages/LicensingPage';
import ViewsPage from './pages/ViewsPage';
import WorkloadsPage from './pages/WorkloadsPage';
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
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard"       element={withBoundary(<Dashboard />)} />
                <Route path="alerts"          element={withBoundary(<AlertsPage />)} />
                <Route path="hardware"        element={withBoundary(<HardwarePage />)} />
                <Route path="clusters"        element={withBoundary(<ClusterManagement />)} />
                <Route path="pure"            element={withBoundary(<Pure1FleetPage />)} />
                <Route path="pure/estate"     element={withBoundary(<PureEstatePage />)} />
                <Route path="pure/fleet"      element={<Navigate to="/pure" replace />} />
                <Route path="pure/capacity"   element={withBoundary(<PureCapacityPage />)} />
                <Route path="pure/volumes"    element={withBoundary(<PureVolumesPage />)} />
                <Route path="pure/replication" element={withBoundary(<PureReplicationPage />)} />
                <Route path="pure/hardware"   element={withBoundary(<PureHardwarePage />)} />
                <Route path="pure/connectivity" element={withBoundary(<PureConnectivityPage />)} />
                <Route path="pure/alerts"     element={withBoundary(<PureAlertsPage />)} />
                <Route path="pure/settings"   element={withBoundary(<PureSettingsPage />)} />
                <Route path="netapp"          element={withBoundary(<NetAppOverviewPage />)} />
                <Route path="netapp/capacity" element={withBoundary(<NetAppCapacityPage />)} />
                <Route path="netapp/volumes"  element={withBoundary(<NetAppVolumesPage />)} />
                <Route path="netapp/nfs"      element={withBoundary(<NetAppNfsPage />)} />
                <Route path="netapp/cifs"     element={withBoundary(<NetAppCifsPage />)} />
                <Route path="netapp/replication" element={withBoundary(<NetAppReplicationPage />)} />
                <Route path="netapp/alerts"   element={withBoundary(<NetAppAlertsPage />)} />
                <Route path="netapp/hardware" element={withBoundary(<NetAppHardwarePage />)} />
                <Route path="netapp/settings" element={withBoundary(<NetAppSettingsPage />)} />
                <Route path="zerto"           element={withBoundary(<ZertoOverviewPage />)} />
                <Route path="zerto/vpgs"      element={withBoundary(<ZertoVpgsPage />)} />
                <Route path="zerto/replication" element={withBoundary(<ZertoReplicationPage />)} />
                <Route path="zerto/sites"     element={withBoundary(<ZertoSitesPage />)} />
                <Route path="zerto/alerts"    element={withBoundary(<ZertoAlertsPage />)} />
                <Route path="zerto/vms"       element={withBoundary(<ZertoVmsPage />)} />
                <Route path="zerto/settings"  element={withBoundary(<ZertoSettingsPage />)} />
                <Route path="vcenter"            element={withBoundary(<VcOverviewPage />)} />
                <Route path="vcenter/hosts"      element={withBoundary(<VcHostsPage />)} />
                <Route path="vcenter/inventory"  element={withBoundary(<VcInventoryPage />)} />
                <Route path="vcenter/datastores" element={withBoundary(<VcDatastoresPage />)} />
                <Route path="vcenter/network"    element={withBoundary(<VcNetworkPage />)} />
                <Route path="vcenter/events"     element={withBoundary(<VcEventsPage />)} />
                <Route path="vcenter/governance" element={withBoundary(<VcGovernancePage />)} />
                <Route path="vcenter/settings"   element={withBoundary(<VcSettingsPage />)} />
                <Route path="dell"            element={withBoundary(<DellOverviewPage />)} />
                <Route path="dell/devices"    element={withBoundary(<DellDevicesPage />)} />
                <Route path="dell/alerts"     element={withBoundary(<DellAlertsPage />)} />
                <Route path="dell/hardware"   element={withBoundary(<DellHardwarePage />)} />
                <Route path="dell/support"    element={withBoundary(<DellSupportPage />)} />
                <Route path="dell/settings"   element={withBoundary(<DellSettingsPage />)} />
                <Route path="data-protection" element={withBoundary(<DataProtectionPage />)} />
                <Route path="replication"     element={withBoundary(<ReplicationPage />)} />
                <Route path="views"           element={withBoundary(<ViewsPage />)} />
                <Route path="workloads"       element={withBoundary(<WorkloadsPage />)} />
                <Route path="analytics"       element={withBoundary(<AnalyticsPage />)} />
                <Route path="governance"      element={withBoundary(<GovernancePage />)} />
                <Route path="reporting"       element={withBoundary(<ReportingPage />)} />
                <Route path="licensing"       element={withBoundary(<LicensingPage />)} />
                <Route path="ai-advisor"      element={withBoundary(<AIAdvisorPage />)} />
                <Route path="settings"        element={withBoundary(<SettingsPage />)} />
                <Route path="admin"           element={withBoundary(<AdminSettingsPage />)} />
              </Route>
            </Routes>
          </BrowserRouter>
          </LicenseGate>
        </ToastProvider>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
