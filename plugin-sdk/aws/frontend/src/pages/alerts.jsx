// AWS Alerts — ported from the built-in AwsAlertsPage.jsx, which delegated
// to the shared components/IssueAlertsPage.jsx (not importable in a plugin
// sandbox — same treatment Dell's alerts.jsx gave its vendor-alert page).
// Reimplemented self-contained here for the 'aws' config only: computed
// issues with open/resolved history, GET /api/aws/issues + /api/aws/issue-history.
import { Bell } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton, BRAND,
} from '../ui.jsx';

const sevTone = (sev) => (sev === 'critical' || sev === 'error') ? 'crit' : sev === 'warning' ? 'warn' : 'info';

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function CurrentIssuesPanel({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'account'],
    defaultSortKey: 'severity', defaultSortDir: 'asc',
    paginate: true,
  });
  const csvColumns = [
    { label: 'Severity', get: (i) => i.severity },
    { label: 'Type', get: (i) => i.type },
    { label: 'Account', get: (i) => i.account },
    { label: 'Target', get: (i) => i.target },
    { label: 'Message', get: (i) => i.message },
  ];
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-ink">Open Issues <span className="text-ink-faint font-normal">— current state, recomputed on every request</span></div>
        <CsvExportButton filename="aws-issues" rows={ctl.rows} columns={csvColumns} />
      </div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, type or target…"
        filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }, { k: 'account', label: 'Accounts' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading issues…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">No open issues.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No issues match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="account" label="Account" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th className="py-2 pr-3">Message</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((i, idx) => (
                <tr key={`${i.type}|${i.target}|${idx}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3"><Badge tone={sevTone(i.severity)}>{i.severity}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{i.type || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i.account || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[220px] truncate" title={i.target || ''}>{i.target || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-xs max-w-[460px]">{i.message || '—'}</td>
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
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'account'],
    defaultSortKey: 'lastSeen', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Issue History <span className="text-ink-faint font-normal">— when each issue was first detected and when it resolved</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter history…"
        filters={[{ k: 'status', label: 'Statuses' }, { k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading history…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No issue history in the selected window.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No history matches your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="status" label="Status" ctl={ctl} />
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th className="py-2 pr-3">Message</th>
              <SortTh k="firstSeen" label="First Seen" ctl={ctl} />
              <SortTh k="resolvedAt" label="Resolved" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((h) => (
                <tr key={h.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3"><Badge tone={h.status === 'open' ? 'crit' : 'ok'}>{h.status}</Badge></td>
                  <td className="py-2 pr-3"><Badge tone={sevTone(h.severity)}>{h.severity || '—'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{h.type || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[200px] truncate" title={h.target || ''}>{h.target || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-xs max-w-[380px]">{h.message || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(h.firstSeen)}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{h.status === 'open' ? '—' : fmtWhen(h.resolvedAt)}</td>
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

export default function AwsAlertsPage() {
  const [issues, setIssues] = React.useState(null);
  const [history, setHistory] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  // /api/aws/issue-history takes no query params — it returns the full
  // lifecycle table (open + resolved), most-recent-first.
  const load = React.useCallback(() => Promise.all([
    apiFetch('/aws/issues').then((json) => setIssues(Array.isArray(json) ? json : json?.issues || [])),
    apiFetch('/aws/issue-history').then((json) => setHistory(Array.isArray(json) ? json : [])).catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setIssues([])), []);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Alerts" description="Computed issues across AWS accounts, with open/resolved history">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <CurrentIssuesPanel rows={issues} />
      <HistoryPanel rows={history} />
    </div>
  );
}
