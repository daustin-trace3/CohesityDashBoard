// Ported from frontend/src/pages/aws/AwsS3Page.jsx — createPortal(...,
// document.body) replaced with ui.jsx's portalOrInline(), components/TrendChart
// replaced with charts.jsx's TrendChart (window.Chart).
import { Database, ShieldAlert, LineChartIcon, X } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner, portalOrInline,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtBytes, fmtNum, fmtWhen,
} from '../ui.jsx';
import { TrendChart } from '../charts.jsx';

const isPublic = (b) => !b.publicAccessBlocked;

function BucketHistoryModal({ bucket, onClose }) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    setRows(null);
    setError(false);
    apiFetch('/aws/s3/history', { params: { bucket: bucket.name, days: 90 } })
      .then((json) => setRows(json?.rows || []))
      .catch(() => setError(true));
  }, [bucket.name]);

  const labels = (rows || []).map((r) => r.day);

  return portalOrInline(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-2xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <LineChartIcon size={15} className="text-brand" /> {bucket.name} — growth (90d)
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Daily size and object count snapshots.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Failed to load bucket history.</div>
          ) : rows == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No history yet — snapshots accumulate daily.</div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-ink-muted mb-1">Size</p>
                <TrendChart labels={labels}
                  datasets={[{ label: 'Size', data: rows.map((r) => r.sizeBytes), color: BRAND, fill: true }]}
                  format={(v) => fmtBytes(v)} height={160} />
              </div>
              <div>
                <p className="text-xs font-semibold text-ink-muted mb-1">Object count</p>
                <TrendChart labels={labels}
                  datasets={[{ label: 'Objects', data: rows.map((r) => r.objectCount), color: '#569BD6', fill: true }]}
                  format={(v) => fmtNum(v)} height={160} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AwsS3Page() {
  const [buckets, setBuckets] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [historyBucket, setHistoryBucket] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/s3')
    .then((json) => { setBuckets(json?.buckets || []); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setBuckets([]); setError('Failed to load S3 data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const list = buckets || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'region', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const publicCount = list.filter(isPublic).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="S3" description="S3 buckets across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Buckets</p>
          {publicCount > 0 && <Badge tone="warn"><ShieldAlert size={11} className="inline mr-1" />{fmtNum(publicCount)} public</Badge>}
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by bucket, region or account…"
          filters={[{ k: 'region', label: 'Regions' }, { k: 'versioning', label: 'Versioning' }, { k: 'account', label: 'Accounts' }]} />
        {buckets == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No S3 buckets found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No buckets match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Bucket" ctl={ctl} />
                <SortTh k="region" label="Region" ctl={ctl} />
                <SortTh k="sizeBytes" label="Size" ctl={ctl} align="right" />
                <SortTh k="objectCount" label="Objects" ctl={ctl} align="right" />
                <SortTh k="publicAccessBlocked" label="Public Access" ctl={ctl} />
                <SortTh k="versioning" label="Versioning" ctl={ctl} />
                <SortTh k="lifecycleRules" label="Lifecycle Rules" ctl={ctl} align="right" />
                <SortTh k="createdAt" label="Created" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
                <th className="py-2 pr-3 text-right">Growth</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((b) => (
                  <tr key={`${b.account}|${b.name}`} className={`border-b border-cohesity-border/50 ${isPublic(b) ? 'bg-status-warn/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink">{b.name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{b.region || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(b.sizeBytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(b.objectCount)}</td>
                    <td className="py-2 pr-3">
                      {isPublic(b) ? <Badge tone="warn">Public</Badge> : <Badge tone="ok">Blocked</Badge>}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{b.versioning || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(b.lifecycleRules)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(b.createdAt)}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{b.account}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setHistoryBucket(b)} title={`${b.name} growth history`} aria-label={`${b.name} growth history`}
                        className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-brand hover:border-brand/40 transition-colors cursor-pointer">
                        <LineChartIcon size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {historyBucket && <BucketHistoryModal bucket={historyBucket} onClose={() => setHistoryBucket(null)} />}
    </div>
  );
}
