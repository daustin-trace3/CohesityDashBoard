// vCenter Guest Storage — ported from frontend/src/pages/vcenter/VcGuestStoragePage.jsx.
// Volumes inside each VM (VMware Tools guest.disk) with owner, threshold state,
// growth and days to full, plus the virtual disks behind the VMs. Filtering,
// sorting and paging happen on the server; tiles cover the whole estate.
import { HardDrive, ChevronDown, ChevronUp, Search, Download } from '../icons.jsx';
import {
  apiFetch, apiFetchBlob, PageHeader, Badge, StatCard, Spinner, RefreshButton, LastUpdated,
  BRAND, fmtNum,
} from '../ui.jsx';
import { VmDetailModal } from '../vmModals.jsx';

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

function UsageBar({ pct, state }) {
  if (pct == null) return <span className="text-ink-faint">-</span>;
  const color = pctColor(state);
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden" style={{ width: 96 }}>
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

const chipStyle = (on) => ({
  fontSize: 12, padding: '6px 12px', borderRadius: 6, fontWeight: 500, cursor: 'pointer', border: 'none',
  background: on ? 'var(--vc-brand)' : 'var(--vc-surface-overlay, rgba(255,255,255,0.06))',
  color: on ? '#0B1015' : 'var(--vc-ink-muted)',
});
const selectStyle = { fontSize: 12, padding: '6px 8px', borderRadius: 8, background: 'var(--vc-surface-overlay, rgba(255,255,255,0.06))', color: 'var(--vc-ink)', border: '1px solid var(--vc-border)' };
const pagerBtn = { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--vc-border)', background: 'transparent', color: 'var(--vc-ink-muted)', cursor: 'pointer' };

function SortHeader({ col, sortBy, sortDir, onSort }) {
  const sortable = col.sortable !== false;
  const active = sortBy === col.key;
  return (
    <th
      title={col.tooltip}
      className={`${col.align === 'right' ? 'text-right' : 'text-left'} py-2 pr-3 font-medium whitespace-nowrap ${active ? 'text-brand' : ''}`}
      style={{ cursor: sortable ? 'pointer' : 'default' }}
      onClick={() => sortable && onSort(col.key)}
    >
      <span className="inline-flex items-center gap-1">
        {col.label}
        {sortable && (active
          ? (sortDir === 'desc' ? <ChevronDown size={11} /> : <ChevronUp size={11} />)
          : <ChevronDown size={11} style={{ opacity: 0.35 }} />)}
      </span>
    </th>
  );
}

function Pager({ page, totalPages, pageSize, total, onPage, onPageSize }) {
  if (!total) return null;
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 mt-1 border-t border-cohesity-border">
      <label className="flex items-center gap-2 text-xs text-ink-faint">
        Rows per page
        <select value={String(pageSize)} onChange={(e) => onPageSize(Number(e.target.value))} style={selectStyle}>
          {[25, 50, 100].map((s) => <option key={s} value={String(s)}>{s}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-faint tnum">{start}-{end} of {total}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => onPage(0)} disabled={page === 0} style={pagerBtn}>First</button>
          <button onClick={() => onPage(page - 1)} disabled={page === 0} style={pagerBtn}>Prev</button>
          <span className="text-xs text-ink-faint tnum" style={{ padding: '0 4px' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} style={pagerBtn}>Next</button>
          <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1} style={pagerBtn}>Last</button>
        </div>
      </div>
    </div>
  );
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export default function VcGuestStoragePage() {
  const [tab, setTab] = React.useState('volumes');
  const [vcenters, setVcenters] = React.useState([]);
  const [vcenterId, setVcenterId] = React.useState('');
  const [state, setState] = React.useState('attention');
  const [owner, setOwner] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [q, setQ] = React.useState('');
  const [sortBy, setSortBy] = React.useState('used_pct');
  const [sortDir, setSortDir] = React.useState('desc');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(25);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailVmId, setDetailVmId] = React.useState(null);
  const [exporting, setExporting] = React.useState(false);

  React.useEffect(() => {
    apiFetch('/vcenter/vcenters').then((json) => setVcenters(Array.isArray(json) ? json : [])).catch(() => setVcenters([]));
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = React.useCallback(() => ({
    vcenterId: vcenterId || undefined,
    state: tab === 'volumes' ? state : undefined,
    owner: owner || undefined,
    q: q || undefined,
    sortBy, sortDir, page, pageSize,
  }), [vcenterId, tab, state, owner, q, sortBy, sortDir, page, pageSize]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = tab === 'volumes' ? '/vcenter/guest-storage' : '/vcenter/vm-disks';
      const json = await apiFetch(url + buildQuery(params()));
      setData(json);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err?.payload?.error || err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [tab, params]);

  React.useEffect(() => { load(); }, [load]);

  const switchTab = (t) => {
    setTab(t);
    setData(null);
    setSortBy(t === 'volumes' ? 'used_pct' : 'capacity_bytes');
    setSortDir('desc');
    setPage(0);
  };
  const handleSort = (key) => {
    if (sortBy === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(key); setSortDir(['vm_name', 'owner', 'mount', 'label', 'datastore', 'vcenter_name'].includes(key) ? 'asc' : 'desc'); }
    setPage(0);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await apiFetchBlob('/vcenter/guest-storage.csv' + buildQuery({ ...params(), page: undefined, pageSize: undefined }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vcenter-guest-storage-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Export failed');
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
  const tileGrid = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', marginBottom: 16 };

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
        <div style={tileGrid}>
          <StatCard label="Critical volumes" value={fmtNum(summary.critical)} sub={`${fmtNum(summary.vmsCritical)} VMs`} tone={summary.critical > 0 ? 'crit' : 'default'} onClick={() => { setState('critical'); setPage(0); }} />
          <StatCard label="Warning volumes" value={fmtNum(summary.warning)} sub={`${fmtNum(summary.vmsWarning)} VMs`} tone={summary.warning > 0 ? 'warn' : 'default'} onClick={() => { setState('warning'); setPage(0); }} />
          <StatCard label="Volumes" value={fmtNum(summary.volumes)} sub={`across ${fmtNum(summary.vms)} VMs`} onClick={() => { setState('all'); setPage(0); }} />
          <StatCard label="Guest capacity" value={fmtGb(summary.capacityBytes)} sub={`${fmtGb(summary.usedBytes)} used`} tone="brand" />
          <StatCard label="No guest data" value={fmtNum(summary.poweredOnWithoutData)} sub="powered on, nothing reported" tone={summary.poweredOnWithoutData > 0 ? 'warn' : 'default'} />
          <StatCard label="Tools not running" value={fmtNum(summary.poweredOnToolsNotRunning)} sub="powered on VMs" tone={summary.poweredOnToolsNotRunning > 0 ? 'warn' : 'default'} />
        </div>
      ) : (
        <div style={tileGrid}>
          <StatCard label="Virtual disks" value={fmtNum(summary.disks)} sub={`across ${fmtNum(summary.vms)} VMs`} />
          <StatCard label="Provisioned" value={fmtGb(summary.provisionedBytes)} tone="brand" />
          <StatCard label="On datastores" value={fmtGb(summary.usedBytes)} sub={summary.provisionedBytes > 0 ? `${((summary.usedBytes / summary.provisionedBytes) * 100).toFixed(0)}% of provisioned` : ''} />
          <StatCard label="Thin provisioned" value={fmtNum(summary.thin)} sub="disks" />
        </div>
      )}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex gap-1">
            <button onClick={() => switchTab('volumes')} style={chipStyle(tab === 'volumes')}>Guest volumes</button>
            <button onClick={() => switchTab('disks')} style={chipStyle(tab === 'disks')}>Virtual disks</button>
          </div>
          <select style={selectStyle} value={vcenterId} onChange={(e) => { setVcenterId(e.target.value); setPage(0); }}>
            <option value="">All vCenters</option>
            {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {tab === 'volumes' && (
            <div className="flex gap-1 flex-wrap">
              {STATE_CHIPS.map((c) => (
                <button key={c.key} onClick={() => { setState(c.key); setPage(0); }} style={chipStyle(state === c.key)}>{c.label}</button>
              ))}
            </div>
          )}
          {tab === 'volumes' && owners.length > 0 && (
            <select style={selectStyle} value={owner} onChange={(e) => { setOwner(e.target.value); setPage(0); }} title="Owner tag (configure the category per vCenter in Settings)">
              <option value="">All owners</option>
              {owners.map((o) => <option key={o.owner} value={o.owner}>{o.owner} ({o.volumes})</option>)}
            </select>
          )}
          <div className="relative" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <Search size={12} className="text-ink-faint" style={{ position: 'absolute', left: 8 }} />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="VM, volume, owner, host..."
              className="vc-input" style={{ paddingLeft: 26, width: 224, fontSize: 12 }} />
          </div>
          <span className="ml-auto flex items-center gap-2">
            {loading && <Spinner size={13} />}
            {tab === 'volumes' && (
              <button onClick={exportCsv} disabled={exporting || !pageInfo.total} title="Download every row matching the current filters"
                className="inline-flex items-center gap-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted"
                style={{ padding: '4px 10px', background: 'transparent', cursor: 'pointer', opacity: exporting || !pageInfo.total ? 0.5 : 1 }}>
                <Download size={12} /> {exporting ? 'Exporting...' : 'Export CSV'}
              </button>
            )}
          </span>
        </div>

        {error && <div className="text-sm text-status-crit mb-3">{error}</div>}

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
                    {columns.map((col) => <SortHeader key={col.key} col={col} sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />)}
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
                          ? <button onClick={() => setDetailVmId(r.vm_row_id)} className="text-ink" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}>{r.vm_name}</button>
                          : <span className="text-ink">{r.vm_name || '-'}</span>}
                        {r.power_state && !String(r.power_state).includes('ON') && <span className="text-[10px] text-ink-faint" style={{ marginLeft: 4 }}>off</span>}
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
            <Pager page={pageInfo.page} totalPages={pageInfo.totalPages} pageSize={pageInfo.pageSize} total={pageInfo.total}
              onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(0); }} />
          </>
        )}
      </div>

      {detailVmId && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
