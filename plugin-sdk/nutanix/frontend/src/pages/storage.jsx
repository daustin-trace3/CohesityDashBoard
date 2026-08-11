// Nutanix Storage — port of NxStoragePage.jsx onto the nx- style kit.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, UsageBar,
  DbIcon, HardDriveIcon, fmtBytes, fmtRatio,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

export default function StoragePage() {
  const [containers, setContainers] = React.useState(null);
  const [disks, setDisks] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/storage', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setContainers(json.containers || []); setDisks(json.disks || []); setLastRefreshed(new Date()); })
    .catch(() => { setContainers([]); setDisks([]); }), []);

  React.useEffect(() => { load(); }, [load]);

  const containerList = (containers || []).map((c) => ({
    ...c,
    used_pct: c.capacity_bytes > 0 ? (c.usage_bytes / c.capacity_bytes) * 100 : null,
  }));
  const ctl = useTableControls(containerList, {
    searchKeys: ['name', 'cluster_name'],
    defaultSortKey: 'used_pct', defaultSortDir: 'desc',
    paginate: true,
  });

  const diskList = (disks || []).map((d) => ({ ...d, status_label: d.bad ? 'BAD' : d.online === 0 ? 'OFFLINE' : (d.status || 'ONLINE') }));
  const diskCtl = useTableControls(diskList, {
    searchKeys: ['serial', 'model', 'vendor', 'tier', 'host_name'],
    defaultSortKey: 'host_name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={DbIcon} title="Storage" description="Storage containers and physical disks across all clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)' }}>Containers</p>
        <TableControls ctl={ctl} rows={containerList} searchPlaceholder="Filter by container or cluster…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }]} />
        {containers == null ? (
          <LoadingPanel label="Loading containers…" height={140} />
        ) : containerList.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No containers found.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No containers match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
                <SortTh k="name" label="Container" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="replication_factor" label="RF" ctl={ctl} align="right" />
                <th style={{ ...td, fontSize: 11, textTransform: 'uppercase', color: 'var(--nx-ink-faint)' }}>Efficiency</th>
                <SortTh k="capacity_bytes" label="Capacity" ctl={ctl} align="right" />
                <SortTh k="free_bytes" label="Free" ctl={ctl} align="right" />
                <SortTh k="reduction_ratio_ppm" label="Reduction" ctl={ctl} align="right" />
                <SortTh k="used_pct" label="Used" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="nx-row">
                    <td style={td}>{c.name || '—'}</td>
                    <td style={tdMuted}>{c.cluster_name || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{c.replication_factor ?? '—'}</td>
                    <td style={td}>
                      {c.compression_enabled ? <Badge tone="info" style={{ marginRight: 4 }}>Compress</Badge> : null}
                      {c.dedup_enabled ? <Badge tone="info" style={{ marginRight: 4 }}>Dedup</Badge> : null}
                      {c.erasure_code ? <Badge tone="info">EC-X</Badge> : null}
                    </td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtBytes(c.capacity_bytes)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtBytes(c.free_bytes)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtRatio(c.reduction_ratio_ppm)}</td>
                    <td style={td}><UsageBar pct={c.used_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <HardDriveIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Physical Disks
        </p>
        <TableControls ctl={diskCtl} rows={diskList} searchPlaceholder="Filter by serial, model, tier or host…"
          filters={[{ k: 'tier', label: 'Tiers' }, { k: 'status_label', label: 'Status' }]} />
        {disks == null ? (
          <LoadingPanel label="Loading disks…" height={140} />
        ) : diskList.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No disk data collected.</div>
        ) : diskCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No disks match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
                <SortTh k="serial" label="Serial" ctl={diskCtl} />
                <SortTh k="host_name" label="Host" ctl={diskCtl} />
                <SortTh k="model" label="Model" ctl={diskCtl} />
                <SortTh k="tier" label="Tier" ctl={diskCtl} />
                <SortTh k="size_bytes" label="Size" ctl={diskCtl} align="right" />
                <SortTh k="status_label" label="Status" ctl={diskCtl} />
              </tr></thead>
              <tbody>
                {diskCtl.pageRows.map((d) => (
                  <tr key={d.id} className="nx-row">
                    <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{d.serial || '—'}</td>
                    <td style={tdMuted}>{d.host_name || '—'}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{[d.vendor, d.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{d.tier || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtBytes(d.size_bytes)}</td>
                    <td style={td}><Badge tone={d.bad ? 'crit' : d.online === 0 ? 'warn' : 'ok'}>{d.status_label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={diskCtl} />
      </div>
    </div>
  );
}
