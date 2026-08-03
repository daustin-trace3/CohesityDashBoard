// Rubrik v2.0.0 Alerts page — mirrors host frontend/src/pages/AlertsPage.jsx
// layout/behavior using ONLY the rbk- kit (./ui, ./charts). Styled entirely
// via kit primitives + inline styles (no Tailwind, no host imports).

import {
  PageHeader, Badge, SkeletonTable, EmptyState, TablePager, CsvExportButton,
  useTableControls, SortTh, RefreshButton,
  BellIcon, XIcon,
} from '../ui';

const API_BASE = '/api/rubrik';

function apiFetch(path, opts) {
  return fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then((res) => {
    if (!res.ok) return res.json().catch(() => ({})).then((body) => { throw new Error(body.error || `request failed: ${res.status}`); });
    return res.json();
  });
}

const statusRank = (a) => (a.dismissed ? 2 : a.resolved ? 1 : 0);

// FLAG (kit gap): ui.jsx's Badge component takes no className, so it can't
// carry the .rbk-pulse-crit animation on its own. Wrapping it in a span with
// that class reproduces the same subtle pulsing-ring look the host's
// AlertBadge gives critical severities, without touching ui.jsx.
function SeverityBadge({ severity }) {
  const tone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'info';
  const label = severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : '—';
  return (
    <span className={severity === 'critical' ? 'rbk-pulse-crit' : ''} style={{ display: 'inline-block', borderRadius: 999 }}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

function StatusCell({ alert }) {
  if (alert.dismissed) return <span style={{ fontSize: 11, color: 'var(--rbk-ink-faint)' }}>Dismissed</span>;
  if (alert.resolved) return <span style={{ fontSize: 11, color: 'var(--rbk-ok)' }}>Resolved</span>;
  return <span style={{ fontSize: 11, color: 'var(--rbk-warn)' }}>Open</span>;
}

function formatDate(iso) {
  if (!iso) return '—';
  const raw = typeof iso === 'string' && !iso.includes('T') ? iso.replace(' ', 'T') + 'Z' : iso;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

export default function AlertsPage() {
  const [alerts, setAlerts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [severity, setSeverity] = React.useState('');
  const [showDismissed, setShowDismissed] = React.useState(false);
  const [showResolved, setShowResolved] = React.useState(false);

  const [selectedIds, setSelectedIds] = React.useState(new Set());
  const [bulkDismissConfirm, setBulkDismissConfirm] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [resolveTarget, setResolveTarget] = React.useState(null); // { type:'single', id } | { type:'bulk', ids }
  const [resolveNote, setResolveNote] = React.useState('');

  const loadAlerts = React.useCallback(() => {
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    params.set('dismissed', showDismissed ? '1' : '0');
    params.set('resolved', showResolved ? '1' : '0');
    setLoading(true);
    setError(null);
    apiFetch(`/alerts?${params}`)
      .then((data) => { setAlerts(Array.isArray(data) ? data : (data && data.rows) || []); setSelectedIds(new Set()); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [severity, showDismissed, showResolved]);

  React.useEffect(() => { loadAlerts(); }, [loadAlerts]);

  const clusterOptions = React.useMemo(
    () => [...new Set(alerts.map((a) => a.cluster).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [alerts]
  );
  const [cluster, setCluster] = React.useState('');
  const clusterFilteredAlerts = React.useMemo(
    () => (cluster ? alerts.filter((a) => a.cluster === cluster) : alerts),
    [alerts, cluster]
  );

  const ctl = useTableControls(clusterFilteredAlerts, {
    defaultSortKey: 'firstSeen',
    defaultSortDir: 'desc',
    sortValues: {
      status: statusRank,
      firstSeen: (a) => (a.firstSeen ? new Date(a.firstSeen.replace(' ', 'T') + 'Z').getTime() : 0),
    },
    paginate: true,
    defaultPageSize: 25,
  });
  const clusterFiltered = ctl.rows;
  const pageRows = ctl.pageRows;

  const dismissableRows = pageRows.filter((a) => !a.dismissed);
  const allSelected = dismissableRows.length > 0 && dismissableRows.every((a) => selectedIds.has(a.id));
  const someSelected = dismissableRows.some((a) => selectedIds.has(a.id));

  const toggleSelect = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const dismiss = (id) => {
    apiFetch(`/alerts/${id}/dismiss`, { method: 'POST' })
      .then(() => setAlerts((prev) => prev.filter((a) => a.id !== id)))
      .catch(() => {});
  };

  const handleBulkDismiss = async () => {
    const ids = [...selectedIds];
    setBulkBusy(true);
    const results = await Promise.allSettled(ids.map((id) => apiFetch(`/alerts/${id}/dismiss`, { method: 'POST' })));
    const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
    setAlerts((prev) => prev.filter((a) => !succeeded.includes(a.id)));
    setSelectedIds(new Set());
    setBulkDismissConfirm(false);
    setBulkBusy(false);
  };

  const openResolveSingle = (id) => { setResolveTarget({ type: 'single', id }); setResolveNote(''); };
  const openResolveBulk = () => { setResolveTarget({ type: 'bulk', ids: [...selectedIds] }); setResolveNote(''); };
  const closeResolve = () => { if (!bulkBusy) { setResolveTarget(null); setResolveNote(''); } };

  const confirmResolve = async () => {
    if (!resolveTarget) return;
    const note = resolveNote.trim();
    setBulkBusy(true);
    try {
      if (resolveTarget.type === 'single') {
        await apiFetch(`/alerts/${resolveTarget.id}/resolve`, { method: 'POST', body: JSON.stringify(note ? { details: note } : {}) });
        setAlerts((prev) => showResolved
          ? prev.map((a) => (a.id === resolveTarget.id ? { ...a, resolved: 1 } : a))
          : prev.filter((a) => a.id !== resolveTarget.id));
        setSelectedIds((prev) => { const n = new Set(prev); n.delete(resolveTarget.id); return n; });
      } else {
        const data = await apiFetch('/alerts/resolve', { method: 'POST', body: JSON.stringify({ ids: resolveTarget.ids, ...(note ? { details: note } : {}) }) });
        const resolvedSet = new Set(data.resolved || resolveTarget.ids);
        setAlerts((prev) => showResolved
          ? prev.map((a) => (resolvedSet.has(a.id) ? { ...a, resolved: 1 } : a))
          : prev.filter((a) => !resolvedSet.has(a.id)));
        setSelectedIds(new Set());
      }
      setResolveTarget(null);
      setResolveNote('');
    } catch {
      // surfaced via alerts list staying unchanged; no toast primitive in kit
    } finally {
      setBulkBusy(false);
    }
  };

  const clearFilters = () => { setSeverity(''); setCluster(''); };

  return (
    <div className="rbk-root rbk-fade-in" style={{ position: 'relative' }}>
      <PageHeader icon={BellIcon} title="Alerts" description="Triage, filter, and dismiss alerts across every monitored cluster">
        <CsvExportButton
          filename="rubrik-alerts"
          rows={clusterFiltered}
          columns={[
            { label: 'ID', get: 'id' },
            { label: 'Cluster', get: 'cluster' },
            { label: 'Severity', get: 'severity' },
            { label: 'Type', get: 'alertType' },
            { label: 'Description', get: 'description' },
            { label: 'First Seen', get: 'firstSeen' },
            { label: 'Status', get: (a) => (a.dismissed ? 'Dismissed' : a.resolved ? 'Resolved' : 'Open') },
          ]}
        />
        <RefreshButton onClick={loadAlerts} refreshing={loading} />
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <select value={cluster} onChange={(e) => setCluster(e.target.value)} className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All Clusters</option>
          {clusterOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--rbk-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
          Show Dismissed
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--rbk-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show Resolved
        </label>

        <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
          {loading ? '…' : `${clusterFiltered.length} alert(s)`}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <SkeletonTable rows={8} colWidths={['3%', '14%', '10%', '10%', '28%', '10%', '10%', '15%']} />
        </div>
      ) : clusterFiltered.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <EmptyState
            icon={BellIcon}
            title="No alerts found"
            description={severity || cluster ? 'Try adjusting your filters to see more results.' : 'All clusters are running without active alerts.'}
          >
            {(severity || cluster) && (
              <button onClick={clearFilters} className="rbk-btn-ghost" style={{ marginTop: 4 }}>Clear filters</button>
            )}
          </EmptyState>
        </div>
      ) : (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  <th style={{ padding: '8px 8px 8px 0', width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all visible alerts"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={() => {
                        if (allSelected) setSelectedIds(new Set());
                        else setSelectedIds(new Set(dismissableRows.map((a) => a.id)));
                      }}
                    />
                  </th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Cluster</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Severity</th>
                  <SortTh k="alertType" label="Type" ctl={ctl} />
                  <SortTh k="description" label="Description" ctl={ctl} />
                  <SortTh k="firstSeen" label="First Seen" ctl={ctl} />
                  <SortTh k="status" label="Status" ctl={ctl} />
                  <th style={{ padding: '8px 0' }} />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((alert) => (
                  <tr key={alert.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                    <td style={{ padding: '8px 8px 8px 0' }}>
                      {!alert.dismissed && (
                        <input type="checkbox" aria-label={`Select alert ${alert.id}`} checked={selectedIds.has(alert.id)} onChange={() => toggleSelect(alert.id)} />
                      )}
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{alert.cluster}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><SeverityBadge severity={alert.severity} /></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{alert.alertType || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', maxWidth: 320 }}>
                      <span title={alert.description} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--rbk-ink-muted)' }}>
                        {alert.description || '—'}
                      </span>
                    </td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDate(alert.firstSeen)}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><StatusCell alert={alert} /></td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        {!alert.dismissed && !alert.resolved && (
                          <button type="button" onClick={() => openResolveSingle(alert.id)} className="rbk-btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>
                            Resolve
                          </button>
                        )}
                        {!alert.dismissed && (
                          <button type="button" onClick={() => dismiss(alert.id)} className="rbk-btn-ghost" style={{ fontSize: 11, padding: '4px 8px', color: 'var(--rbk-crit)', borderColor: 'rgba(248,113,113,0.3)' }}>
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
          <TablePager ctl={ctl} />
        </div>
      )}

      {selectedIds.size > 0 && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'rgba(19,27,35,0.95)', backdropFilter: 'blur(8px)', borderTop: '1px solid var(--rbk-border)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, zIndex: 40, boxShadow: '0 -8px 24px rgba(0,0,0,0.4)' }}>
          <span style={{ fontSize: 13, color: 'var(--rbk-ink)' }}>{selectedIds.size} alert(s) selected</span>
          <div style={{ flex: 1 }} />
          {bulkDismissConfirm ? (
            <>
              <span style={{ fontSize: 13, color: 'var(--rbk-warn)' }}>Dismiss {selectedIds.size} alert(s)?</span>
              <button onClick={handleBulkDismiss} disabled={bulkBusy} className="rbk-btn-ghost" style={{ color: 'var(--rbk-crit)', borderColor: 'rgba(248,113,113,0.4)' }}>
                Confirm Dismiss
              </button>
              <button onClick={() => setBulkDismissConfirm(false)} className="rbk-btn-ghost">Cancel</button>
            </>
          ) : (
            <>
              <button onClick={openResolveBulk} className="rbk-btn-accent">Resolve Selected</button>
              <button onClick={() => setBulkDismissConfirm(true)} className="rbk-btn-ghost" style={{ color: 'var(--rbk-crit)', borderColor: 'rgba(248,113,113,0.4)' }}>
                Dismiss Selected
              </button>
            </>
          )}
          <button onClick={() => { setSelectedIds(new Set()); setBulkDismissConfirm(false); }} className="rbk-btn-ghost">
            <XIcon size={12} /> Clear
          </button>
        </div>
      )}

      {resolveTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', padding: 16 }} onClick={closeResolve}>
          <div className="rbk-panel" style={{ width: '100%', maxWidth: 448, padding: 20, boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)', margin: '0 0 4px' }}>
              Resolve {resolveTarget.type === 'bulk' ? `${resolveTarget.ids.length} alert(s)` : 'alert'} on cluster
            </h2>
            <p style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: '0 0 12px' }}>
              This closes the alert{resolveTarget.type === 'bulk' ? 's' : ''} in Rubrik. A resolution note is sent with the request.
            </p>
            <label htmlFor="rbk-resolve-note" style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-faint)', marginBottom: 4 }}>
              Resolution note
            </label>
            <textarea
              id="rbk-resolve-note"
              rows={3}
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              maxLength={500}
              placeholder="Resolved from ICC"
              className="rbk-input"
              style={{ resize: 'vertical' }}
            />
            <p style={{ fontSize: 10, color: 'var(--rbk-ink-faint)', margin: '4px 0 0' }}>Optional — a default note is sent if left blank.</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={closeResolve} disabled={bulkBusy} className="rbk-btn-ghost">Cancel</button>
              <button onClick={confirmResolve} disabled={bulkBusy} className="rbk-btn-accent">
                {bulkBusy ? 'Resolving…' : 'Resolve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
