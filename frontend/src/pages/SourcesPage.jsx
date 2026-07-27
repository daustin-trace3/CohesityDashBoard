import { useEffect, useState, useCallback } from 'react';
import { Boxes, Download } from 'lucide-react';
import client from '../api/client';
import { useToast } from '../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, useVisibleColumns, ColumnPicker } from '../components/ui/tableTools';

const gb = (b) => b == null ? '' : (b / 1024 ** 3).toFixed(2);
const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};
const runTone = (s) => s === 'Succeeded' || s === 'SucceededWithWarning' ? 'ok'
  : s === 'Failed' ? 'crit' : s === 'Running' ? 'info' : s ? 'warn' : 'neutral';
const cellMuted = 'py-2 pr-3 text-ink-muted';
const cellSmall = 'py-2 pr-3 text-ink-muted text-[11px]';

const COLUMNS = [
  { k: 'name', label: 'Object', always: true, csvLabel: 'Object',
    render: (o) => <td key="name" className="py-2 pr-3 text-ink truncate max-w-[220px]" title={o.name || ''}>{o.name || '—'}</td>, csv: (o) => o.name },
  { k: 'environment', label: 'Workload', csvLabel: 'Workload',
    render: (o) => <td key="environment" className={cellMuted}>{o.environment || '—'}</td>, csv: (o) => o.environment },
  { k: 'object_type', label: 'Type', csvLabel: 'Object Type',
    render: (o) => <td key="object_type" className={cellSmall}>{o.object_type || '—'}</td>, csv: (o) => o.object_type },
  { k: 'os_type', label: 'OS', csvLabel: 'OS',
    render: (o) => <td key="os_type" className={cellSmall}>{o.os_type || '—'}</td>, csv: (o) => o.os_type },
  { k: 'source_name', label: 'Source', csvLabel: 'Source',
    render: (o) => <td key="source_name" className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[180px]" title={o.source_name || ''}>{o.source_name || '—'}</td>, csv: (o) => o.source_name },
  { k: 'protected_label', label: 'Protected', csvLabel: 'Protected',
    render: (o) => <td key="protected_label" className="py-2 pr-3"><Badge tone={o.is_protected ? 'ok' : 'warn'}>{o.protected_label}</Badge></td>,
    csv: (o) => o.protected_label },
  { k: 'cluster_name', label: 'Cluster', csvLabel: 'Cluster',
    render: (o) => <td key="cluster_name" className={cellMuted}>{o.cluster_name}</td>, csv: (o) => o.cluster_name },
  { k: 'groups_label', label: 'Protection Group', csvLabel: 'Protection Groups',
    render: (o) => <td key="groups_label" className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[200px]" title={o.groups_label}>{o.groups_label || '—'}</td>,
    csv: (o) => o.groups_label },
  { k: 'policies_label', label: 'Policy', csvLabel: 'Policies',
    render: (o) => <td key="policies_label" className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[200px]" title={o.policies_label}>{o.policies_label || '—'}</td>,
    csv: (o) => o.policies_label },
  { k: 'last_backup_status', label: 'Last Backup', csvLabel: 'Last Backup',
    render: (o) => <td key="last_backup_status" className="py-2 pr-3">{o.last_backup_status ? <Badge tone={runTone(o.last_backup_status)}>{o.last_backup_status}</Badge> : <span className="text-ink-faint text-[11px]">—</span>}</td>,
    csv: (o) => o.last_backup_status },
  { k: 'sla_violated', label: 'SLA', csvLabel: 'SLA Violated',
    render: (o) => <td key="sla_violated" className={cellSmall}>{o.sla_violated == null ? '—' : o.sla_violated ? <span className="text-status-warn font-semibold">violated</span> : 'met'}</td>,
    csv: (o) => o.sla_violated == null ? '' : o.sla_violated ? 'yes' : 'no' },
  { k: 'logical_bytes', label: 'Logical', align: 'right', csvLabel: 'Logical (GB)',
    render: (o) => <td key="logical_bytes" className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(o.logical_bytes)}</td>, csv: (o) => gb(o.logical_bytes) },
  { k: 'protection_type', label: 'Protection Type', csvLabel: 'Protection Type',
    render: (o) => <td key="protection_type" className={cellSmall}>{o.protection_type || '—'}</td>, csv: (o) => o.protection_type },
];

const DEFAULT_HIDDEN = ['os_type', 'protection_type', 'policies_label'];

export default function SourcesPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/cohesity/workloads/sources')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ objects: [], environments: [] }); toast({ type: 'error', title: 'Failed to load sources' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (data?.objects || []).map((o) => ({
    ...o,
    protected_label: o.is_protected ? 'protected' : 'unprotected',
    groups_label: (o.protection_groups || []).join(', '),
    policies_label: (o.policy_names || []).join(', '),
  }));

  const cols = useVisibleColumns('cohesity-sources-columns', DEFAULT_HIDDEN);
  const visible = COLUMNS.filter((c) => c.always || cols.show(c.k));

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'source_name', 'cluster_name', 'groups_label', 'policies_label', 'object_type'],
    defaultSortKey: 'name',
    paginate: true,
  });

  const envFilter = ctl.filters.environment || '';

  // Export honors the active filters/search (ctl.rows is the filtered set,
  // pre-pagination); with nothing filtered that IS the whole inventory.
  const exportCsv = () => {
    const esc = (val) => {
      const t = val == null ? '' : String(val);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [COLUMNS.map((c) => esc(c.csvLabel)).join(',')];
    for (const o of ctl.rows) lines.push(COLUMNS.map((c) => esc(c.csv(o))).join(','));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cohesity-sources-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Sources"
        description="Every discovered object across the estate — click a workload tile to filter">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <ColumnPicker columns={COLUMNS} prefs={cols} />
        <button onClick={exportCsv} disabled={!ctl.rows.length}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
          <Download size={13} /> Export
        </button>
        <RefreshButton onClick={load} />
      </PageHeader>

      {/* Workload-type tiles — click to filter the table */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(data?.environments || []).map((e) => {
          const active = envFilter === e.environment;
          return (
            <button key={e.environment}
              onClick={() => ctl.setFilter('environment', active ? '' : e.environment)}
              className={`panel px-3 py-2 text-left transition-colors cursor-pointer ${active ? 'border-brand/60 bg-brand/10' : 'hover:border-brand/40'}`}>
              <p className={`text-xs font-bold ${active ? 'text-brand' : 'text-ink'}`}>{e.environment}</p>
              <p className="text-[11px] text-ink-muted tnum">
                {e.protected}/{e.total} protected · {fmtBytes(e.logicalBytes)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="panel p-4">
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by object, source, cluster, group or policy…"
          filters={[
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'environment', label: 'Workloads' },
            { k: 'protected_label', label: 'Protection' },
          ]} />
        {data == null ? (
          <LoadingPanel label="Loading sources…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No object inventory yet — data appears after the next poll of each cluster.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No objects match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  {visible.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((o) => (
                  <tr key={o.id} className="border-b border-cohesity-border/50">
                    {visible.map((c) => c.render(o))}
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
