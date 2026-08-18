// NetApp Mounts — ported from frontend/src/pages/netapp/NetAppMountsPage.jsx.
import { Cable } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtNum, useTableControls, SortTh, TableControls, TablePager, useVisibleColumns, ColumnPicker, CsvExportButton, useDnsResolve, IpWithHost } from '../ui.jsx';

const gb = (b) => b == null ? null : (b / 1024 ** 3).toFixed(2);
const usedSize = (m) => m.size_bytes == null ? '—'
  : `${gb(m.used_bytes) ?? '?'} / ${gb(m.size_bytes)} GB${m.used_percent != null ? ` (${Math.round(m.used_percent)}%)` : ''}`;

export default function MountsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/netapp/mounts')
    .then((data) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ipList = React.useMemo(() => [...new Set(list.map((m) => m.client_ip).filter(Boolean))], [list]);
  const dns = useDnsResolve(ipList);

  const ctl = useTableControls(list, {
    searchKeys: ['client_name', 'client_ip', 'volume_name', 'svm_name', 'array_name', 'junction_path', 'smb_users', 'aggregate_name'],
    defaultSortKey: 'client_name', defaultSortDir: 'asc',
    paginate: true,
  });

  const COLUMNS = [
    { k: 'client_name', label: 'VM / Client', always: true,
      render: (m) => <td key="client_name" className="py-2 pr-3"><IpWithHost ip={m.client_ip} dns={dns} vm={m.client_name} /></td>,
      csv: (m) => m.client_name },
    { k: 'client_ip', label: 'Client IP', pickerHidden: true, render: () => null, csv: (m) => m.client_ip },
    { k: 'mount_type', label: 'Mount',
      render: (m) => <td key="mount_type" className="py-2 pr-3"><Badge tone={m.mount_type === 'NFS' ? 'info' : 'ok'}>{m.mount_type}</Badge></td>,
      csv: (m) => m.mount_type },
    { k: 'protocols', label: 'Protocol',
      render: (m) => <td key="protocols" className="py-2 pr-3 text-ink-muted text-[11px]">{m.protocols || '—'}</td>, csv: (m) => m.protocols },
    { k: 'smb_users', label: 'SMB User',
      render: (m) => <td key="smb_users" className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[160px]" title={m.smb_users || ''}>{m.smb_users || '—'}</td>,
      csv: (m) => m.smb_users },
    { k: 'volume_name', label: 'Volume',
      render: (m) => <td key="volume_name" className="py-2 pr-3 text-ink font-medium truncate max-w-[200px]" title={m.volume_name || ''}>{m.volume_name || '—'}</td>,
      csv: (m) => m.volume_name },
    { k: 'svm_name', label: 'SVM', render: (m) => <td key="svm_name" className="py-2 pr-3 text-ink-muted">{m.svm_name || '—'}</td>, csv: (m) => m.svm_name },
    { k: 'array_name', label: 'Cluster', render: (m) => <td key="array_name" className="py-2 pr-3 text-ink-muted whitespace-nowrap">{m.array_name}</td>, csv: (m) => m.array_name },
    { k: 'aggregate_name', label: 'Aggregate', render: (m) => <td key="aggregate_name" className="py-2 pr-3 text-ink-muted text-[11px]">{m.aggregate_name || '—'}</td>, csv: (m) => m.aggregate_name },
    { k: 'type', label: 'Type',
      render: (m) => <td key="type" className="py-2 pr-3">{m.type ? <Badge tone={String(m.type).toLowerCase() === 'rw' ? 'ok' : 'warn'}>{String(m.type).toUpperCase()}</Badge> : <span className="text-ink-faint">—</span>}</td>,
      csv: (m) => m.type },
    { k: 'style', label: 'Style', render: (m) => <td key="style" className="py-2 pr-3 text-ink-muted text-[11px]">{m.style || '—'}</td>, csv: (m) => m.style },
    { k: 'junction_path', label: 'Junction Path',
      render: (m) => <td key="junction_path" className="py-2 pr-3 text-ink-muted text-[11px] tnum truncate max-w-[220px]" title={m.junction_path || ''}>{m.junction_path || '—'}</td>,
      csv: (m) => m.junction_path },
    { k: 'used_bytes', label: 'Used / Size',
      render: (m) => <td key="used_bytes" className="py-2 pr-3 text-ink-muted text-[11px] tnum whitespace-nowrap">{usedSize(m)}</td>, csv: (m) => usedSize(m) },
    { k: 'state', label: 'State',
      render: (m) => <td key="state" className="py-2 pr-3">{m.state ? <Badge tone={String(m.state).toLowerCase() === 'online' ? 'ok' : 'crit'}>{m.state}</Badge> : <span className="text-ink-faint">—</span>}</td>,
      csv: (m) => m.state },
  ];
  const cols = useVisibleColumns('netapp-mounts-cols', ['protocols', 'smb_users', 'aggregate_name', 'style']);
  const shown = COLUMNS.filter((c) => !c.pickerHidden && (c.always || cols.show(c.k)));

  const uniqueVms = React.useMemo(() => new Set(list.map((m) => m.client_name || m.client_ip)).size, [list]);
  const uniqueVolumes = React.useMemo(() => new Set(list.map((m) => `${m.array_name}|${m.svm_name}|${m.volume_name}`)).size, [list]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cable} title="Mounts" description="Live client↔volume mounts across NFS and SMB, resolved to VMs where inventory knows the IP">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <ColumnPicker columns={COLUMNS.filter((c) => !c.pickerHidden)} prefs={cols} />
        <CsvExportButton filename="netapp-mounts" rows={ctl.rows} columns={COLUMNS.map((c) => ({ label: c.label, get: c.csv }))} />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Mounts" value={fmtNum(list.length)} />
        <StatCard label="Unique Clients" value={fmtNum(uniqueVms)} />
        <StatCard label="Volumes In Use" value={fmtNum(uniqueVolumes)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, IP, volume, path or user…"
          filters={[
            { k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' },
            { k: 'mount_type', label: 'Mount types' }, { k: 'state', label: 'States' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading mounts…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No live NFS clients or SMB sessions found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No mounts match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                {shown.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} />)}
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((m, i) => (
                  <tr key={`${m.client_ip}|${m.mount_type}|${m.svm_name}|${m.volume_name}|${i}`} className="border-b">
                    {shown.map((c) => c.render(m, i))}
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
