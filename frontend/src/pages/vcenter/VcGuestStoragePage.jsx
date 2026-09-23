import { useEffect, useState, useCallback } from 'react';
import { HardDrive, ChevronDown, ChevronUp, ChevronsUpDown, Search, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, StatCard, Spinner, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import Pagination from '../../components/Pagination';
import { BRAND, fmtNum } from './helpers';
import { VmDetailModal } from './VmModals';

// Guest Storage: what VMware Tools reports from inside each VM (C:, /var,
// capacity, used, percent) with the owner tag, threshold state and a report
// download, plus the virtual disks behind the VMs. Filtering, sorting and
// paging happen on the server; the tiles cover the whole estate.

function fmtGb(b) {
  if (b == null) return '-';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

function stateTone(state) {
  if (state === 'critical') return 'crit';
  if (state === 'warning') return 'warn';
  if (state === 'ok') return 'ok';
  return 'neutral';
}

function pctColor(state) {
  if (state === 'critical') return '#C75D5D';
  if (state === 'warning') return '#D4A24E';
  return '#6CB33F';
}

export function UsageBar({ pct, state, width = 'w-24' }) {
  if (pct == null) return <span className="text-ink-faint">-</span>;
  const color = pctColor(state);
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className={`${width} h-1.5 rounded-full bg-surface-overlay overflow-hidden`}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="tnum text-xs" style={{ color: state === 'ok' ? undefined : color }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

function fmtDays(d) {
  if (d == null) return '-';
  if (d > 3650) return '10y+';
  if (d >= 365) return `${(d / 365).toFixed(1)}y`;
  return `${d}d`;
}

const STATE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'ok', label: 'OK' },
];

const FS_COLUMNS = [
  { key: 'vm_name', label: 'VM', align: 'left' },
  { key: 'owner', label: 'Owner', align: 'left' },
  { key: 'mount', label: 'Volume', align: 'left' },
  { key: 'fs_type', label: 'Type', align: 'left', sortable: false },
  { key: 'capacity_bytes', label: 'Capacity', align: 'right' },
  { key: 'used_bytes', label: 'Used', align: 'right' },
  { key: 'free_bytes', label: 'Free', align: 'right' },
  { key: 'used_pct', label: 'Used %', align: 'right' },
  { key: 'growth_bytes_per_day', label: 'Growth / day', align: 'right', tooltip: 'Change in used space per day over the history ICC holds (at least three days)' },
  { key: 'days_to_full', label: 'Days to full', align: 'right', tooltip: 'Free space divided by daily growth; blank when the volume is not growing' },
  { key: 'vcenter_name', label: 'vCenter', align: 'left' },
];

const DISK_COLUMNS = [
  { key: 'vm_name', label: 'VM', align: 'left' },
  { key: 'owner', label: 'Owner', align: 'left' },
  { key: 'label', label: 'Disk', align: 'left' },
  { key: 'datastore', label: 'Datastore', align: 'left' },
  { key: 'capacity_bytes', label: 'Provisioned', align: 'right' },
  { key: 'used_bytes', label: 'On Datastore', align: 'right', tooltip: 'Bytes the VMDK chain occupies on the datastore' },
  { key: 'used_pct', label: 'Consumed %', align: 'right' },
  { key: 'thin', label: 'Thin', align: 'left', sortable: false },
  { key: 'vcenter_name', label: 'vCenter', align: 'left' },
];

const chipCls = (on) => `text-xs px-3 py-1.5 rounded font-medium transition-colors ${
  on ? 'bg-brand text-cohesity-black' : 'bg-surface-overlay text-ink-muted hover:text-ink'
}`;
const selectCls = 'bg-surface-overlay border border-cohesity-border text-ink text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand/60';

function SortHeader({ col, sortBy, sortDir, onSort }) {
  const sortable = col.sortable !== false;
  const active = sortBy === col.key;
  return (
    <th
      title={col.tooltip}
      className={`${col.align === 'right' ? 'text-right' : 'text-left'} py-2 pr-3 font-medium whitespace-nowrap ${sortable ? 'cursor-pointer hover:text-ink' : ''} ${active ? 'text-brand' : ''}`}
      onClick={() => sortable && onSort(col.key)}
    >
      <span className="inline-flex items-center gap-1">
        {col.label}
        {sortable && (active
          ? (sortDir === 'desc' ? <ChevronDown size={11} /> : <ChevronUp size={11} />)
          : <ChevronsUpDown size={11} className="text-ink-faint" />)}
      </span>
    </th>
  );
}

export default function VcGuestStoragePage() {
  const { toast } = useToast();
  const [tab, setTab] = useState('volumes');
  const [vcenters, setVcenters] = useState([]);
  const [vcenterId, setVcenterId] = useState('');
  const [state, setState] = useState('attention');
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState('used_pct');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailVmId, setDetailVmId] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    client.get('/vcenter/vcenters').then(({ data }) => setVcenters(data || [])).catch(() => setVcenters([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useCallback(() => ({
    vcenterId: vcenterId || undefined,
    state: tab === 'volumes' ? state : undefined,
    owner: owner || undefined,
    q: q || undefined,
    sortBy, sortDir, page, pageSize,
  }), [vcenterId, tab, state, owner, q, sortBy, sortDir, page, pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = tab === 'volumes' ? '/vcenter/guest-storage' : '/vcenter/vm-disks';
      const res = await client.get(url, { params: params() });
      setData(res.data);
      setLastRefreshed(new Date());
    } catch (err) {
      toast({ type: 'error', title: 'Failed to load guest storage', message: err?.response?.data?.error || err.message });
    } finally {
      setLoading(false);
    }
  }, [tab, params, toast]);

  useEffect(() => { load(); }, [load]);

  const switchTab = (t) => {
    setTab(t);
    setData(null);
    setSortBy(t === 'volumes' ? 'used_pct' : 'capacity_bytes');
    setSortDir('desc');
    setPage(0);
  };
  const handleSort = (key) => {
    if (sortBy === key) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(key); setSortDir(['vm_name', 'owner', 'mount', 'label', 'datastore', 'vcenter_name'].includes(key) ? 'asc' : 'desc'); }
    setPage(0);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await client.get('/vcenter/guest-storage.csv', { params: { ...params(), page: undefined, pageSize: undefined }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vcenter-guest-storage-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ type: 'error', title: 'Export failed', message: err?.response?.data?.error || err.message });
    } finally {
      setExporting(false);
    }
  };

  const summary = data?.summary || {};
  const t = summary.thresholds || {};
  const pageInfo = data?.page || { page: 0, pageSize, total: 0, totalPages: 1 };
  const rows = data?.rows || [];
  const owners = summary.owners || [];
  const columns = tab === 'volumes' ? FS_COLUMNS : DISK_COLUMNS;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Guest Storage"
        description={tab === 'volumes'
          ? `Volumes inside each VM as reported by VMware Tools. Warning at ${t.warn ?? 80}% used, critical at ${t.crit ?? 90}% (vCenter Settings, Alert thresholds).`
          : 'Virtual disks behind each VM: provisioned size against what the VMDK chain occupies on the datastore.'}>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      {tab === 'volumes' ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
            <StatCard label="Critical volumes" value={fmtNum(summary.critical)} sub={`${fmtNum(summary.vmsCritical)} VMs`} tone={summary.critical > 0 ? 'crit' : 'default'} onClick={() => { setState('critical'); setPage(0); }} />
            <StatCard label="Warning volumes" value={fmtNum(summary.warning)} sub={`${fmtNum(summary.vmsWarning)} VMs`} tone={summary.warning > 0 ? 'warn' : 'default'} onClick={() => { setState('warning'); setPage(0); }} />
            <StatCard label="Volumes" value={fmtNum(summary.volumes)} sub={`across ${fmtNum(summary.vms)} VMs`} onClick={() => { setState('all'); setPage(0); }} />
            <StatCard label="Guest capacity" value={fmtGb(summary.capacityBytes)} sub={`${fmtGb(summary.usedBytes)} used`} tone="brand" />
            <StatCard label="No guest data" value={fmtNum(summary.poweredOnWithoutData)} sub="powered on, nothing reported" tone={summary.poweredOnWithoutData > 0 ? 'warn' : 'default'} />
            <StatCard label="Tools not running" value={fmtNum(summary.poweredOnToolsNotRunning)} sub="powered on VMs" tone={summary.poweredOnToolsNotRunning > 0 ? 'warn' : 'default'} />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <StatCard label="Virtual disks" value={fmtNum(summary.disks)} sub={`across ${fmtNum(summary.vms)} VMs`} />
          <StatCard label="Provisioned" value={fmtGb(summary.provisionedBytes)} tone="brand" />
          <StatCard label="On datastores" value={fmtGb(summary.usedBytes)} sub={summary.provisionedBytes > 0 ? `${((summary.usedBytes / summary.provisionedBytes) * 100).toFixed(0)}% of provisioned` : ''} />
          <StatCard label="Thin provisioned" value={fmtNum(summary.thin)} sub="disks" />
        </div>
      )}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex gap-1">
            <button onClick={() => switchTab('volumes')} className={chipCls(tab === 'volumes')}>Guest volumes</button>
            <button onClick={() => switchTab('disks')} className={chipCls(tab === 'disks')}>Virtual disks</button>
          </div>
          <select className={selectCls} value={vcenterId} onChange={(e) => { setVcenterId(e.target.value); setPage(0); }}>
            <option value="">All vCenters</option>
            {vcenters.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {tab === 'volumes' && (
            <div className="flex gap-1 flex-wrap">
              {STATE_CHIPS.map(c => (
                <button key={c.key} onClick={() => { setState(c.key); setPage(0); }} className={chipCls(state === c.key)}>{c.label}</button>
              ))}
            </div>
          )}
          {tab === 'volumes' && owners.length > 0 && (
            <select className={selectCls} value={owner} onChange={(e) => { setOwner(e.target.value); setPage(0); }} title="Owner tag (configure the category per vCenter in Settings)">
              <option value="">All owners</option>
              {owners.map(o => <option key={o.owner} value={o.owner}>{o.owner} ({o.volumes})</option>)}
            </select>
          )}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="VM, volume, owner, host..."
              className="bg-surface-overlay border border-cohesity-border text-ink text-xs rounded-lg pl-6 pr-2 py-1.5 w-56 focus:outline-none focus:border-brand/60" />
          </div>
          <span className="ml-auto flex items-center gap-2">
            {loading && <Spinner size={13} />}
            {tab === 'volumes' && (
              <button onClick={exportCsv} disabled={exporting || !pageInfo.total}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50"
                title="Download every row matching the current filters">
                <Download size={12} /> {exporting ? 'Exporting...' : 'Export CSV'}
              </button>
            )}
          </span>
        </div>

        {!loading && pageInfo.total === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">
            {tab === 'volumes'
              ? (summary.volumes ? 'No volumes match the current filters.' : 'No guest volumes yet. VMware Tools must be running in the guest, and the next vCenter poll fills this page.')
              : 'No virtual disks recorded yet. The next vCenter poll fills this page.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    {tab === 'volumes' && <th className="py-2 pr-3 font-medium">State</th>}
                    {columns.map(col => <SortHeader key={col.key} col={col} sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-cohesity-border/50">
                      {tab === 'volumes' && (
                        <td className="py-1.5 pr-3"><Badge tone={stateTone(r.state)}>{r.state}</Badge></td>
                      )}
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {r.vm_row_id
                          ? <button onClick={() => setDetailVmId(r.vm_row_id)} className="text-ink hover:text-brand cursor-pointer">{r.vm_name}</button>
                          : <span className="text-ink">{r.vm_name || '-'}</span>}
                        {r.power_state && !String(r.power_state).includes('ON') && <span className="ml-1 text-[10px] text-ink-faint">off</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-ink-muted whitespace-nowrap">{r.owner || <span className="text-ink-faint">-</span>}</td>
                      {tab === 'volumes' ? (
                        <>
                          <td className="py-1.5 pr-3 text-ink tnum whitespace-nowrap">{r.mount}</td>
                          <td className="py-1.5 pr-3 text-ink-faint text-xs">{r.fs_type || '-'}</td>
                          <td className="py-1.5 pr-3 text-right tnum">{fmtGb(r.capacity_bytes)}</td>
                          <td className="py-1.5 pr-3 text-right tnum">{fmtGb(r.used_bytes)}</td>
                          <td className="py-1.5 pr-3 text-right tnum">{fmtGb(r.free_bytes)}</td>
                          <td className="py-1.5 pr-3"><UsageBar pct={r.used_pct} state={r.state} /></td>
                          <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{r.growth_bytes_per_day == null ? '-' : `${r.growth_bytes_per_day < 0 ? '-' : ''}${fmtGb(Math.abs(r.growth_bytes_per_day))}`}</td>
                          <td className={`py-1.5 pr-3 text-right tnum ${r.days_to_full != null && r.days_to_full <= 30 ? 'text-status-crit' : r.days_to_full != null && r.days_to_full <= 90 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtDays(r.days_to_full)}</td>
                        </>
                      ) : (
                        <>
                          <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{r.label || `disk ${r.disk_key ?? ''}`}</td>
                          <td className="py-1.5 pr-3 text-ink-muted whitespace-nowrap">{r.datastore || '-'}</td>
                          <td className="py-1.5 pr-3 text-right tnum">{fmtGb(r.capacity_bytes)}</td>
                          <td className="py-1.5 pr-3 text-right tnum">{fmtGb(r.used_bytes)}</td>
                          <td className="py-1.5 pr-3"><UsageBar pct={r.used_pct} state="ok" /></td>
                          <td className="py-1.5 pr-3">{r.thin == null ? <span className="text-ink-faint">-</span> : <Badge tone={r.thin ? 'info' : 'neutral'}>{r.thin ? 'thin' : 'thick'}</Badge>}</td>
                        </>
                      )}
                      <td className="py-1.5 pr-3 text-ink-muted whitespace-nowrap">{r.vcenter_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={pageInfo.page} totalPages={pageInfo.totalPages} pageSize={pageInfo.pageSize} totalItems={pageInfo.total}
              onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(0); }} />
          </>
        )}
      </div>

      {detailVmId && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
