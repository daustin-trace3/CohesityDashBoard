// Nutanix Issues & History — minimal read-only port of the host's shared
// IssueAlertsPage (frontend/src/components/IssueAlertsPage.jsx), which is
// NOT importable from a plugin bundle (host component import forbidden).
// Nutanix-only: no CONFIG map needed since this page is single-platform.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  ClipboardListIcon, fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';
const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];

const sevTone = (sev) => ((sev === 'critical' || sev === 'error') ? 'crit' : sev === 'warning' ? 'warn' : 'info');

const th = { textAlign: 'left', padding: '8px 12px 8px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--nx-ink-faint)', borderBottom: '1px solid var(--nx-border)' };
const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

function CurrentIssuesPanel({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'source'],
    defaultSortKey: 'severity', defaultSortDir: 'asc',
    paginate: true,
  });
  const csvColumns = [
    { label: 'Severity', get: (i) => i.severity },
    { label: 'Type', get: (i) => i.type },
    { label: 'Source', get: (i) => i.source },
    { label: 'Target', get: (i) => i.target },
    { label: 'Message', get: (i) => i.message },
  ];
  return (
    <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nx-ink)' }}>Open Issues <span style={{ color: 'var(--nx-ink-faint)', fontWeight: 400 }}>— current state, recomputed on every request</span></div>
        <CsvExportButton filename="nutanix-issues" rows={ctl.rows} columns={csvColumns} />
      </div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, type or target…"
        filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }, { k: 'source', label: 'Sources' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading issues…" height={140} />
      ) : list.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nx-ok)', padding: '24px 0', textAlign: 'center' }}>No open issues.</div>
      ) : ctl.rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No issues match your filters.</div>
      ) : (
        <div className="nx-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="source" label="Source" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th style={th}>Message</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((i, idx) => (
                <tr key={`${i.type}|${i.target}|${idx}`} className="nx-row">
                  <td style={td}><Badge tone={sevTone(i.severity)}>{i.severity}</Badge></td>
                  <td style={{ ...tdMuted, fontSize: 11, whiteSpace: 'nowrap' }}>{i.type || '—'}</td>
                  <td style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{i.source || '—'}</td>
                  <td style={{ ...tdMuted, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.target || ''}>{i.target || '—'}</td>
                  <td style={{ ...tdMuted, fontSize: 12, maxWidth: 460 }}>{i.message || '—'}</td>
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
    searchKeys: ['message', 'type', 'target', 'source'],
    defaultSortKey: 'last_seen', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nx-ink)', marginBottom: 8 }}>Issue History <span style={{ color: 'var(--nx-ink-faint)', fontWeight: 400 }}>— when each issue was first detected and when it resolved</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter history…"
        filters={[{ k: 'status', label: 'Statuses' }, { k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading history…" height={140} />
      ) : list.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No issue history in the selected window.</div>
      ) : ctl.rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No history matches your filters.</div>
      ) : (
        <div className="nx-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <SortTh k="status" label="Status" ctl={ctl} />
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th style={th}>Message</th>
              <SortTh k="first_seen" label="First Seen" ctl={ctl} />
              <SortTh k="resolved_at" label="Resolved" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((h) => (
                <tr key={h.id} className="nx-row">
                  <td style={td}><Badge tone={h.status === 'open' ? 'crit' : 'ok'}>{h.status}</Badge></td>
                  <td style={td}><Badge tone={sevTone(h.severity)}>{h.severity || '—'}</Badge></td>
                  <td style={{ ...tdMuted, fontSize: 11, whiteSpace: 'nowrap' }}>{h.type || '—'}</td>
                  <td style={{ ...tdMuted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.target || ''}>{h.target || '—'}</td>
                  <td style={{ ...tdMuted, fontSize: 12, maxWidth: 380 }}>{h.message || '—'}</td>
                  <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11, whiteSpace: 'nowrap' }}>{fmtWhen(h.first_seen)}</td>
                  <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11, whiteSpace: 'nowrap' }}>{h.status === 'open' ? '—' : fmtWhen(h.resolved_at)}</td>
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

export default function IssuesPage() {
  const [issues, setIssues] = React.useState(null);
  const [history, setHistory] = React.useState(null);
  const [days, setDays] = React.useState(30);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    fetch('/api/nutanix/issues', { credentials: 'include' })
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then((json) => setIssues(Array.isArray(json) ? json : json?.issues || [])),
    fetch(`/api/nutanix/issue-history?days=${days}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : []))
      .then((json) => setHistory(json))
      .catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setIssues([])), [days]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={ClipboardListIcon} title="Issues & History" description="Computed issues across all registered Nutanix sources, with open/resolved history">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: days === r.days ? 'none' : '1px solid var(--nx-border)', background: days === r.days ? 'var(--nx-brand)' : 'transparent', color: days === r.days ? '#0B1015' : 'var(--nx-ink-muted)' }}>
              {r.label}
            </button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <CurrentIssuesPanel rows={issues} />
      <HistoryPanel rows={history} />
    </div>
  );
}
