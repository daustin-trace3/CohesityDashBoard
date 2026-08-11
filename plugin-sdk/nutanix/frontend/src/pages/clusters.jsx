// Nutanix Clusters — port of NxClustersPage.jsx onto the nx- style kit.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  ServerIcon, fmtNum, fmtRatio, ftTone, ftLabel,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

export default function ClustersPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/clusters', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setRows(json.clusters || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((c) => ({
    ...c,
    usage_pct: c.usage_pct ?? (c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null),
    is_ce: !!(c.is_ce ?? c.source_is_ce),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'aos_version', 'source_name', 'uuid'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={ServerIcon} title="Clusters" description="Nutanix clusters across all registered Prism sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by cluster, AOS version or source…"
          filters={[{ k: 'source_name', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading clusters…" height={160} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No clusters found — register a Prism source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No clusters match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
                <SortTh k="name" label="Cluster" ctl={ctl} />
                <SortTh k="source_name" label="Source" ctl={ctl} />
                <SortTh k="aos_version" label="AOS" ctl={ctl} />
                <SortTh k="num_nodes" label="Nodes" ctl={ctl} align="right" />
                <SortTh k="redundancy_factor" label="RF" ctl={ctl} align="right" />
                <th style={{ ...td, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nx-ink-faint)' }}>FT Tolerable</th>
                <SortTh k="usage_pct" label="Storage Used" ctl={ctl} align="right" />
                <SortTh k="overall_reduction_ratio_ppm" label="Reduction" ctl={ctl} align="right" />
                <SortTh k="runway_days" label="Runway" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="nx-row">
                    <td style={td}>
                      {c.name || c.uuid}
                      {c.is_ce && <Badge tone="info" style={{ marginLeft: 6 }}>CE</Badge>}
                    </td>
                    <td style={tdMuted}>{c.source_name}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{c.aos_version || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(c.num_nodes)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{c.redundancy_factor ?? '—'}</td>
                    <td style={td}><Badge tone={ftTone(c)}>{ftLabel(c)}</Badge></td>
                    <td className="nx-tnum" style={{ ...td, textAlign: 'right', color: c.usage_pct > 80 ? 'var(--nx-warn)' : 'var(--nx-ink-muted)', fontWeight: c.usage_pct > 80 ? 600 : 400 }}>{c.usage_pct != null ? `${c.usage_pct.toFixed(0)}%` : '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtRatio(c.overall_reduction_ratio_ppm ?? c.reduction_ratio_ppm)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{c.runway_days != null ? `${c.runway_days}d` : '—'}</td>
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
