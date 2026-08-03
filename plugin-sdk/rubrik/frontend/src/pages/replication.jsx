import { AMBER, TEXT, MUTED, panelStyle, thStyle, tdStyle, StatusPill, useFetch, PageShell, formatWhen, formatLag, formatBytes } from './_shared';

export default function ReplicationPage() {
  const { data, error } = useFetch('/replication');
  return (
    <PageShell title="Rubrik Replication & Archival" error={error}>
      {data && (
        <>
          <div style={{ ...panelStyle(), marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Replication Pairs</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Target</th>
                  <th style={thStyle}>Objects</th>
                  <th style={thStyle}>Lag</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Last Sync</th>
                </tr>
              </thead>
              <tbody>
                {data.pairs.map((p) => (
                  <tr key={p.id} style={{ background: p.status === 'Lagging' ? `${AMBER}14` : 'transparent' }}>
                    <td style={tdStyle}>{p.sourceCluster}</td>
                    <td style={tdStyle}>{p.targetCluster}</td>
                    <td style={tdStyle}>{p.objects}</td>
                    <td style={{ ...tdStyle, color: p.status === 'Lagging' ? AMBER : TEXT }}>{formatLag(p.lagSeconds)}</td>
                    <td style={tdStyle}>
                      <StatusPill status={p.status} />
                    </td>
                    <td style={tdStyle}>{formatWhen(p.lastSyncAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
              {data.pairs.map((p) => `${p.sourceCluster} → ${p.targetCluster}`).join('   •   ')}
            </div>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Archival Locations</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Archived</th>
                  <th style={thStyle}>Objects</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.archival.map((a) => (
                  <tr key={a.id}>
                    <td style={tdStyle}>{a.name}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          background: a.type === 'S3' ? `${AMBER}26` : '#3b82f626',
                          color: a.type === 'S3' ? AMBER : '#60a5fa',
                          border: `1px solid ${a.type === 'S3' ? AMBER : '#3b82f6'}`,
                        }}
                      >
                        {a.type}
                      </span>
                    </td>
                    <td style={tdStyle}>{formatBytes(a.archivedBytes)}</td>
                    <td style={tdStyle}>{a.objectCount}</td>
                    <td style={tdStyle}>
                      <StatusPill status={a.status === 'Active' ? 'Succeeded' : a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PageShell>
  );
}
