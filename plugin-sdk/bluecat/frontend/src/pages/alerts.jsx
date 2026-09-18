// Issue Alerts - the host's IssueAlertsPage (frontend/src/components/
// IssueAlertsPage.jsx) is not importable into the plugin sandbox; per the
// conversion contract this is a minimal read-only issues + history view
// against /api/bluecat/issues + /api/bluecat/issue-history, following the
// plugin-sdk/brocade/frontend/src/pages/issues.jsx pattern (itself modeled
// on dell's alerts.jsx).
import { ClipboardCheck } from '../icons.jsx';
import client from '../api.js';
import {
  useToast, PageHeader, Badge, LoadingPanel, ErrorPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtWhen, severityTone,
} from '../ui.jsx';

const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];

function CurrentIssuesPanel({ rows, failed, onRetry }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'source'],
    defaultSortKey: 'severity', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Open Issues <span className="text-ink-faint font-normal">- current state, recomputed on every request</span></div>
      {failed ? (
        <ErrorPanel label="Failed to load issues." onRetry={onRetry} height={140} />
      ) : (
        <>
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, type or target..."
            filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }, { k: 'source', label: 'Sources' }]} />
          {rows == null ? (
            <LoadingPanel label="Loading issues..." height={140} />
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
                  <SortTh k="source" label="Source" ctl={ctl} />
                  <SortTh k="target" label="Target" ctl={ctl} />
                  <th className="py-2 pr-3">Message</th>
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((i, idx) => (
                    <tr key={`${i.type}|${i.target}|${idx}`} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><Badge tone={severityTone(i.severity)}>{i.severity}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{i.type || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i.source || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted max-w-[220px] truncate" title={i.target || ''}>{i.target || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-xs max-w-[460px]">{i.message || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

function HistoryPanel({ rows, failed, onRetry }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'source'],
    defaultSortKey: 'first_seen', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Issue History <span className="text-ink-faint font-normal">- when each issue was first detected and when it resolved</span></div>
      {failed ? (
        <ErrorPanel label="Failed to load issue history." onRetry={onRetry} height={140} />
      ) : (
        <>
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter history..."
            filters={[{ k: 'status', label: 'Statuses' }, { k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }]} />
          {rows == null ? (
            <LoadingPanel label="Loading history..." height={140} />
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
                  <SortTh k="first_seen" label="First Seen" ctl={ctl} />
                  <SortTh k="resolved_at" label="Resolved" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((h) => (
                    <tr key={h.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><Badge tone={h.status === 'open' ? 'crit' : 'ok'}>{h.status}</Badge></td>
                      <td className="py-2 pr-3"><Badge tone={severityTone(h.severity)}>{h.severity || '-'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{h.type || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted max-w-[200px] truncate" title={h.target || ''}>{h.target || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-xs max-w-[380px]">{h.message || '-'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(h.first_seen)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{h.status === 'open' ? '-' : fmtWhen(h.resolved_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

export default function BluecatIssuesPage() {
  const { toast } = useToast();
  const [issues, setIssues] = React.useState(null);
  const [issuesFailed, setIssuesFailed] = React.useState(false);
  const [history, setHistory] = React.useState(null);
  const [historyFailed, setHistoryFailed] = React.useState(false);
  const [days, setDays] = React.useState(30);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const loadIssues = React.useCallback(() => {
    setIssuesFailed(false);
    return client.get('/bluecat/issues')
      .then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || []))
      .catch(() => { setIssues(null); setIssuesFailed(true); });
  }, []);

  const loadHistory = React.useCallback(() => {
    setHistoryFailed(false);
    return client.get('/bluecat/issue-history', { params: { days } })
      .then(({ data }) => setHistory(Array.isArray(data) ? data : []))
      .catch(() => { setHistory(null); setHistoryFailed(true); });
  }, [days]);

  const load = React.useCallback(() => Promise.all([loadIssues(), loadHistory()])
    .then(() => setLastRefreshed(new Date()))
    .catch(() => toast({ type: 'error', title: 'Failed to load alerts' })), [loadIssues, loadHistory, toast]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ClipboardCheck} title="Issue Alerts" description="Computed BlueCat issues across all registered Address Managers, with open/resolved history">
        <div className="flex items-center gap-1 mr-2">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${days === r.days ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {r.label}
            </button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <CurrentIssuesPanel rows={issues} failed={issuesFailed} onRetry={loadIssues} />
      <HistoryPanel rows={history} failed={historyFailed} onRetry={loadHistory} />
    </div>
  );
}
