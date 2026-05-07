import React, { useState, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import AlertsPage from './pages/AlertsPage';
import HardwarePage from './pages/HardwarePage';
import ClusterManagement from './pages/ClusterManagement';
import PureStoragePage from './pages/PureStoragePage';
import NetAppPage from './pages/NetAppPage';
import DataProtectionPage from './pages/DataProtectionPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ReportingPage from './pages/ReportingPage';
import ReplicationPage from './pages/ReplicationPage';
import ErrorBoundary from './components/ErrorBoundary';

// Wrap a page element in an ErrorBoundary so a crash on one page
// doesn't blank the entire application.
function withBoundary(element) {
  return <ErrorBoundary>{element}</ErrorBoundary>;
}

export const SearchContext = createContext({ search: '', setSearch: () => {} });
export const PlatformContext = React.createContext();

export function useSearch() {
  return useContext(SearchContext);
}

export function usePlatform() {
  return useContext(PlatformContext);
}

export default function App() {
  const [search, setSearch] = useState('');
  const [activePlatform, setActivePlatform] = useState('cohesity');

  return (
    <PlatformContext.Provider value={{ activePlatform, setActivePlatform }}>
      <SearchContext.Provider value={{ search, setSearch }}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard"       element={withBoundary(<Dashboard />)} />
              <Route path="alerts"          element={withBoundary(<AlertsPage />)} />
              <Route path="hardware"        element={withBoundary(<HardwarePage />)} />
              <Route path="clusters"        element={withBoundary(<ClusterManagement />)} />
              <Route path="pure"            element={withBoundary(<PureStoragePage />)} />
              <Route path="netapp"          element={withBoundary(<NetAppPage />)} />
              <Route path="data-protection" element={withBoundary(<DataProtectionPage />)} />
              <Route path="replication"     element={withBoundary(<ReplicationPage />)} />
              <Route path="analytics"       element={withBoundary(<AnalyticsPage />)} />
              <Route path="reporting"       element={withBoundary(<ReportingPage />)} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
