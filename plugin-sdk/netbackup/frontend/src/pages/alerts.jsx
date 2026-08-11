// NetBackup Alerts — the host's shared IssueAlertsPage component isn't
// importable from a plugin bundle (contract note), so this ports a minimal
// equivalent reading GET /api/netbackup/issues (bare array or {issues}) and
// GET /api/netbackup/issue-history?days=N — no dismiss/resolve actions since
// the host component's persistence model isn't exposed via a plugin route in
// this contract; deliberate simplification vs. the host's shared page,
// flagged in the build report.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, EmptyState, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  BellIcon,
} from '../ui.jsx';
import { fmtWhen, apiGet } from './helpers.js';

injectStyles();

const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const sevTone = (sev) => (sev === 'critical' || sev === 'error' ? 'crit' : sev === 'warning' ? 'warn' : 'info');

function CurrentIssuesPanel({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, { searchKeys: ['message', 'type', 'target', 'source'], defaultSortKey: 'severity', defaultSortDir: 'asc', paginate: true });
  const csvColumns = [
    { label: 'Severity', get: 'severity' }, { label: 'Type', get: 'type' },
    { label: 'Primary Server', get: 'source' }, { label: 'Target', get: 'target' }, { label: 'Message', get: 'message' },
  ];
  return (
    <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: '3px solid var(--nb-brand)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)' }}>Open Issues <span style={{ color: 'var(--nb-ink-faint)', fontWeight: 400 }}>— current state, recomputed on every request</span></div>
        <CsvExportButton filename="netbackup-issues" rows={ctl.rows} columns={csvColumns} />
      </div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, type or target…"
        filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }, { k: 'source', label: 'Primary Servers' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading issues…" height={140} />
      ) : list.length === 0 ? (
        <EmptyState title="No open issues" description="All registered NetBackup sources are healthy." />
      ) : ctl.rows.length === 0 ? (
        <EmptyState title="No issues match your filters" />
      ) : (
        <div className="nb-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="source" label="Primary Server" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--nb-ink-muted)' }}>Message</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((i, idx) => (
                <tr key={`${i.type}|${i.target}|${idx}`} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                  <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={sevTone(i.severity)}>{i.severity}</Badge></td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{i.type || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', whiteSpace: 'nowrap' }}>{i.source || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.target || ''}>{i.target || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', maxWidth: 420 }}>{i.message || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

function HistoryPanel({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, { searchKeys: ['message', 'type', 'target', 'source'], defaultSortKey: 'first_seen', defaultSortDir: 'desc', paginate: true });
  return (
    <div className="nb-panel" style={{ padding: 16, borderTop: '3px solid var(--nb-brand)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 8 }}>Issue History <span style={{ color: 'var(--nb-ink-faint)', fontWeight: 400 }}>— when each issue was first detected and when it resolved</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter history…"
        filters={[{ k: 'status', label: 'Statuses' }, { k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading history…" height={140} />
      ) : list.length === 0 ? (
        <EmptyState title="No issue history in the selected window" />
      ) : ctl.rows.length === 0 ? (
        <EmptyState title="No history matches your filters" />
      ) : (
        <div className="nb-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
              <SortTh k="status" label="Status" ctl={ctl} />
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--nb-ink-muted)' }}>Message</th>
              <SortTh k="first_seen" label="First Seen" ctl={ctl} />
              <SortTh k="resolved_at" label="Resolved" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((h) => (
                <tr key={h.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                  <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={h.status === 'open' ? 'crit' : 'ok'}>{h.status}</Badge></td>
                  <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={sevTone(h.severity)}>{h.severity || '—'}</Badge></td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{h.type || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.target || ''}>{h.target || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 12, maxWidth: 380 }}>{h.message || '—'}</td>
                  <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtWhen(h.first_seen)}</td>
                  <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{h.status === 'open' ? '—' : fmtWhen(h.resolved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

export default function NbAlertsPage() {
  const [issues, setIssues] = React.useState(null);
  const [history, setHistory] = React.useState(null);
  const [days, setDays] = React.useState(30);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiGet('/issues').then((d) => setIssues(Array.isArray(d) ? d : d?.issues || [])).catch(() => setIssues([])),
    apiGet('/issue-history', { days }).then((d) => setHistory(Array.isArray(d) ? d : d?.history || [])).catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date())), [days]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={BellIcon} title="Alerts" description="Computed issues across all registered NetBackup sources, with open/resolved history">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} className={`nb-pill${days === r.days ? ' nb-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>{r.label}</button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={issues == null} />
      </PageHeader>
      <CurrentIssuesPanel rows={issues} />
      <HistoryPanel rows={history} />
    </div>
  );
}
