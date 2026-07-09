import { useEffect, useState, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, Download, RefreshCw, X, Sparkles, ChevronUp, ChevronDown } from 'lucide-react';
import client from '../api/client';
import AlertBadge from '../components/AlertBadge';
import AlertReviewModal from '../components/AlertReviewModal';
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

// Status column sorts by lifecycle order rather than alphabetically.
const statusRank = (a) => (a.dismissed ? 2 : a.resolved ? 1 : 0);

const SORTERS = {
  alert_type: (a, b) => String(a.alert_type || '').localeCompare(String(b.alert_type || ''), undefined, { sensitivity: 'base' }),
  description: (a, b) => String(a.description || '').localeCompare(String(b.description || ''), undefined, { sensitivity: 'base' }),
  first_seen: (a, b) => (a.first_seen ? new Date(a.first_seen).getTime() : 0) - (b.first_seen ? new Date(b.first_seen).getTime() : 0),
  status: (a, b) => statusRank(a) - statusRank(b),
};

function SortableTh({ label, sortKey, sort, onSort, className = '' }) {
  const active = sort.key === sortKey;
  const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th
      className={`pb-2 pr-4 ${className}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 cursor-pointer select-none hover:text-cohesity-text transition-colors ${active ? 'text-cohesity-text' : ''}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && <Arrow size={12} className="text-cohesity-green" />}
      </button>
    </th>
  );
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDismissConfirm, setBulkDismissConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resolveTarget, setResolveTarget] = useState(null); // { type:'single', id } | { type:'bulk', ids }
  const [resolveNote, setResolveNote] = useState('');

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // Newest alerts on top by default; column headers toggle key/direction.
  const [sort, setSort] = useState({ key: 'first_seen', dir: 'desc' });
  const handleSort = (key) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'first_seen' ? 'desc' : 'asc' });
    setPage(0);
  };

  const [aiEnabled, setAiEnabled] = useState(false);
  const [reviewAlertItem, setReviewAlertItem] = useState(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const [severity, setSeverity] = useState('');
  const [clusterId, setClusterId] = useState(searchParams.get('clusterId') || '');
  const [showDismissed, setShowDismissed] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

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
    // Hide resolved alerts unless the operator opts in.
    params.set('resolved', showResolved ? '1' : '0');
    setLoading(true);
    setPage(0);
    client
      .get(`/cohesity/alerts?${params}`)
      .then(({ data }) => { setAlerts(data); setSelectedIds(new Set()); })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    client.get('/cohesity/clusters').then(({ data }) => setClusters(data)).catch(() => {});
  }, []);

  useEffect(() => {
    client.get('/cohesity/alerts/ai/status')
      .then(({ data }) => setAiEnabled(!!data.enabled))
      .catch(() => setAiEnabled(false));
  }, []);

  useEffect(() => { loadAlerts(); }, [severity, clusterId, showDismissed, showResolved]);

  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleBulkDismiss = async () => {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map(id => client.post(`/cohesity/alerts/${id}/dismiss`)));
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
      await client.post(`/cohesity/alerts/${id}/dismiss`);
      setAlerts(prev => prev.filter(a => a.id !== id));
      showToast('Alert dismissed');
    } catch {
      showToast('Failed to dismiss alert', 'error');
    }
  };

  // Resolve closes the alert(s) upstream on the cluster. Cohesity requires a
  // resolution note; the modal lets the operator supply one (or we send a
  // default if left blank).
  const openResolveSingle = (id) => { setResolveTarget({ type: 'single', id }); setResolveNote(''); };
  const openResolveBulk = () => { setResolveTarget({ type: 'bulk', ids: [...selectedIds] }); setResolveNote(''); };
  const closeResolve = () => { if (!bulkBusy) { setResolveTarget(null); setResolveNote(''); } };

  const resolveSingle = async (id, note) => {
    setBulkBusy(true);
    try {
      await client.post(`/cohesity/alerts/${id}/resolve`, note ? { details: note } : {});
      setAlerts(prev => showResolved
        ? prev.map(a => (a.id === id ? { ...a, resolved: 1 } : a))
        : prev.filter(a => a.id !== id));
      setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      showToast('Alert resolved on cluster');
      setResolveTarget(null); setResolveNote('');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to resolve alert', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const resolveBulk = async (ids, note) => {
    setBulkBusy(true);
    try {
      const { data } = await client.post('/cohesity/alerts/resolve', { ids, ...(note ? { details: note } : {}) });
      const resolvedSet = new Set(data.resolved || []);
      setAlerts(prev => showResolved
        ? prev.map(a => (resolvedSet.has(a.id) ? { ...a, resolved: 1 } : a))
        : prev.filter(a => !resolvedSet.has(a.id)));
      setSelectedIds(new Set());
      const failedN = (data.failed || []).length;
      if (failedN === 0) showToast(`${resolvedSet.size} alert(s) resolved`);
      else showToast(`${resolvedSet.size} resolved, ${failedN} failed (check permissions)`, 'error');
      setResolveTarget(null); setResolveNote('');
    } catch (err) {
      showToast(err.response?.data?.error || 'Bulk resolve failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmResolve = () => {
    if (!resolveTarget) return;
    const note = resolveNote.trim();
    if (resolveTarget.type === 'single') resolveSingle(resolveTarget.id, note);
    else resolveBulk(resolveTarget.ids, note);
  };

  const handlePageSize = (s) => { setPageSize(s); setPage(0); };
  const handlePageChange = (p) => {
    setPage(p);
    tableTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const sortedAlerts = useMemo(() => {
    const cmp = SORTERS[sort.key] || SORTERS.first_seen;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Stable tiebreak on id so equal rows don't jump between renders.
    return [...alerts].sort((a, b) => (cmp(a, b) || a.id - b.id) * dir);
  }, [alerts, sort]);

  const totalPages = Math.max(1, Math.ceil(alerts.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = useMemo(
    () => sortedAlerts.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [sortedAlerts, safePage, pageSize]
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
            onClick={() => exportAlertsCSV(sortedAlerts)}
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

        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)}
            className="accent-cohesity-green" />
          Show Resolved
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
                  <SortableTh label="Type" sortKey="alert_type" sort={sort} onSort={handleSort} />
                  <SortableTh label="Description" sortKey="description" sort={sort} onSort={handleSort} className="max-w-xs" />
                  <SortableTh label="First Seen" sortKey="first_seen" sort={sort} onSort={handleSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={handleSort} />
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
                      <div className="flex items-center gap-1.5 justify-end">
                        {aiEnabled && (
                          <button type="button" aria-label={`AI review of alert from ${alert.cluster_name}`}
                            onClick={() => setReviewAlertItem(alert)}
                            className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-brand hover:text-brand transition-colors flex items-center gap-1">
                            <Sparkles size={12} />
                            AI Review
                          </button>
                        )}
                        {!alert.dismissed && !alert.resolved && (
                          <button type="button" aria-label={`Resolve alert from ${alert.cluster_name} on cluster`}
                            onClick={() => openResolveSingle(alert.id)}
                            className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors">
                            Resolve
                          </button>
                        )}
                        {!alert.dismissed && (
                          <button type="button" aria-label={`Dismiss alert from ${alert.cluster_name}`}
                            onClick={() => dismiss(alert.id)}
                            className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-red-600 hover:text-red-400 transition-colors">
                            Dismiss
                          </button>
                        )}
                      </div>
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
            <>
              <button onClick={openResolveBulk}
                className="text-xs px-3 py-1.5 border border-cohesity-green/50 rounded text-cohesity-green hover:bg-cohesity-green/20 transition-colors">
                Resolve Selected
              </button>
              <button onClick={() => setBulkDismissConfirm(true)}
                className="text-xs px-3 py-1.5 border border-red-800 rounded text-red-400 hover:border-red-500 hover:bg-red-900 hover:bg-opacity-30 transition-colors">
                Dismiss Selected
              </button>
            </>
          )}
          <button onClick={() => { setSelectedIds(new Set()); setBulkDismissConfirm(false); }}
            aria-label="Clear selection"
            className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:text-ink transition-colors flex items-center gap-1 cursor-pointer">
            <X size={12} /> Clear
          </button>
        </div>
      )}

      {reviewAlertItem && (
        <AlertReviewModal alert={reviewAlertItem} onClose={() => setReviewAlertItem(null)} />
      )}

      {resolveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={closeResolve}>
          <div className="panel w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-sm font-bold text-ink mb-1">
              Resolve {resolveTarget.type === 'bulk' ? `${resolveTarget.ids.length} alert(s)` : 'alert'} on cluster
            </h2>
            <p className="text-[11px] text-ink-muted mb-3">
              This closes the alert{resolveTarget.type === 'bulk' ? 's' : ''} in Cohesity. A resolution note is sent with the request.
            </p>
            <label htmlFor="resolve-note" className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Resolution note</label>
            <textarea id="resolve-note" rows={3} value={resolveNote} onChange={e => setResolveNote(e.target.value)}
              maxLength={500} placeholder="Resolved from Cohesity Dashboard"
              className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none resize-y" />
            <p className="text-[10px] text-ink-faint mt-1">Optional — a default note is sent if left blank.</p>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={closeResolve} disabled={bulkBusy}
                className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:text-ink transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={confirmResolve} disabled={bulkBusy}
                className="text-xs px-3 py-1.5 bg-cohesity-green/20 border border-cohesity-green/50 rounded-lg text-cohesity-green hover:bg-cohesity-green/30 transition-colors disabled:opacity-50">
                {bulkBusy ? 'Resolving…' : 'Resolve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
