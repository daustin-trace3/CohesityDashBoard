import { useEffect, useState, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, Download, RefreshCw, X } from 'lucide-react';
import client from '../api/client';
import AlertBadge from '../components/AlertBadge';
import SkeletonTable from '../components/SkeletonTable';
import EmptyState, { AlertEmptyIcon } from '../components/EmptyState';
import Pagination from '../components/Pagination';
import { PageHeader } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

function exportAlertsCSV(alerts) {
  const headers = ['ID', 'Cluster', 'Severity', 'Type', 'Description', 'First Seen', 'Status'];
  const rows = alerts.map(a => [
    a.id,
    `"${(a.cluster_name || '').replace(/"/g, '""')}"`,
    a.severity,
    `"${(a.alert_type || '').replace(/"/g, '""')}"`,
    `"${(a.description || '').replace(/"/g, '""')}"`,
    a.first_seen ? new Date(a.first_seen).toISOString() : '',
    a.dismissed ? 'Dismissed' : a.resolved ? 'Resolved' : 'Open',
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `alerts-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDismissConfirm, setBulkDismissConfirm] = useState(false);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const [searchParams, setSearchParams] = useSearchParams();
  const [severity, setSeverity] = useState('');
  const [clusterId, setClusterId] = useState(searchParams.get('clusterId') || '');
  const [showDismissed, setShowDismissed] = useState(false);

  // Keep the cluster filter in sync with the URL so insight cards and other
  // pages can deep-link to /alerts?clusterId=N.
  useEffect(() => {
    setClusterId(searchParams.get('clusterId') || '');
  }, [searchParams]);

  const handleClusterFilter = (value) => {
    setClusterId(value);
    setSearchParams(value ? { clusterId: value } : {}, { replace: true });
  };

  const tableTopRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    toast({ type, title: msg });
  };

  const loadAlerts = () => {
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    if (clusterId) params.set('clusterId', clusterId);
    if (showDismissed) params.set('dismissed', '1');
    setLoading(true);
    setPage(0);
    client
      .get(`/alerts?${params}`)
      .then(({ data }) => { setAlerts(data); setSelectedIds(new Set()); })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    client.get('/clusters').then(({ data }) => setClusters(data)).catch(() => {});
  }, []);

  useEffect(() => { loadAlerts(); }, [severity, clusterId, showDismissed]);

  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleBulkDismiss = async () => {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map(id => client.post(`/alerts/${id}/dismiss`)));
    const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
    const failed = ids.length - succeeded.length;
    setAlerts(prev => prev.filter(a => !succeeded.includes(a.id)));
    setSelectedIds(new Set());
    setBulkDismissConfirm(false);
    setPage(0);
    if (failed === 0) {
      showToast(`${succeeded.length} alert(s) dismissed`);
    } else {
      showToast(`${succeeded.length} dismissed, ${failed} failed`, 'error');
    }
  };

  const dismiss = async (id) => {
    try {
      await client.post(`/alerts/${id}/dismiss`);
      setAlerts(prev => prev.filter(a => a.id !== id));
      showToast('Alert dismissed');
    } catch {
      showToast('Failed to dismiss alert', 'error');
    }
  };

  const handlePageSize = (s) => { setPageSize(s); setPage(0); };
  const handlePageChange = (p) => {
    setPage(p);
    tableTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const totalPages = Math.max(1, Math.ceil(alerts.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = useMemo(
    () => alerts.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [alerts, safePage, pageSize]
  );

  const dismissableAlerts = pageItems.filter(a => !a.dismissed);
  const allSelected = dismissableAlerts.length > 0 && dismissableAlerts.every(a => selectedIds.has(a.id));
  const someSelected = dismissableAlerts.some(a => selectedIds.has(a.id));

  return (
    <div className="relative" ref={tableTopRef}>
      <PageHeader
        icon={Bell}
        title="Alerts"
        description="Triage, filter, and dismiss alerts across every monitored cluster"
      >
        {alerts.length > 0 && !loading && (
          <button
            onClick={() => exportAlertsCSV(alerts)}
            aria-label="Export alerts to CSV"
            className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Download size={13} />
            Export CSV
          </button>
        )}
        <button
          onClick={loadAlerts}
          aria-label="Refresh alerts"
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </PageHeader>

      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <label className="sr-only" htmlFor="severity-filter">Severity</label>
        <select id="severity-filter" value={severity} onChange={e => setSeverity(e.target.value)}
          className="bg-cohesity-black border border-cohesity-border text-sm text-cohesity-text rounded px-3 py-1.5 focus:border-cohesity-green">
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <label className="sr-only" htmlFor="cluster-filter">Cluster</label>
        <select id="cluster-filter" value={clusterId} onChange={e => handleClusterFilter(e.target.value)}
          className="bg-cohesity-black border border-cohesity-border text-sm text-cohesity-text rounded px-3 py-1.5 focus:border-cohesity-green">
          <option value="">All Clusters</option>
          {clusters.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)}
            className="accent-cohesity-green" />
          Show Dismissed
        </label>

        <span className="text-xs text-gray-500 ml-auto">
          {loading ? '…' : `${alerts.length} alert(s)`}
        </span>
      </div>

      {error && (
        <div role="alert" className="bg-status-crit/10 border border-status-crit/30 text-status-crit rounded-lg p-3 mb-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="panel p-4"><SkeletonTable rows={8} colWidths={['w-4', 'w-28', 'w-16', 'w-20', 'w-48', 'w-20', 'w-14', 'w-12']} /></div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={<AlertEmptyIcon />}
          title="No alerts found"
          message={
            severity || clusterId
              ? 'Try adjusting your filters to see more results.'
              : 'All clusters are running without active alerts.'
          }
          action={
            (severity || clusterId)
              ? { label: 'Clear filters', onClick: () => { setSeverity(''); handleClusterFilter(''); } }
              : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto panel p-4">
            <table className="w-full text-sm border-collapse" aria-label="Alerts table">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-cohesity-border">
                  <th className="pb-2 pr-2 w-8">
                    <input type="checkbox" aria-label="Select all visible alerts"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={() => {
                        if (allSelected) setSelectedIds(new Set());
                        else setSelectedIds(new Set(dismissableAlerts.map(a => a.id)));
                      }}
                      className="accent-cohesity-green w-3.5 h-3.5" />
                  </th>
                  <th className="pb-2 pr-4">Cluster</th>
                  <th className="pb-2 pr-4">Severity</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4 max-w-xs">Description</th>
                  <th className="pb-2 pr-4">First Seen</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map(alert => (
                  <tr key={alert.id} className="border-b border-cohesity-border hover:bg-cohesity-gray transition-colors">
                    <td className="py-2 pr-2">
                      {!alert.dismissed && (
                        <input type="checkbox" aria-label={`Select alert ${alert.id}`}
                          checked={selectedIds.has(alert.id)}
                          onChange={() => toggleSelect(alert.id)}
                          className="accent-cohesity-green w-3.5 h-3.5" />
                      )}
                    </td>
                    <td className="py-2 pr-4 text-cohesity-text">{alert.cluster_name}</td>
                    <td className="py-2 pr-4"><AlertBadge severity={alert.severity} /></td>
                    <td className="py-2 pr-4 text-gray-300">{alert.alert_type || '—'}</td>
                    <td className="py-2 pr-4 max-w-xs">
                      <span className="truncate block text-gray-300" title={alert.description}>
                        {alert.description || '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-400 whitespace-nowrap text-xs">
                      {alert.first_seen ? new Date(alert.first_seen).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {alert.dismissed ? (
                        <span className="text-xs text-gray-500">Dismissed</span>
                      ) : alert.resolved ? (
                        <span className="text-xs text-cohesity-green">Resolved</span>
                      ) : (
                        <span className="text-xs text-amber-400">Open</span>
                      )}
                    </td>
                    <td className="py-2">
                      {!alert.dismissed && (
                        <button type="button" aria-label={`Dismiss alert from ${alert.cluster_name}`}
                          onClick={() => dismiss(alert.id)}
                          className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-red-600 hover:text-red-400 transition-colors">
                          Dismiss
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={safePage}
            totalPages={totalPages}
            pageSize={pageSize}
            onPage={handlePageChange}
            onPageSize={handlePageSize}
            totalItems={alerts.length}
          />
        </>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-surface-raised/95 backdrop-blur border-t border-cohesity-border px-6 py-3 flex items-center gap-3 z-40 shadow-modal">
          <span className="text-sm text-cohesity-text">{selectedIds.size} alert(s) selected</span>
          <div className="flex-1" />
          {bulkDismissConfirm ? (
            <>
              <span className="text-sm text-amber-400">Dismiss {selectedIds.size} alert(s)?</span>
              <button onClick={handleBulkDismiss}
                className="text-xs px-3 py-1.5 bg-red-900 border border-red-700 rounded text-red-200 hover:bg-red-800 transition-colors">
                Confirm Dismiss
              </button>
              <button onClick={() => setBulkDismissConfirm(false)}
                className="text-xs px-3 py-1.5 border border-cohesity-border rounded text-gray-400 hover:text-cohesity-text transition-colors">
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setBulkDismissConfirm(true)}
              className="text-xs px-3 py-1.5 border border-red-800 rounded text-red-400 hover:border-red-500 hover:bg-red-900 hover:bg-opacity-30 transition-colors">
              Dismiss Selected
            </button>
          )}
          <button onClick={() => { setSelectedIds(new Set()); setBulkDismissConfirm(false); }}
            aria-label="Clear selection"
            className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:text-ink transition-colors flex items-center gap-1 cursor-pointer">
            <X size={12} /> Clear
          </button>
        </div>
      )}
    </div>
  );
}
