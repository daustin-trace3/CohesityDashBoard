import { RED, AMBER, TEXT, panelStyle, thStyle, tdStyle, UsageBar, StatusPill, useFetch, PageShell } from './_shared';

export default function ClustersPage() {
  const { data, error } = useFetch('/clusters');
  return (
    <PageShell title="Rubrik Clusters" error={error}>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Nodes</th>
                <th style={thStyle}>Version</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Runway</th>
                <th style={thStyle}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td style={tdStyle}>{c.name}</td>
                  <td style={tdStyle}>{c.model}</td>
                  <td style={tdStyle}>{c.nodes}</td>
                  <td style={tdStyle}>
                    {c.version}{' '}
                    {c.versionStatus === 'Update Available' && (
                      <span style={{ color: AMBER, fontSize: 11 }}>(update available)</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <StatusPill status={c.status === 'Connected' ? 'Succeeded' : c.status} />
                  </td>
                  <td style={{ ...tdStyle, color: c.runwayDays <= 60 ? RED : c.runwayDays <= 180 ? AMBER : TEXT }}>
                    {c.runwayDays != null ? `${c.runwayDays}d` : '—'}
                  </td>
                  <td style={{ ...tdStyle, width: 220 }}>
                    <UsageBar used={c.usedBytes} capacity={c.capacityBytes} />
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
