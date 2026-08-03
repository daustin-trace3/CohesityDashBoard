import { ACCENT, RED, AMBER, TEXT, MUTED, BORDER, panelStyle, thStyle, tdStyle, StatusPill, PulsingDot, useFetch, PageShell, formatWhen } from './_shared';

export default function SecurityPage() {
  const { data, error } = useFetch('/security');
  return (
    <PageShell title="Rubrik Threat Monitoring" error={error}>
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Open Anomalies</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.openAnomalies > 0 ? RED : ACCENT }}>
                {data.summary.openAnomalies}
              </div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Quarantined Snapshots</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.quarantinedSnapshots > 0 ? AMBER : TEXT }}>
                {data.summary.quarantinedSnapshots}
              </div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Running Hunts</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.summary.runningHunts}</div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>IOC Matches</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.matches > 0 ? RED : TEXT }}>{data.summary.matches}</div>
            </div>
          </div>

          <div style={{ ...panelStyle(), marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Radar Anomalies</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Object</th>
                  <th style={thStyle}>Cluster</th>
                  <th style={thStyle}>Probability</th>
                  <th style={thStyle}>Encryption</th>
                  <th style={thStyle}>Quarantined</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Detected</th>
                </tr>
              </thead>
              <tbody>
                {data.anomalies.map((a) => (
                  <tr key={a.id} style={{ background: a.status === 'Open' ? `${RED}14` : 'transparent' }}>
                    <td style={tdStyle}>
                      {a.objectName} <span style={{ color: MUTED }}>({a.objectType})</span>
                    </td>
                    <td style={tdStyle}>{a.cluster}</td>
                    <td style={{ ...tdStyle, width: 160 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 6, background: '#141414', borderRadius: 4, border: `1px solid ${BORDER}` }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.round(a.anomalyProbability * 100)}%`,
                              background: a.anomalyProbability >= 0.7 ? RED : a.anomalyProbability >= 0.4 ? AMBER : ACCENT,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 11, color: MUTED }}>{Math.round(a.anomalyProbability * 100)}%</span>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {a.encryptionDetected ? <StatusPill status="Detected" tone="bad" /> : <span style={{ color: MUTED }}>—</span>}
                    </td>
                    <td style={tdStyle}>{a.snapshotQuarantined ? <StatusPill status="Quarantined" tone="warn" /> : '—'}</td>
                    <td style={tdStyle}>
                      <StatusPill status={a.status} />
                    </td>
                    <td style={tdStyle}>{formatWhen(a.detectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Threat Hunts</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>IOC Type</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Scanned (clusters/snaps/objects)</th>
                  <th style={thStyle}>Matches</th>
                  <th style={thStyle}>Started</th>
                </tr>
              </thead>
              <tbody>
                {data.hunts.map((h) => (
                  <tr key={h.id} style={{ background: h.matchesFound > 0 ? `${RED}14` : 'transparent' }}>
                    <td style={tdStyle}>{h.name}</td>
                    <td style={tdStyle}>{h.iocType}</td>
                    <td style={tdStyle}>
                      {h.status === 'Running' && <PulsingDot color={ACCENT} />}
                      <StatusPill status={h.status} />
                    </td>
                    <td style={{ ...tdStyle, color: MUTED }}>
                      {h.clustersScanned} / {h.snapshotsScanned} / {h.objectsScanned}
                    </td>
                    <td style={{ ...tdStyle, color: h.matchesFound > 0 ? RED : MUTED, fontWeight: h.matchesFound > 0 ? 700 : 400 }}>
                      {h.matchesFound}
                    </td>
                    <td style={tdStyle}>{formatWhen(h.startedAt)}</td>
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
