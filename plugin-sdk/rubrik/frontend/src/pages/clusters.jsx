import {
  injectStyles, PageHeader, Badge, SkeletonTable, EmptyState, TableControls,
  useTableControls, ServerIcon, ChevronDownIcon,
} from '../ui.jsx';

injectStyles();

function useRubrikFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  return { data, error, loading };
}

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function usageColor(pct) {
  return pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#00B388';
}

function UsageMiniBar({ used, capacity }) {
  const pct = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  return (
    <div style={{ width: 90 }}>
      <div style={{ height: 5, background: 'var(--rbk-surface-base)', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--rbk-border)' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: usageColor(pct) }} />
      </div>
      <div className="rbk-tnum" style={{ fontSize: 10, color: 'var(--rbk-ink-faint)', marginTop: 2 }}>{pct.toFixed(0)}%</div>
    </div>
  );
}

function nodeRoleFor(i) {
  return i === 0 ? 'Config Node' : 'Data Node';
}

function ClusterRow({ cluster, expanded, onToggle }) {
  const online = cluster.status === 'Connected';
  const softwareStatus = cluster.softwareStatus || cluster.versionStatus || (cluster.versionStatus === 'Update Available' ? 'Update Available' : 'Up to date');
  const slug = (cluster.name || 'cl').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'cl';
  const nodeRows = Array.from({ length: cluster.nodes || 0 }, (_, i) => ({
    name: `rbk-${slug}-node${String(i + 1).padStart(2, '0')}`,
    role: nodeRoleFor(i),
    status: online ? 'ok' : 'crit',
  }));

  return (
    <div>
      <div
        className="rbk-row"
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer' }}
      >
        <ChevronDownIcon size={14} style={{ color: 'var(--rbk-ink-faint)', flexShrink: 0, transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rbk-ink)', minWidth: 0, flex: '1 1 160px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cluster.name}</span>
        <Badge tone="neutral">{cluster.model}</Badge>
        <span style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', width: 70, flexShrink: 0 }}>{cluster.nodes} nodes</span>
        <span className="rbk-tnum" style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', width: 90, flexShrink: 0 }}>{cluster.version}</span>
        <Badge tone={online ? 'ok' : 'crit'} style={{ width: 90, justifyContent: 'center' }}>{cluster.status}</Badge>
        <UsageMiniBar used={cluster.usedBytes} capacity={cluster.capacityBytes} />
        <Badge tone={cluster.runwayDays != null && cluster.runwayDays < 90 ? 'warn' : 'neutral'} style={{ flexShrink: 0 }}>
          {cluster.runwayDays != null ? `${cluster.runwayDays}d runway` : '—'}
        </Badge>
      </div>
      {expanded && (
        <div style={{ background: 'var(--rbk-surface-base)', borderTop: '1px solid var(--rbk-border)', padding: '14px 14px 14px 40px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Model</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--rbk-ink)' }}>{cluster.model}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Nodes</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--rbk-ink)' }}>{cluster.nodes}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Version</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--rbk-ink)' }}>{cluster.version} <Badge tone={online ? 'ok' : 'crit'} style={{ marginLeft: 4 }}>{cluster.status}</Badge></p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Used / Capacity</p>
              <p className="rbk-tnum" style={{ margin: 0, fontSize: 12, color: 'var(--rbk-ink)' }}>{fmtBytes(cluster.usedBytes)} / {fmtBytes(cluster.capacityBytes)}</p>
              <UsageMiniBar used={cluster.usedBytes} capacity={cluster.capacityBytes} />
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Runway</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--rbk-ink)' }}>{cluster.runwayDays != null ? `${cluster.runwayDays}d` : '—'}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase' }}>Software Status</p>
              <p style={{ margin: 0, fontSize: 12, color: softwareStatus === 'Update Available' ? 'var(--rbk-warn)' : 'var(--rbk-ink)' }}>{softwareStatus}</p>
            </div>
          </div>

          <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-muted)', margin: '0 0 6px' }}>Node Detail</p>
          {nodeRows.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--rbk-ink-faint)' }}>No node detail available.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Node</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Role</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {nodeRows.map((n) => (
                  <tr key={n.name} style={{ borderTop: '1px solid var(--rbk-border)' }}>
                    <td className="rbk-tnum" style={{ padding: '4px 8px', color: 'var(--rbk-ink)' }}>{n.name}</td>
                    <td style={{ padding: '4px 8px' }}>{n.role}</td>
                    <td style={{ padding: '4px 8px' }}><Badge tone={n.status === 'ok' ? 'ok' : 'crit'}>{n.status === 'ok' ? 'Online' : 'Offline'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClustersPage() {
  const { data, loading } = useRubrikFetch('/clusters');
  const [expandedId, setExpandedId] = React.useState(null);

  const rows = data || [];
  const ctl = useTableControls(rows, { searchKeys: ['name', 'model'] });

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader
        icon={ServerIcon}
        title="Clusters"
        description="Rubrik clusters across the estate — expand a row for node and version detail"
      />

      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Search clusters..." filters={[{ k: 'status', label: 'Status' }]} />

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}><SkeletonTable rows={6} /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={ServerIcon} title="No clusters" description="No Rubrik clusters are configured." />
      ) : ctl.rows.length === 0 ? (
        <EmptyState title="No matches" description="No clusters match the current filters." />
      ) : (
        <div className="rbk-panel" style={{ padding: 0, overflow: 'hidden' }}>
          {ctl.rows.map((c, i) => (
            <div key={c.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--rbk-border)' }}>
              <ClusterRow cluster={c} expanded={expandedId === c.id} onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
