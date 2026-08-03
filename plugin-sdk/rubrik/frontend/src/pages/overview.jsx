import { MUTED, RED, ACCENT, panelStyle, thStyle, tdStyle, UsageBar, Donut, useFetch, PageShell, SecurityBanner, formatWhen } from './_shared';

export default function OverviewPage() {
  const { data, error } = useFetch('/overview');
  const { data: jobs } = useFetch('/jobs');
  const { data: slaDomains } = useFetch('/sla-domains');
  const failedJobs = (jobs || []).filter((j) => j.status === 'Failed').slice(0, 5);

  return (
    <PageShell title="Rubrik Overview" error={error}>
      {data && (
        <>
          <SecurityBanner overview={data} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Clusters</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>{data.clusters}</div>
              {data.capacity && data.capacity.runwayDays != null && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>min runway {data.capacity.runwayDays}d</div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Protected Objects</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#E5E5E5' }}>{data.objects}</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{data.slaCompliancePct}% SLA compliant</div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Jobs (24h)</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#E5E5E5' }}>{data.jobs24h}</div>
              {data.failed24h > 0 && <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>{data.failed24h} failed</div>}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Capacity Used</div>
              <UsageBar used={data.usedBytes} capacity={data.capacityBytes} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: '#E5E5E5' }}>SLA Compliance</div>
              {slaDomains && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <Donut pct={data.slaCompliancePct} />
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {slaDomains
                        .filter((s) => s.objectCount > 0)
                        .map((s) => (
                          <tr key={s.id}>
                            <td style={{ ...tdStyle, padding: '4px 6px' }}>{s.name}</td>
                            <td style={{ ...tdStyle, padding: '4px 6px', color: MUTED }}>{s.objectCount} obj</td>
                            <td style={{ ...tdStyle, padding: '4px 6px', color: s.compliancePct >= 95 ? ACCENT : '#D4A24E' }}>
                              {s.compliancePct}%
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: '#E5E5E5' }}>Recent Failed Jobs</div>
              {failedJobs.length === 0 && <div style={{ fontSize: 13, color: MUTED }}>No failed jobs in the last 24h.</div>}
              {failedJobs.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Object</th>
                      <th style={thStyle}>Cluster</th>
                      <th style={thStyle}>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobs.map((j) => (
                      <tr key={j.id}>
                        <td style={tdStyle}>{j.objectName}</td>
                        <td style={tdStyle}>{j.clusterName}</td>
                        <td style={tdStyle}>{formatWhen(j.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
