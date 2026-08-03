import { ACCENT, PANEL_BG, BORDER, TEXT, MUTED, RED, panelStyle, thStyle, tdStyle, useFetch, PageShell, formatWhen, formatBytes } from './_shared';

const OBJECT_TYPES = ['All', 'VM', 'MSSQL DB', 'NAS Share', 'EC2 Instance'];

export default function ObjectsPage() {
  const { data, error } = useFetch('/objects');
  const [filter, setFilter] = React.useState('All');
  const [slaFilter, setSlaFilter] = React.useState('All');
  const [clusterFilter, setClusterFilter] = React.useState('All');
  const slaOptions = ['All', ...new Set((data || []).map((o) => o.slaDomain))];
  const clusterOptions = ['All', ...new Set((data || []).map((o) => o.clusterName))];
  const rows = (data || []).filter(
    (o) =>
      (filter === 'All' || o.type === filter) &&
      (slaFilter === 'All' || o.slaDomain === slaFilter) &&
      (clusterFilter === 'All' || o.clusterName === clusterFilter)
  );

  return (
    <PageShell title="Rubrik Protected Objects" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {OBJECT_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${filter === t ? ACCENT : BORDER}`,
                background: filter === t ? `${ACCENT}26` : PANEL_BG,
                color: filter === t ? ACCENT : TEXT,
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <select
          value={slaFilter}
          onChange={(e) => setSlaFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {slaOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={clusterFilter}
          onChange={(e) => setClusterFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {clusterOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>SLA Domain</th>
                <th style={thStyle}>Next Snapshot</th>
                <th style={thStyle}>Snapshots</th>
                <th style={thStyle}>Local / Archived</th>
                <th style={thStyle}>Compliance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} style={{ background: o.compliant ? 'transparent' : `${RED}14` }}>
                  <td style={tdStyle}>{o.name}</td>
                  <td style={tdStyle}>{o.type}</td>
                  <td style={tdStyle}>{o.clusterName}</td>
                  <td style={tdStyle}>{o.slaDomain}</td>
                  <td style={tdStyle}>{formatWhen(o.nextSnapshotAt)}</td>
                  <td style={tdStyle}>{o.snapshotCount}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>
                    {formatBytes(o.localStorageBytes)} / {formatBytes(o.archivedBytes)}
                  </td>
                  <td style={{ ...tdStyle, color: o.compliant ? ACCENT : RED, fontWeight: 600 }}>
                    {o.compliant ? 'Compliant' : 'Out of Compliance'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
