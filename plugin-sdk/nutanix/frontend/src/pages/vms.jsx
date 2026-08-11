// Nutanix VMs — port of NxVMsPage.jsx onto the nx- style kit. VM names link
// to Server 360 via ReactRouterDOM.Link (global, not an import).
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  MonitorIcon, fmtNum, ppmPct, powerTone, powerLabel, parseJsonArr,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

const ngtTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (!s) return 'neutral';
  if (v.includes('enabled') || v.includes('installed') || v.includes('reachable') || v.includes('current')) return 'ok';
  return 'warn';
};
const fmtMem = (mb) => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`);

export default function VmsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/vms', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setRows(json.vms || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((v) => {
    const ips = parseJsonArr(v.ip_addresses);
    return {
      ...v,
      power: powerLabel(v.power_state),
      ip: ips[0] || '',
      ip_extra: ips.length > 1 ? ips.length - 1 : 0,
      cpu_pct: ppmPct(v.cpu_usage_ppm),
      mem_pct: ppmPct(v.memory_usage_ppm),
    };
  });
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'guest_os', 'host_name', 'cluster_name', 'ip'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={MonitorIcon} title="VMs" description="Every VM across all registered Nutanix clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, OS, host, cluster or IP…"
          filters={[
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'power', label: 'Power states' },
            { k: 'guest_os', label: 'Guest OS' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading VMs…" height={160} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No VMs found — data appears after the next poll.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No VMs match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
                <SortTh k="name" label="VM" ctl={ctl} />
                <SortTh k="power" label="Power" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU %" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem %" ctl={ctl} align="right" />
                <SortTh k="host_name" label="Host" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="num_vcpus" label="vCPU" ctl={ctl} align="right" />
                <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
                <SortTh k="ip" label="IP" ctl={ctl} />
                <SortTh k="ngt_status" label="NGT" ctl={ctl} />
                <SortTh k="guest_os" label="Guest OS" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.id} className="nx-row">
                    <td style={td}>
                      {v.name ? (
                        <ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(v.name)}`} title="Open Server 360"
                          style={{ color: 'var(--nx-ink)', fontWeight: 500, textDecoration: 'none' }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--nx-brand)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nx-ink)'; }}>{v.name}</ReactRouterDOM.Link>
                      ) : '—'}
                    </td>
                    <td style={td}><Badge tone={powerTone(v.power_state)}>{v.power}</Badge></td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{v.cpu_pct != null ? `${v.cpu_pct.toFixed(0)}%` : '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{v.mem_pct != null ? `${v.mem_pct.toFixed(0)}%` : '—'}</td>
                    <td style={tdMuted}>{v.host_name || '—'}</td>
                    <td style={tdMuted}>{v.cluster_name || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(v.num_vcpus)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtMem(v.memory_mb)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{v.ip || '—'}{v.ip_extra ? ` +${v.ip_extra}` : ''}</td>
                    <td style={td}><Badge tone={ngtTone(v.ngt_status)}>{v.ngt_status || 'Unknown'}</Badge></td>
                    <td style={{ ...tdMuted, fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.guest_os || ''}>{v.guest_os || '—'}</td>
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
