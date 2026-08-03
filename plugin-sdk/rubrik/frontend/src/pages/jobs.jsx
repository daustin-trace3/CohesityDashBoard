import { ACCENT, PANEL_BG, BORDER, TEXT, RED, MUTED, panelStyle, thStyle, tdStyle, StatusPill, useFetch, PageShell, formatWhen, formatDuration, formatBytes } from './_shared';

const JOB_TYPES = ['All', 'Backup', 'Replication', 'Archival'];

export default function JobsPage() {
  const { data, error } = useFetch('/jobs');
  const [filter, setFilter] = React.useState('All');
  const rows = (data || []).filter((j) => filter === 'All' || j.jobType === filter);

  return (
    <PageShell title="Rubrik Jobs" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        {JOB_TYPES.map((t) => (
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
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Object</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Duration</th>
                <th style={thStyle}>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} style={{ background: j.status === 'Failed' ? `${RED}14` : 'transparent' }}>
                  <td style={tdStyle}>{j.objectName}</td>
                  <td style={tdStyle}>{j.jobType}</td>
                  <td style={tdStyle}>{j.clusterName}</td>
                  <td style={tdStyle}>
                    <StatusPill status={j.status} />
                  </td>
                  <td style={tdStyle}>{formatWhen(j.startedAt)}</td>
                  <td style={tdStyle}>{formatDuration(j.durationSeconds)}</td>
                  <td style={tdStyle}>{formatBytes(j.dataTransferredBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((j) => j.status === 'Failed') && (
            <div style={{ padding: 10, borderTop: `1px solid ${BORDER}` }}>
              {rows
                .filter((j) => j.status === 'Failed')
                .map((j) => (
                  <div key={j.id} style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
                    <span style={{ color: RED, fontWeight: 600 }}>{j.objectName}:</span> {j.errorMessage}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
