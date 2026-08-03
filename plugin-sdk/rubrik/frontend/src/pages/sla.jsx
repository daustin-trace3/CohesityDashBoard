import { ACCENT, AMBER, MUTED, panelStyle, thStyle, tdStyle, Donut, useFetch, PageShell } from './_shared';

export default function SlaDomainsPage() {
  const { data, error } = useFetch('/sla-domains');
  return (
    <PageShell title="Rubrik SLA Domains" error={error}>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Frequency</th>
                <th style={thStyle}>Retention</th>
                <th style={thStyle}>Objects</th>
                <th style={thStyle}>Compliance</th>
                <th style={thStyle}>Archival</th>
                <th style={thStyle}>Replication</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td style={tdStyle}>{s.name}</td>
                  <td style={tdStyle}>{s.snapshotFrequency}</td>
                  <td style={tdStyle}>{s.retention}</td>
                  <td style={tdStyle}>{s.objectCount}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Donut pct={s.compliancePct} size={32} stroke={5} color={s.compliancePct >= 95 ? ACCENT : AMBER} label=" " />
                      <span>{s.compliancePct}%</span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, color: MUTED }}>{s.archivalLocation || '—'}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>{s.replicationTarget || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
