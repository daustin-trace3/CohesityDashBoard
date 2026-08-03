// Proxmox Alerts — the host's shared IssueAlertsPage component isn't
// importable from a plugin bundle (contract note), so this ports a minimal
// equivalent reading GET /api/proxmox/issues (live, bare array) and
// GET /api/proxmox/issue-history (bare array) — no dismiss/resolve actions
// since the host component's persistence model isn't exposed via a plugin
// route in this contract; this is read-only triage, a deliberate
// simplification vs. the host's shared page (noted in the build report).
import {
  injectStyles, PageHeader, Badge, LoadingPanel, EmptyState, RefreshButton,
  useTableControls, SortTh, TableControls, TablePager,
  BellIcon,
} from '../ui.jsx';

injectStyles();

function apiGet(path) {
  return fetch(`/api/proxmox${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const raw = typeof iso === 'string' && !iso.includes('T') ? `${iso}Z`.replace(' ', 'T') : iso;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

const severityTone = (sev) => (sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info');

export default function PxAlertsPage() {
  const [active, setActive] = React.useState(null);
  const [history, setHistory] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [showHistory, setShowHistory] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    return Promise.all([
      apiGet('/issues').then((d) => setActive(Array.isArray(d) ? d : [])).catch(() => setActive([])),
      apiGet('/issue-history').then((d) => setHistory(Array.isArray(d) ? d : [])).catch(() => setHistory([])),
    ]).finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const rows = showHistory ? (history || []) : (active || []);
  const ctl = useTableControls(rows, {
    searchKeys: ['message', 'source', 'severity'],
    defaultSortKey: 'severity',
    defaultSortDir: 'desc',
    sortValues: { severity: (r) => (r.severity === 'critical' ? 2 : r.severity === 'warning' ? 1 : 0) },
    paginate: true,
  });

  const critCount = (active || []).filter((i) => i.severity === 'critical').length;

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={BellIcon} title="Alerts" description="Offline nodes, storage over threshold, failed/stale backups, cert expiry, quorum loss and task failures">
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--px-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
          Show resolved history
        </label>
        {!showHistory && critCount > 0 && <Badge tone="crit">{critCount} critical</Badge>}
        <span className="px-tnum" style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginLeft: 'auto' }}>
          {loading ? '…' : `${rows.length} ${showHistory ? 'historical' : 'open'} issue(s)`}
        </span>
      </div>

      <div className="px-panel" style={{ padding: 16 }}>
        <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by message, source or severity…"
          filters={[{ k: 'severity', label: 'Severities' }, { k: 'source', label: 'Sources' }]} />
        {loading ? (
          <LoadingPanel label="Loading issues…" height={160} />
        ) : rows.length === 0 ? (
          <EmptyState icon={BellIcon} title={showHistory ? 'No historical issues' : 'No issues detected'} description={showHistory ? undefined : 'All registered Proxmox servers are healthy.'} />
        ) : ctl.rows.length === 0 ? (
          <EmptyState title="No issues match your filters" />
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--px-ink-muted)' }}>Severity</th>
                  <SortTh k="source" label="Source" ctl={ctl} />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--px-ink-muted)' }}>Message</th>
                  {showHistory && <SortTh k="resolvedAt" label="Resolved" ctl={ctl} />}
                  {!showHistory && <SortTh k="firstSeen" label="First Seen" ctl={ctl} />}
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={r.id ?? i} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={severityTone(r.severity)}>{r.severity}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{r.source || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)', maxWidth: 420 }}>{r.message || '—'}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {fmtWhen(showHistory ? r.resolvedAt : r.firstSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
