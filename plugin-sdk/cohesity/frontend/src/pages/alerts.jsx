// Cohesity plugin — Alerts page. Ported from frontend/src/pages/AlertsPage.jsx.
// client (axios) -> apiFetch; useSearchParams -> window.ReactRouterDOM;
// useToast -> ui.jsx's local toast store; AlertBadge/Pagination/EmptyState/
// SkeletonTable from ui.jsx; AlertReviewModal from components.jsx.
import { apiFetch, useToast, PageHeader, AlertBadge, EmptyState, AlertEmptyIcon, SkeletonTable, Pagination, downloadBlob } from '../ui.jsx';
import { Bell, Download, RefreshCw, X, Sparkles, ChevronUp, ChevronDown } from '../icons.jsx';
import { AlertReviewModal } from '../components.jsx';

function exportAlertsCSV(alerts) {
  const headers = ['ID', 'Cluster', 'Severity', 'Type', 'Description', 'First Seen', 'Status'];
  const rows = alerts.map((a) => [
    a.id,
    `"${(a.cluster_name || '').replace(/"/g, '""')}"`,
    a.severity,
    `"${(a.alert_type || '').replace(/"/g, '""')}"`,
    `"${(a.description || '').replace(/"/g, '""')}"`,
    a.first_seen ? new Date(a.first_seen).toISOString() : '',
    a.dismissed ? 'Dismissed' : a.resolved ? 'Resolved' : 'Open',
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `alerts-export-${new Date().toISOString().slice(0, 10)}.csv`);
}

const statusRank = (a) => (a.dismissed ? 2 : a.resolved ? 1 : 0);
const SORTERS = {
  alert_type: (a, b) => String(a.alert_type || '').localeCompare(String(b.alert_type || ''), undefined, { sensitivity: 'base' }),
  description: (a, b) => String(a.description || '').localeCompare(String(b.description || ''), undefined, { sensitivity: 'base' }),
  first_seen: (a, b) => (a.first_seen ? new Date(a.first_seen).getTime() : 0) - (b.first_seen ? new Date(b.first_seen).getTime() : 0),
  status: (a, b) => statusRank(a) - statusRank(b),
};

function SortableTh({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th style={{ paddingBottom: 8, paddingRight: 16 }} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', background: 'none', border: 'none', color: active ? 'var(--co-ink)' : 'var(--co-ink-muted)', padding: 0, fontSize: 'inherit' }}>
        {label}{active && <Arrow size={12} style={{ color: 'var(--co-brand)' }} />}
      </button>
    </th>
  );
}

export default function AlertsPage() {
  const [alerts, setAlerts] = React.useState([]);
  const [clusters, setClusters] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  const [bulkDismissConfirm, setBulkDismissConfirm] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [resolveTarget, setResolveTarget] = React.useState(null);
  const [resolveNote, setResolveNote] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(25);
  const [sort, setSort] = React.useState({ key: 'first_seen', dir: 'desc' });
  const [aiEnabled, setAiEnabled] = React.useState(false);
  const [reviewAlertItem, setReviewAlertItem] = React.useState(null);

  const [searchParams, setSearchParams] = window.ReactRouterDOM.useSearchParams();
  const [severity, setSeverity] = React.useState('');
  const [clusterId, setClusterId] = React.useState(searchParams.get('clusterId') || '');
  const [showDismissed, setShowDismissed] = React.useState(false);
  const [showResolved, setShowResolved] = React.useState(false);

  React.useEffect(() => { setClusterId(searchParams.get('clusterId') || ''); }, [searchParams]);

  const handleClusterFilter = (value) => {
    setClusterId(value);
    setSearchParams(value ? { clusterId: value } : {}, { replace: true });
  };

  const handleSort = (key) => {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'first_seen' ? 'desc' : 'asc' });
    setPage(0);
  };

  const loadAlerts = () => {
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    if (clusterId) params.set('clusterId', clusterId);
    if (showDismissed) params.set('dismissed', '1');
    params.set('resolved', showResolved ? '1' : '0');
    setLoading(true);
    setPage(0);
    apiFetch(`/cohesity/alerts?${params}`)
      .then((data) => { setAlerts(data); setSelectedIds(new Set()); })
      .catch((err) => setError(err.payload?.error || err.message))
      .finally(() => setLoading(false));
  };

  React.useEffect(() => { apiFetch('/cohesity/clusters').then(setClusters).catch(() => {}); }, []);
  React.useEffect(() => { apiFetch('/cohesity/alerts/ai/status').then((d) => setAiEnabled(!!d.enabled)).catch(() => setAiEnabled(false)); }, []);
  React.useEffect(() => { loadAlerts(); }, [severity, clusterId, showDismissed, showResolved]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelect = (id) => setSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const handleBulkDismiss = async () => {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map((id) => apiFetch(`/cohesity/alerts/${id}/dismiss`, { method: 'POST' })));
    const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
    const failed = ids.length - succeeded.length;
    setAlerts((prev) => prev.filter((a) => !succeeded.includes(a.id)));
    setSelectedIds(new Set());
    setBulkDismissConfirm(false);
    setPage(0);
    toast({ type: failed === 0 ? 'success' : 'error', title: failed === 0 ? `${succeeded.length} alert(s) dismissed` : `${succeeded.length} dismissed, ${failed} failed` });
  };

  const dismiss = async (id) => {
    try {
      await apiFetch(`/cohesity/alerts/${id}/dismiss`, { method: 'POST' });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      toast({ type: 'success', title: 'Alert dismissed' });
    } catch { toast({ type: 'error', title: 'Failed to dismiss alert' }); }
  };

  const openResolveSingle = (id) => { setResolveTarget({ type: 'single', id }); setResolveNote(''); };
  const openResolveBulk = () => { setResolveTarget({ type: 'bulk', ids: [...selectedIds] }); setResolveNote(''); };
  const closeResolve = () => { if (!bulkBusy) { setResolveTarget(null); setResolveNote(''); } };

  const resolveSingle = async (id, note) => {
    setBulkBusy(true);
    try {
      await apiFetch(`/cohesity/alerts/${id}/resolve`, { method: 'POST', body: note ? { details: note } : {} });
      setAlerts((prev) => showResolved ? prev.map((a) => (a.id === id ? { ...a, resolved: 1 } : a)) : prev.filter((a) => a.id !== id));
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      toast({ type: 'success', title: 'Alert resolved on cluster' });
      setResolveTarget(null); setResolveNote('');
    } catch (err) { toast({ type: 'error', title: err.payload?.error || 'Failed to resolve alert' }); }
    finally { setBulkBusy(false); }
  };

  const resolveBulk = async (ids, note) => {
    setBulkBusy(true);
    try {
      const data = await apiFetch('/cohesity/alerts/resolve', { method: 'POST', body: { ids, ...(note ? { details: note } : {}) } });
      const resolvedSet = new Set(data.resolved || []);
      setAlerts((prev) => showResolved ? prev.map((a) => (resolvedSet.has(a.id) ? { ...a, resolved: 1 } : a)) : prev.filter((a) => !resolvedSet.has(a.id)));
      setSelectedIds(new Set());
      const failedN = (data.failed || []).length;
      toast({ type: failedN === 0 ? 'success' : 'error', title: failedN === 0 ? `${resolvedSet.size} alert(s) resolved` : `${resolvedSet.size} resolved, ${failedN} failed (check permissions)` });
      setResolveTarget(null); setResolveNote('');
    } catch (err) { toast({ type: 'error', title: err.payload?.error || 'Bulk resolve failed' }); }
    finally { setBulkBusy(false); }
  };

  const confirmResolve = () => {
    if (!resolveTarget) return;
    const note = resolveNote.trim();
    if (resolveTarget.type === 'single') resolveSingle(resolveTarget.id, note);
    else resolveBulk(resolveTarget.ids, note);
  };

  const sortedAlerts = React.useMemo(() => {
    const cmp = SORTERS[sort.key] || SORTERS.first_seen;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...alerts].sort((a, b) => (cmp(a, b) || a.id - b.id) * dir);
  }, [alerts, sort]);

  const totalPages = Math.max(1, Math.ceil(alerts.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = React.useMemo(() => sortedAlerts.slice(safePage * pageSize, (safePage + 1) * pageSize), [sortedAlerts, safePage, pageSize]);

  const dismissableAlerts = pageItems.filter((a) => !a.dismissed);
  const allSelected = dismissableAlerts.length > 0 && dismissableAlerts.every((a) => selectedIds.has(a.id));
  const someSelected = dismissableAlerts.some((a) => selectedIds.has(a.id));

  return (
    <div style={{ position: 'relative' }}>
      <PageHeader icon={Bell} title="Alerts" description="Triage, filter, and dismiss alerts across every monitored cluster">
        {alerts.length > 0 && !loading && (
          <button onClick={() => exportAlertsCSV(sortedAlerts)} className="co-btn-ghost"><Download size={13} /> Export CSV</button>
        )}
        <button onClick={loadAlerts} className="co-btn-ghost"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh</button>
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="co-input" style={{ width: 'auto' }}>
          <option value="">All Severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option>
        </select>
        <select value={clusterId} onChange={(e) => handleClusterFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--co-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} className="accent-cohesity-green" /> Show Dismissed
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--co-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} className="accent-cohesity-green" /> Show Resolved
        </label>
        <span style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{loading ? '…' : `${alerts.length} alert(s)`}</span>
      </div>

      {error && <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--co-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>{error}</div>}

      {loading ? (
        <div className="panel" style={{ padding: 16 }}><SkeletonTable rows={8} cols={8} /></div>
      ) : alerts.length === 0 ? (
        <EmptyState icon={<AlertEmptyIcon />} title="No alerts found"
          message={severity || clusterId ? 'Try adjusting your filters to see more results.' : 'All clusters are running without active alerts.'}
          action={(severity || clusterId) ? { label: 'Clear filters', onClick: () => { setSeverity(''); handleClusterFilter(''); } } : undefined} />
      ) : (
        <>
          <div className="panel" style={{ padding: 16, overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }} aria-label="Alerts table">
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 11, color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
                  <th style={{ paddingBottom: 8, paddingRight: 8, width: 32 }}>
                    <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={() => setSelectedIds(allSelected ? new Set() : new Set(dismissableAlerts.map((a) => a.id)))} className="accent-cohesity-green" />
                  </th>
                  <th style={{ paddingBottom: 8, paddingRight: 16 }}>Cluster</th>
                  <th style={{ paddingBottom: 8, paddingRight: 16 }}>Severity</th>
                  <SortableTh label="Type" sortKey="alert_type" sort={sort} onSort={handleSort} />
                  <SortableTh label="Description" sortKey="description" sort={sort} onSort={handleSort} />
                  <SortableTh label="First Seen" sortKey="first_seen" sort={sort} onSort={handleSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={handleSort} />
                  <th style={{ paddingBottom: 8 }}></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((alert) => (
                  <tr key={alert.id} style={{ borderBottom: '1px solid var(--co-border)' }}>
                    <td style={{ padding: '8px 8px 8px 0' }}>
                      {!alert.dismissed && <input type="checkbox" checked={selectedIds.has(alert.id)} onChange={() => toggleSelect(alert.id)} className="accent-cohesity-green" />}
                    </td>
                    <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)' }}>{alert.cluster_name}</td>
                    <td style={{ padding: '8px 16px 8px 0' }}><AlertBadge severity={alert.severity} /></td>
                    <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{alert.alert_type || '—'}</td>
                    <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', maxWidth: 320 }} title={alert.description}>{alert.description || '—'}</td>
                    <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-faint)', whiteSpace: 'nowrap', fontSize: 11 }}>{alert.first_seen ? new Date(alert.first_seen).toLocaleDateString() : '—'}</td>
                    <td style={{ padding: '8px 16px 8px 0' }}>
                      {alert.dismissed ? <span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>Dismissed</span>
                        : alert.resolved ? <span style={{ fontSize: 11, color: 'var(--co-brand)' }}>Resolved</span>
                        : <span style={{ fontSize: 11, color: 'var(--co-warn)' }}>Open</span>}
                    </td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        {aiEnabled && (
                          <button type="button" onClick={() => setReviewAlertItem(alert)} className="co-btn-ghost" style={{ padding: '4px 8px' }}>
                            <Sparkles size={12} /> AI Review
                          </button>
                        )}
                        {!alert.dismissed && !alert.resolved && (
                          <button type="button" onClick={() => openResolveSingle(alert.id)} className="co-btn-ghost" style={{ padding: '4px 8px' }}>Resolve</button>
                        )}
                        {!alert.dismissed && (
                          <button type="button" onClick={() => dismiss(alert.id)} className="co-btn-ghost" style={{ padding: '4px 8px', color: 'var(--co-crit)' }}>Dismiss</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={safePage} totalPages={totalPages} pageSize={pageSize} onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(0); }} totalItems={alerts.length} />
        </>
      )}

      {selectedIds.size > 0 && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'rgba(24,34,44,.95)', backdropFilter: 'blur(6px)', borderTop: '1px solid var(--co-border)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, zIndex: 40 }} className="shadow-modal">
          <span style={{ fontSize: 13, color: 'var(--co-ink)' }}>{selectedIds.size} alert(s) selected</span>
          <div style={{ flex: 1 }} />
          {bulkDismissConfirm ? (
            <>
              <span style={{ fontSize: 13, color: 'var(--co-warn)' }}>Dismiss {selectedIds.size} alert(s)?</span>
              <button onClick={handleBulkDismiss} className="co-btn-ghost" style={{ background: 'rgba(248,113,113,0.15)', color: 'var(--co-crit)', borderColor: 'rgba(248,113,113,0.4)' }}>Confirm Dismiss</button>
              <button onClick={() => setBulkDismissConfirm(false)} className="co-btn-ghost">Cancel</button>
            </>
          ) : (
            <>
              <button onClick={openResolveBulk} className="co-btn-ghost" style={{ color: 'var(--co-brand)', borderColor: 'rgba(108,179,63,0.5)' }}>Resolve Selected</button>
              <button onClick={() => setBulkDismissConfirm(true)} className="co-btn-ghost" style={{ color: 'var(--co-crit)' }}>Dismiss Selected</button>
            </>
          )}
          <button onClick={() => { setSelectedIds(new Set()); setBulkDismissConfirm(false); }} className="co-btn-ghost"><X size={12} /> Clear</button>
        </div>
      )}

      {reviewAlertItem && <AlertReviewModal alert={reviewAlertItem} onClose={() => setReviewAlertItem(null)} />}

      {resolveTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={closeResolve}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)' }} />
          <div className="panel" style={{ position: 'relative', width: '100%', maxWidth: 400, padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: '0 0 4px' }}>Resolve {resolveTarget.type === 'bulk' ? `${resolveTarget.ids.length} alert(s)` : 'alert'} on cluster</h2>
            <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: '0 0 12px' }}>This closes the alert{resolveTarget.type === 'bulk' ? 's' : ''} in Cohesity. A resolution note is sent with the request.</p>
            <label htmlFor="resolve-note" style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--co-ink-faint)', marginBottom: 4 }}>Resolution note</label>
            <textarea id="resolve-note" rows={3} value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} maxLength={500} placeholder="Resolved from ICC" className="co-input" style={{ resize: 'vertical' }} />
            <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', margin: '4px 0 0' }}>Optional — a default note is sent if left blank.</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={closeResolve} disabled={bulkBusy} className="co-btn-ghost">Cancel</button>
              <button onClick={confirmResolve} disabled={bulkBusy} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.15)', color: 'var(--co-brand)', borderColor: 'rgba(108,179,63,0.4)' }}>{bulkBusy ? 'Resolving…' : 'Resolve'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
