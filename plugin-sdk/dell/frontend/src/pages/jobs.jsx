import { ListChecks } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtWhen,
} from '../ui.jsx';

const statusTone = (s) => {
  const n = String(s || '').toLowerCase();
  if (n === 'completed') return 'ok';
  if (n === 'failed' || n === 'aborted') return 'crit';
  if (n === 'warning' || n === 'stopped' || n === 'canceled' || n === 'paused') return 'warn';
  if (n === 'running' || n === 'starting' || n === 'queued') return 'info';
  return 'neutral';
};

export default function DellJobsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [showInternal, setShowInternal] = React.useState(false);

  const load = React.useCallback(() => apiFetch('/dell/jobs')
    .then((json) => { setRows(Array.isArray(json) ? json : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  // The appliance carries a large tail of internal/hidden plumbing jobs —
  // default to what the OME console's Monitor > Jobs page shows.
  const list = React.useMemo(() => (rows || []).filter((j) => showInternal || (j.visible && !j.internal)), [rows, showInternal]);

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'description', 'job_type', 'created_by', 'targets', 'ome_name'],
    defaultSortKey: 'last_run', defaultSortDir: 'desc',
    paginate: true,
  });

  const failed = list.filter((j) => j.last_run_status === 'Failed').length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ListChecks} title="Jobs" description="Task history on the OME appliances — inventory, discovery, firmware, and configuration jobs with their outcomes">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {rows == null ? (
        <LoadingPanel label="Loading jobs…" height={200} />
      ) : (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-[11px] text-ink-faint">
              {list.length.toLocaleString()} job(s){failed ? <span className="text-status-crit font-semibold"> · {failed} failed</span> : null}
            </p>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted cursor-pointer select-none">
              <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} className="accent-[#007DB8]" />
              Show internal / hidden jobs
            </label>
          </div>
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by job, type, target…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'job_type', label: 'Job types' }, { k: 'last_run_status', label: 'Last run status' }, { k: 'state', label: 'State' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Job" ctl={ctl} />
                <SortTh k="job_type" label="Type" ctl={ctl} />
                <SortTh k="last_run_status" label="Last Run Status" ctl={ctl} />
                <SortTh k="last_run" label="Last Run" ctl={ctl} />
                <SortTh k="next_run" label="Next Run" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="created_by" label="Created By" ctl={ctl} />
                <th className="py-2 pr-3">Targets</th>
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((j) => (
                  <tr key={j.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink max-w-[280px]">
                      <span className="block truncate" title={j.description || j.name || ''}>{j.name || '—'}</span>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-xs whitespace-nowrap">{j.job_type || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(j.last_run_status)}>{j.last_run_status || 'never run'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{fmtWhen(j.last_run)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{j.next_run ? fmtWhen(j.next_run) : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-xs">{j.state || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-xs">{j.created_by || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs max-w-[200px] truncate" title={j.targets || ''}>{j.targets || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{j.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </div>
      )}
    </div>
  );
}
