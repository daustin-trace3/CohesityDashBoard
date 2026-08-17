import { Puzzle } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtWhen, statusTone,
} from '../ui.jsx';

const KIND_TABS = [
  { key: '', label: 'All' },
  { key: 'abx', label: 'ABX' },
  { key: 'pipeline', label: 'Pipelines' },
];

export default function AriaExtensibilityPage() {
  const [rows, setRows] = React.useState(null);
  const [kind, setKind] = React.useState('');
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aria/runs')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const filtered = (rows || []).filter((r) => !kind || r.kind === kind);
  const ctl = useTableControls(filtered, {
    searchKeys: ['name', 'instance_name', 'project_name'],
    defaultSortKey: 'started_at_src', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Puzzle} title="Extensibility" description="ABX action runs and vRO pipeline executions across all registered Aria instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 w-fit mb-4">
        {KIND_TABS.map((t) => {
          const active = kind === t.key;
          return (
            <button key={t.key} onClick={() => setKind(t.key)}
              className={`px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
              }`}>
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={filtered} searchPlaceholder="Filter by name or project…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading runs…" height={140} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No runs found — register an Aria instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No runs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="kind" label="Kind" ctl={ctl} />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="project_name" label="Project" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="started_at_src" label="Started" ctl={ctl} />
                <th className="py-2 pr-3">Message</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => {
                  const tone = statusTone(r.status);
                  return (
                    <tr key={`${r.instance_name}|${r.kind}|${r.run_id}|${i}`} className={`border-b border-cohesity-border/50 ${tone === 'crit' ? 'bg-status-crit/5' : ''}`}>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.instance_name}</td>
                      <td className="py-2 pr-3"><Badge tone="neutral">{r.kind === 'abx' ? 'ABX' : 'Pipeline'}</Badge></td>
                      <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.project_name || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={tone}>{r.status || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.started_at_src)}</td>
                      <td className={`py-2 pr-3 text-[11px] max-w-[280px] truncate ${tone === 'crit' ? 'text-status-crit' : 'text-ink-faint'}`} title={r.message || ''}>{r.message || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
