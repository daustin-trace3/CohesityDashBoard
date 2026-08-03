// Proxmox Nodes — ports host frontend/src/pages/proxmox/PxNodesPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner,
  useTableControls, SortTh, TableControls, TablePager,
  ServerIcon, ShieldIcon, PackageIcon, Settings2Icon, DiscIcon, CpuIcon, MemoryIcon, HardDriveIcon,
  ChevronUpIcon, ChevronDownIcon, fmtWhen, humanizeSeconds, fmtBytes,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const pct = (used, total) => (total > 0 && used != null ? (used / total) * 100 : null);

function NodeDetail({ node, detail }) {
  const services = detail?.services || [];
  const disks = detail?.disks || [];
  const nonRunningEnabled = services.filter((s) => s.unitState === 'enabled' && s.state !== 'running');

  return (
    <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
      <td colSpan={8} style={{ background: 'var(--px-surface-overlay)', padding: '12px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, fontSize: 12, marginBottom: 16 }} className="px-fact-grid">
          <style>{`@media (max-width: 700px) { .px-fact-grid { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px' }}>Load Average</p>
            <p className="px-tnum" style={{ margin: 0, color: 'var(--px-ink)' }}>{node.loadAvg || '—'}</p>
          </div>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px' }}>Kernel</p>
            <p style={{ margin: 0, color: 'var(--px-ink)' }}>{node.kernelVersion || '—'}</p>
          </div>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 4 }}><ShieldIcon size={11} /> Cert Expires</p>
            <p style={{ margin: 0, color: 'var(--px-ink)' }}>{node.certExpiresAt ? fmtWhen(node.certExpiresAt) : '—'}</p>
          </div>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 4 }}><PackageIcon size={11} /> Updates Available</p>
            <p className="px-tnum" style={{ margin: 0, color: 'var(--px-ink)' }}>{node.updatesAvailable != null ? node.updatesAvailable : '—'}</p>
          </div>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px' }}>Subscription</p>
            <p style={{ margin: 0, color: 'var(--px-ink)' }}>{node.subscriptionStatus || '—'}</p>
          </div>
          <div>
            <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', margin: '0 0 2px' }}>Uptime</p>
            <p className="px-tnum" style={{ margin: 0, color: 'var(--px-ink)' }}>{humanizeSeconds(node.uptimeSeconds)}</p>
          </div>
        </div>

        {detail == null ? (
          <div style={{ padding: '16px 0', display: 'flex', justifyContent: 'center' }}><Spinner size={16} /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }} className="px-detail-grid">
            <style>{`@media (max-width: 700px) { .px-detail-grid { grid-template-columns: 1fr !important; } }`}</style>
            <div>
              <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Settings2Icon size={11} /> Services{nonRunningEnabled.length > 0 ? ` (${nonRunningEnabled.length} down)` : ''}
              </p>
              {services.length === 0 ? (
                <p style={{ color: 'var(--px-ink-faint)', fontSize: 11 }}>No service data.</p>
              ) : (
                <div className="px-scroll" style={{ maxHeight: 192, overflowY: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 11 }}>
                    <tbody>
                      {services.map((s, i) => {
                        const down = s.unitState === 'enabled' && s.state !== 'running';
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(31,43,55,0.3)', background: down ? 'rgba(251,191,36,0.1)' : undefined }}>
                            <td className="px-tnum" style={{ padding: '4px 8px 4px 0', color: 'var(--px-ink)' }}>{s.name}</td>
                            <td style={{ padding: '4px 8px 4px 0', color: 'var(--px-ink-faint)' }}>{s.unitState || '—'}</td>
                            <td style={{ padding: '4px 0' }}><Badge tone={s.state === 'running' ? 'ok' : down ? 'warn' : 'neutral'}>{s.state || '—'}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--px-ink-faint)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                <DiscIcon size={11} /> Disks
              </p>
              {disks.length === 0 ? (
                <p style={{ color: 'var(--px-ink-faint)', fontSize: 11 }}>No disk data.</p>
              ) : (
                <div className="px-scroll" style={{ maxHeight: 192, overflowY: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 11 }}>
                    <tbody>
                      {disks.map((d, i) => {
                        const failing = d.health && !['PASSED', 'OK', 'UNKNOWN', ''].includes(d.health);
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(31,43,55,0.3)', background: failing ? 'rgba(248,113,113,0.1)' : undefined }}>
                            <td className="px-tnum" style={{ padding: '4px 8px 4px 0', color: 'var(--px-ink)' }}>{d.devpath}</td>
                            <td style={{ padding: '4px 8px 4px 0', color: 'var(--px-ink-faint)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.model}>{d.model || '—'}</td>
                            <td className="px-tnum" style={{ padding: '4px 8px 4px 0', color: 'var(--px-ink-muted)' }}>{fmtBytes(d.sizeBytes)}</td>
                            <td style={{ padding: '4px 0' }}><Badge tone={failing ? 'crit' : 'neutral'}>{d.health || '—'}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function PxNodesPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [open, setOpen] = React.useState(() => new Set());
  const [details, setDetails] = React.useState({});
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return apiGet('/nodes')
      .then((d) => { setRows(d); setLastRefreshed(new Date()); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const toggle = (n) => {
    const key = `${n.serverId}|${n.name}`;
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (!details[n.id]) {
      apiGet(`/nodes/${n.id}/detail`)
        .then((d) => setDetails((cur) => ({ ...cur, [n.id]: d })))
        .catch(() => setDetails((cur) => ({ ...cur, [n.id]: { services: [], disks: [], networks: [] } })));
    }
  };

  const list = (rows || []).map((n) => ({
    ...n,
    cpu_pct: pct(n.cpuUsage != null ? n.cpuUsage * (n.cpuTotal || 1) : null, n.cpuTotal),
    mem_pct: pct(n.memUsed, n.memTotal),
    disk_pct: pct(n.diskUsed, n.diskTotal),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'serverName', 'status'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={ServerIcon} title="Nodes" description="Proxmox node state, utilization and per-node details across all registered servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>All Nodes</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by node, server or status…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'status', label: 'Status' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading nodes…" height={140} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No nodes found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No nodes match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', width: 24 }} />
                  <SortTh k="name" label="Node" ctl={ctl} />
                  <SortTh k="serverName" label="Server" ctl={ctl} />
                  <SortTh k="status" label="Status" ctl={ctl} />
                  <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                  <SortTh k="mem_pct" label="Memory" ctl={ctl} align="right" />
                  <SortTh k="disk_pct" label="Disk" ctl={ctl} align="right" />
                  <SortTh k="pveVersion" label="PVE Ver" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((n) => {
                  const key = `${n.serverId}|${n.name}`;
                  const isOpen = open.has(key);
                  return (
                    <React.Fragment key={key}>
                      <tr className="px-row" style={{ borderBottom: '1px solid var(--px-border)', cursor: 'pointer' }} onClick={() => toggle(n)}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)' }}>{isOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{n.name || '—'}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{n.serverName}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={n.status === 'online' ? 'ok' : 'crit'}>{n.status || 'unknown'}</Badge></td>
                        <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: n.cpu_pct > 80 ? 'var(--px-warn)' : 'var(--px-ink-muted)', fontWeight: n.cpu_pct > 80 ? 600 : 400 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><CpuIcon size={11} style={{ color: 'var(--px-ink-faint)' }} />{n.cpu_pct != null ? `${n.cpu_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: n.mem_pct > 80 ? 'var(--px-warn)' : 'var(--px-ink-muted)', fontWeight: n.mem_pct > 80 ? 600 : 400 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><MemoryIcon size={11} style={{ color: 'var(--px-ink-faint)' }} />{n.mem_pct != null ? `${n.mem_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: n.disk_pct > 80 ? 'var(--px-warn)' : 'var(--px-ink-muted)', fontWeight: n.disk_pct > 80 ? 600 : 400 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><HardDriveIcon size={11} style={{ color: 'var(--px-ink-faint)' }} />{n.disk_pct != null ? `${n.disk_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{n.pveVersion || '—'}</td>
                      </tr>
                      {isOpen && <NodeDetail node={n} detail={details[n.id]} />}
                    </React.Fragment>
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
