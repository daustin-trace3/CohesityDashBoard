import { useEffect, useState, useCallback } from 'react';
import { Layers, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, useVisibleColumns, ColumnPicker } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtNum, statusTone } from './helpers';

const gb = (b) => b == null ? '' : (b / 1024 ** 3).toFixed(2);
const pct = (p) => p != null ? `${Math.round(p)}%` : '—';
const yn = (v) => v == null ? '—' : v ? 'yes' : 'no';
const day = (t) => t ? String(t).slice(0, 10) : '—';
const cellMuted = 'py-2 pr-3 text-ink-muted';
const cellNum = 'py-2 pr-3 text-right tnum text-ink-muted';
const cellSmall = 'py-2 pr-3 text-ink-muted text-[11px]';

// One definition drives the header, body, column picker, and CSV export.
// `csv` values use Doug's export standard: bytes always in fixed GB.
const COLUMNS = [
  { k: 'name', label: 'Volume', always: true, csvLabel: 'Volume',
    render: (v) => <td key="name" className="py-2 pr-3 text-ink truncate max-w-[220px]">{v.name}</td>, csv: (v) => v.name },
  { k: 'svm_name', label: 'SVM', csvLabel: 'SVM',
    render: (v) => <td key="svm_name" className={cellMuted}>{v.svm_name || '—'}</td>, csv: (v) => v.svm_name },
  { k: 'array_name', label: 'Cluster', csvLabel: 'Cluster',
    render: (v) => <td key="array_name" className={cellMuted}>{v.array_name}</td>, csv: (v) => v.array_name },
  { k: 'aggregate_name', label: 'Aggregate', csvLabel: 'Aggregate',
    render: (v) => <td key="aggregate_name" className={cellMuted}>{v.aggregate_name || '—'}</td>, csv: (v) => v.aggregate_name },
  { k: 'type', label: 'Type', csvLabel: 'Type',
    render: (v) => <td key="type" className="py-2 pr-3">{v.type ? <Badge tone={v.type === 'rw' ? 'ok' : 'info'}>{v.type}</Badge> : <span className="text-ink-faint">—</span>}</td>,
    csv: (v) => v.type },
  { k: 'style', label: 'Style', csvLabel: 'Style',
    render: (v) => <td key="style" className={cellSmall}>{v.style || '—'}</td>, csv: (v) => v.style },
  { k: 'junction_path', label: 'Junction Path', csvLabel: 'Junction Path',
    render: (v) => <td key="junction_path" className="py-2 pr-3 text-ink-muted text-[11px] font-mono truncate max-w-[200px]" title={v.junction_path || ''}>{v.junction_path || '—'}</td>,
    csv: (v) => v.junction_path },
  { k: 'security_style', label: 'Security', csvLabel: 'Security Style',
    render: (v) => <td key="security_style" className={cellSmall}>{v.security_style || '—'}</td>, csv: (v) => v.security_style },
  { k: 'export_policy', label: 'Export Policy', csvLabel: 'Export Policy',
    render: (v) => <td key="export_policy" className={cellSmall}>{v.export_policy || '—'}</td>, csv: (v) => v.export_policy },
  { k: 'snapshot_policy', label: 'Snapshot Policy', csvLabel: 'Snapshot Policy',
    render: (v) => <td key="snapshot_policy" className={cellSmall}>{v.snapshot_policy || '—'}</td>, csv: (v) => v.snapshot_policy },
  { k: 'used_bytes', label: 'Used', align: 'right', csvLabel: 'Used (GB)',
    render: (v) => <td key="used_bytes" className={cellNum}>{fmtBytes(v.used_bytes)}</td>, csv: (v) => gb(v.used_bytes) },
  { k: 'size_bytes', label: 'Size', align: 'right', csvLabel: 'Size (GB)',
    render: (v) => <td key="size_bytes" className={cellNum}>{fmtBytes(v.size_bytes)}</td>, csv: (v) => gb(v.size_bytes) },
  { k: 'used_percent', label: 'Used %', align: 'right', csvLabel: 'Used %',
    render: (v) => <td key="used_percent" className={cellNum}>{pct(v.used_percent)}</td>,
    csv: (v) => v.used_percent != null ? Math.round(v.used_percent) : '' },
  { k: 'logical_used_bytes', label: 'Logical Used', align: 'right', csvLabel: 'Logical Used (GB)',
    render: (v) => <td key="logical_used_bytes" className={cellNum}>{fmtBytes(v.logical_used_bytes)}</td>, csv: (v) => gb(v.logical_used_bytes) },
  { k: 'snapshot_used_bytes', label: 'Snap Used', align: 'right', csvLabel: 'Snapshot Used (GB)',
    render: (v) => <td key="snapshot_used_bytes" className={cellNum}>{fmtBytes(v.snapshot_used_bytes)}</td>, csv: (v) => gb(v.snapshot_used_bytes) },
  { k: 'snapshot_reserve_percent', label: 'Snap Reserve', align: 'right', csvLabel: 'Snapshot Reserve %',
    render: (v) => <td key="snapshot_reserve_percent" className={cellNum}>{pct(v.snapshot_reserve_percent)}</td>,
    csv: (v) => v.snapshot_reserve_percent != null ? Math.round(v.snapshot_reserve_percent) : '' },
  { k: 'guarantee_type', label: 'Provisioning', csvLabel: 'Provisioning',
    render: (v) => <td key="guarantee_type" className={cellSmall}>{v.guarantee_type == null ? '—' : v.guarantee_type === 'none' ? 'thin' : v.guarantee_type}</td>,
    csv: (v) => v.guarantee_type == null ? '' : v.guarantee_type === 'none' ? 'thin' : v.guarantee_type },
  { k: 'autosize_mode', label: 'Autosize', csvLabel: 'Autosize',
    render: (v) => <td key="autosize_mode" className={cellSmall}>{v.autosize_mode ? `${v.autosize_mode}${v.autosize_max_bytes ? ` → ${fmtBytes(v.autosize_max_bytes)}` : ''}` : '—'}</td>,
    csv: (v) => v.autosize_mode },
  { k: 'autosize_max_bytes', label: 'Autosize Max', align: 'right', csvLabel: 'Autosize Max (GB)', pickerHidden: true,
    render: () => null, csv: (v) => gb(v.autosize_max_bytes) },
  { k: 'inode_pct', label: 'Inodes', align: 'right', csvLabel: 'Inodes Used %',
    render: (v) => <td key="inode_pct" className={`py-2 pr-3 text-right tnum ${v.inode_pct != null && v.inode_pct >= 90 ? 'text-status-crit font-semibold' : 'text-ink-muted'}`}>{pct(v.inode_pct)}</td>,
    csv: (v) => v.inode_pct != null ? Math.round(v.inode_pct) : '' },
  { k: 'snaplock_type', label: 'SnapLock', csvLabel: 'SnapLock',
    render: (v) => <td key="snaplock_type" className="py-2 pr-3">{v.snaplock_type && v.snaplock_type !== 'non_snaplock' ? <Badge tone="warn">{v.snaplock_type}</Badge> : <span className="text-ink-faint text-[11px]">—</span>}</td>,
    csv: (v) => v.snaplock_type },
  { k: 'encryption_enabled', label: 'Encrypted', csvLabel: 'Encrypted',
    render: (v) => <td key="encryption_enabled" className={cellSmall}>{yn(v.encryption_enabled)}</td>, csv: (v) => yn(v.encryption_enabled) === '—' ? '' : yn(v.encryption_enabled) },
  { k: 'anti_ransomware_state', label: 'Anti-ransomware', csvLabel: 'Anti-ransomware',
    render: (v) => <td key="anti_ransomware_state" className={cellSmall}>{v.anti_ransomware_state || '—'}</td>, csv: (v) => v.anti_ransomware_state },
  { k: 'qos_policy', label: 'QoS', csvLabel: 'QoS Policy',
    render: (v) => <td key="qos_policy" className={cellSmall}>{v.qos_policy || '—'}</td>, csv: (v) => v.qos_policy },
  { k: 'tiering_policy', label: 'Tiering', csvLabel: 'Tiering Policy',
    render: (v) => <td key="tiering_policy" className={cellSmall}>{v.tiering_policy || '—'}</td>, csv: (v) => v.tiering_policy },
  { k: 'quota_state', label: 'Quotas', csvLabel: 'Quota State',
    render: (v) => <td key="quota_state" className={cellSmall}>{v.quota_state || '—'}</td>, csv: (v) => v.quota_state },
  { k: 'metric_iops', label: 'IOPS', align: 'right', csvLabel: 'IOPS',
    render: (v) => <td key="metric_iops" className={cellNum}>{v.metric_iops != null ? fmtNum(Math.round(v.metric_iops)) : '—'}</td>,
    csv: (v) => v.metric_iops != null ? Math.round(v.metric_iops) : '' },
  { k: 'metric_throughput_bps', label: 'Throughput', align: 'right', csvLabel: 'Throughput (MB/s)',
    render: (v) => <td key="metric_throughput_bps" className={cellNum}>{v.metric_throughput_bps != null ? `${fmtBytes(v.metric_throughput_bps)}/s` : '—'}</td>,
    csv: (v) => v.metric_throughput_bps != null ? (v.metric_throughput_bps / 1024 ** 2).toFixed(2) : '' },
  { k: 'metric_latency_us', label: 'Latency', align: 'right', csvLabel: 'Latency (ms)',
    render: (v) => <td key="metric_latency_us" className={cellNum}>{v.metric_latency_us != null ? `${(v.metric_latency_us / 1000).toFixed(2)} ms` : '—'}</td>,
    csv: (v) => v.metric_latency_us != null ? (v.metric_latency_us / 1000).toFixed(2) : '' },
  { k: 'create_time', label: 'Created', csvLabel: 'Created',
    render: (v) => <td key="create_time" className={cellSmall}>{day(v.create_time)}</td>, csv: (v) => day(v.create_time) === '—' ? '' : day(v.create_time) },
  { k: 'comment', label: 'Comment', csvLabel: 'Comment',
    render: (v) => <td key="comment" className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[180px]" title={v.comment || ''}>{v.comment || '—'}</td>,
    csv: (v) => v.comment },
  { k: 'state', label: 'State', csvLabel: 'State',
    render: (v) => <td key="state" className="py-2 pr-3"><Badge tone={statusTone(v.state)}>{v.state || 'unknown'}</Badge>{v.is_inconsistent ? <span className="text-status-crit text-[11px] ml-1" title="Volume is inconsistent">⚠</span> : null}</td>,
    csv: (v) => v.state },
  { k: 'is_inconsistent', label: 'Inconsistent', csvLabel: 'Inconsistent', pickerHidden: true,
    render: () => null, csv: (v) => v.is_inconsistent == null ? '' : yn(v.is_inconsistent) },
];

// Hidden by default: everything beyond the classic table + Type. Users opt in
// via the Columns picker (persisted per browser).
const DEFAULT_HIDDEN = COLUMNS.filter((c) => !c.always && !['svm_name', 'array_name', 'aggregate_name', 'type', 'used_bytes', 'size_bytes', 'used_percent', 'state'].includes(c.k)).map((c) => c.k);

export default function NetAppVolumesPage() {
  const { toast } = useToast();
  const [volumes, setVolumes] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netapp/volumes')
    .then(({ data }) => { setVolumes(data); setLastRefreshed(new Date()); })
    .catch(() => { setVolumes([]); toast({ type: 'error', title: 'Failed to load volumes' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (volumes || []).map((v) => ({
    ...v,
    inode_pct: v.files_used != null && v.files_maximum ? (v.files_used / v.files_maximum) * 100 : null,
  }));

  const cols = useVisibleColumns('netapp-volumes-columns', DEFAULT_HIDDEN);
  const visible = COLUMNS.filter((c) => !c.pickerHidden && (c.always || cols.show(c.k)));

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'svm_name', 'array_name', 'aggregate_name', 'junction_path', 'export_policy'],
    defaultSortKey: 'name',
    paginate: true,
  });

  const totals = (volumes || []).reduce((a, v) => { a.size += v.size_bytes || 0; a.used += v.used_bytes || 0; return a; }, { size: 0, used: 0 });

  // Export ALWAYS includes every column, independent of the on-screen picker.
  const exportCsv = () => {
    const esc = (val) => {
      const t = val == null ? '' : String(val);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [COLUMNS.map((c) => esc(c.csvLabel)).join(',')];
    for (const v of list) lines.push(COLUMNS.map((c) => esc(c.csv(v))).join(','));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netapp-volumes-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="NetApp Volumes" description="FlexVols across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <ColumnPicker columns={COLUMNS.filter((c) => !c.pickerHidden)} prefs={cols} />
        <button onClick={exportCsv} disabled={!(volumes || []).length}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
          <Download size={13} /> Export
        </button>
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={Layers} label="Volumes" value={fmtNum((volumes || []).length)} tone="brand" />
        <StatCard icon={Layers} label="Provisioned" value={fmtBytes(totals.size)} />
        <StatCard icon={Layers} label="Used" value={fmtBytes(totals.used)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by volume, SVM, cluster, aggregate, junction or policy…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }, { k: 'type', label: 'Types' }, { k: 'state', label: 'States' }]} />
        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : volumes.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volume data collected yet.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  {visible.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    {visible.map((c) => c.render(v))}
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
