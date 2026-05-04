import { useEffect, useState } from 'react';
import client from '../api/client';
import AlertBadge from '../components/AlertBadge';

export default function AlertsPage() {
  const [alerts, setAlerts] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDismissConfirm, setBulkDismissConfirm] = useState(false);

  // Filters
  const [severity, setSeverity] = useState('');
  const [clusterId, setClusterId] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAlerts = () => {
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    if (clusterId) params.set('clusterId', clusterId);
    if (showDismissed) params.set('dismissed', '1');
    setLoading(true);
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
    try {
      await Promise.all(ids.map(id => client.post(`/alerts/${id}/dismiss`)));
      setAlerts(prev => prev.filter(a => !ids.includes(a.id)));
      setSelectedIds(new Set());
      setBulkDismissConfirm(false);
      showToast(`${ids.length} alert(s) dismissed`);
    } catch {
      showToast('Failed to dismiss some alerts', 'error');
    }
  };

  const dismiss = async (id) => {
    try {
      await client.post(`/alerts/${id}/dismiss`);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      showToast('Alert dismissed');
    } catch {
      showToast('Failed to dismiss alert', 'error');
    }
  };

  return (
    <div className="relative">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm font-medium ${
            toast.type === 'error' ? 'bg-red-900 text-red-200' : 'bg-cohesity-green text-cohesity-black'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-cohesity-text">Alerts</h2>
        <button
          onClick={loadAlerts}
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded hover:border-cohesity-green text-gray-400 hover:text-cohesity-green transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="bg-cohesity-black border border-cohesity-border text-sm text-cohesity-text rounded px-3 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <select
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          className="bg-cohesity-black border border-cohesity-border text-sm text-cohesity-text rounded px-3 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="">All Clusters</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
            className="accent-cohesity-green"
          />
          Show Dismissed
        </label>

        <span className="text-xs text-gray-500 ml-auto">{alerts.length} alert(s)</span>
      </div>

      {error && (
        <div className="bg-red-900 border border-red-700 text-red-300 rounded p-3 mb-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm text-center mt-8">Loading alerts...</div>
      ) : alerts.length === 0 ? (
        <div className="text-gray-500 text-sm text-center mt-8">No alerts found.</div>
      ) : (
        <div className="overflow-x-auto">
          {(() => {
            const dismissableAlerts = alerts.filter(a => !a.dismissed);
            const allSelected = dismissableAlerts.length > 0 && dismissableAlerts.every(a => selectedIds.has(a.id));
            const someSelected = dismissableAlerts.some(a => selectedIds.has(a.id));
            return (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-cohesity-border">
                <th className="pb-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => {
                      if (allSelected) {
                        setSelectedIds(new Set());
                      } else {
                        setSelectedIds(new Set(dismissableAlerts.map(a => a.id)));
                      }
                    }}
                    className="accent-cohesity-green w-3.5 h-3.5"
                  />
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
              {alerts.map((alert) => (
                <tr
                  key={alert.id}
                  className="border-b border-cohesity-border hover:bg-cohesity-gray transition-colors"
                >
                  <td className="py-2 pr-2">
                    {!alert.dismissed && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(alert.id)}
                        onChange={() => toggleSelect(alert.id)}
                        className="accent-cohesity-green w-3.5 h-3.5"
                      />
                    )}
                  </td>
                  <td className="py-2 pr-4 text-cohesity-text">{alert.cluster_name}</td>
                  <td className="py-2 pr-4">
                    <AlertBadge severity={alert.severity} />
                  </td>
                  <td className="py-2 pr-4 text-gray-300">{alert.alert_type || '—'}</td>
                  <td className="py-2 pr-4 max-w-xs">
                    <span className="truncate block text-gray-300" title={alert.description}>
                      {alert.description || '—'}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">
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
                      <button
                        onClick={() => dismiss(alert.id)}
                        className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-red-600 hover:text-red-400 transition-colors"
                      >
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            );
          })()}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-cohesity-black border-t border-cohesity-border px-6 py-3 flex items-center gap-3 z-40 shadow-lg">
          <span className="text-sm text-cohesity-text">{selectedIds.size} alert(s) selected</span>
          <div className="flex-1" />
          {bulkDismissConfirm ? (
            <>
              <span className="text-sm text-amber-400">Dismiss {selectedIds.size} alert(s)?</span>
              <button
                onClick={handleBulkDismiss}
                className="text-xs px-3 py-1.5 bg-red-900 border border-red-700 rounded text-red-200 hover:bg-red-800 transition-colors"
              >
                Confirm Dismiss
              </button>
              <button
                onClick={() => setBulkDismissConfirm(false)}
                className="text-xs px-3 py-1.5 border border-cohesity-border rounded text-gray-400 hover:text-cohesity-text transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setBulkDismissConfirm(true)}
              className="text-xs px-3 py-1.5 border border-red-800 rounded text-red-400 hover:border-red-500 hover:bg-red-900 hover:bg-opacity-30 transition-colors"
            >
              Dismiss Selected
            </button>
          )}
          <button
            onClick={() => { setSelectedIds(new Set()); setBulkDismissConfirm(false); }}
            className="text-xs px-3 py-1.5 border border-cohesity-border rounded text-gray-400 hover:text-cohesity-text transition-colors"
          >
            ✕ Clear
          </button>
        </div>
      )}
    </div>
  );
}
