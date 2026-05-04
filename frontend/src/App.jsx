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
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="hardware" element={<HardwarePage />} />
              <Route path="clusters" element={<ClusterManagement />} />
              <Route path="pure" element={<PureStoragePage />} />
              <Route path="netapp" element={<NetAppPage />} />
              <Route path="data-protection" element={<DataProtectionPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="reporting" element={<ReportingPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SearchContext.Provider>
    </PlatformContext.Provider>
  );
}
