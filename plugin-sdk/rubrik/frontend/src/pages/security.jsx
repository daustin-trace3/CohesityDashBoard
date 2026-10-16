// Rubrik v2.0.0 Threat Monitoring page — restyled onto the rbk- kit (./ui).
// Same data, same fetch (/security), same summary/anomalies/hunts content.

import {
  PageHeader, StatCard, Badge, SkeletonTable, EmptyState, RefreshButton,
  useTableControls, SortTh,
  ShieldIcon,
} from '../ui';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(typeof iso === 'string' && !iso.includes('T') ? iso.replace(' ', 'T') + 'Z' : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffH = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  if (diffH < -1) return `in ${Math.round(-diffH)}h`;
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 48) return `${Math.round(diffH)}h ago`;
  return d.toLocaleString();
}

function StatusBadge({ status }) {
  const isBad = status === 'Failed' || status === 'Lagging' || status === 'Critical' || status === 'Open';
  const isWarn = status === 'Warning' || status === 'Investigating';
  const tone = isBad ? 'crit' : isWarn ? 'warn' : 'ok';
  return <Badge tone={tone}>{status}</Badge>;
}

function PulsingDot({ color = 'var(--rbk-brand)' }) {
  return (
    <span
      className="rbk-orb"
      style={{ background: color, marginRight: 6 }}
    />
  );
}

export default function SecurityPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const loadSecurity = React.useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/security')
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { loadSecurity(); }, [loadSecurity]);

  const anomalies = data?.anomalies || [];
  const hunts = data?.hunts || [];

  const anomalyCtl = useTableControls(anomalies, {
    defaultSortKey: 'detectedAt',
    defaultSortDir: 'desc',
  });
  const huntCtl = useTableControls(hunts, {
    defaultSortKey: 'startedAt',
    defaultSortDir: 'desc',
  });

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ShieldIcon} title="Threat Monitoring" description="Radar anomaly detection, snapshot quarantine, and IOC threat hunts">
        <RefreshButton onClick={loadSecurity} refreshing={loading} />
      </PageHeader>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <SkeletonTable rows={6} colWidths={['20%', '14%', '16%', '12%', '12%', '12%', '14%']} />
        </div>
      ) : !data ? null : (
        <>
          <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            <StatCard label="Open Anomalies" value={data.summary.openAnomalies} tone={data.summary.openAnomalies > 0 ? 'crit' : 'ok'} />
            <StatCard label="Quarantined Snapshots" value={data.summary.quarantinedSnapshots} tone={data.summary.quarantinedSnapshots > 0 ? 'warn' : 'default'} />
            <StatCard label="Running Hunts" value={data.summary.runningHunts} />
            <StatCard label="IOC Matches" value={data.summary.matches} tone={data.summary.matches > 0 ? 'crit' : 'default'} />
          </div>

          <div className="rbk-panel" style={{ padding: 16, marginBottom: 24 }}>
            <p className="rbk-panel-title" style={{ marginBottom: 12 }}>Radar Anomalies</p>
            {anomalies.length === 0 ? (
              <EmptyState icon={ShieldIcon} title="No anomalies detected" />
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                      <SortTh k="objectName" label="Object" ctl={anomalyCtl} />
                      <SortTh k="cluster" label="Cluster" ctl={anomalyCtl} />
                      <SortTh k="anomalyProbability" label="Probability" ctl={anomalyCtl} />
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Encryption</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Quarantined</th>
                      <SortTh k="status" label="Status" ctl={anomalyCtl} />
                      <SortTh k="detectedAt" label="Detected" ctl={anomalyCtl} />
                    </tr>
                  </thead>
                  <tbody>
                    {anomalyCtl.rows.map((a) => (
                      <tr key={a.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)', background: a.status === 'Open' ? 'rgba(248,113,113,0.08)' : 'transparent' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>
                          {a.objectName} <span style={{ color: 'var(--rbk-ink-faint)' }}>({a.objectType})</span>
                        </td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{a.cluster}</td>
                        <td style={{ padding: '8px 12px 8px 0', width: 160 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ flex: 1, height: 6, background: 'var(--rbk-surface-overlay)', borderRadius: 4, border: '1px solid var(--rbk-border)' }}>
                              <div
                                style={{
                                  height: '100%',
                                  width: `${Math.round(a.anomalyProbability * 100)}%`,
                                  background: a.anomalyProbability >= 0.7 ? 'var(--rbk-crit)' : a.anomalyProbability >= 0.4 ? 'var(--rbk-warn)' : 'var(--rbk-brand)',
                                  borderRadius: 4,
                                }}
                              />
                            </div>
                            <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-muted)' }}>{Math.round(a.anomalyProbability * 100)}%</span>
                          </div>
                        </td>
                        <td style={{ padding: '8px 12px 8px 0' }}>
                          {a.encryptionDetected ? <Badge tone="crit">Detected</Badge> : <span style={{ color: 'var(--rbk-ink-faint)' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 12px 8px 0' }}>
                          {a.snapshotQuarantined ? <Badge tone="warn">Quarantined</Badge> : <span style={{ color: 'var(--rbk-ink-faint)' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 12px 8px 0' }}><StatusBadge status={a.status} /></td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatWhen(a.detectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rbk-panel" style={{ padding: 16 }}>
            <p className="rbk-panel-title" style={{ marginBottom: 12 }}>Threat Hunts</p>
            {hunts.length === 0 ? (
              <EmptyState icon={ShieldIcon} title="No threat hunts found" />
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                      <SortTh k="name" label="Name" ctl={huntCtl} />
                      <SortTh k="iocType" label="IOC Type" ctl={huntCtl} />
                      <SortTh k="status" label="Status" ctl={huntCtl} />
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Scanned (clusters/snaps/objects)</th>
                      <SortTh k="matchesFound" label="Matches" ctl={huntCtl} />
                      <SortTh k="startedAt" label="Started" ctl={huntCtl} />
                    </tr>
                  </thead>
                  <tbody>
                    {huntCtl.rows.map((h) => (
                      <tr key={h.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)', background: h.matchesFound > 0 ? 'rgba(248,113,113,0.08)' : 'transparent' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{h.name}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{h.iocType}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}>
                          {h.status === 'Running' && <PulsingDot />}
                          <StatusBadge status={h.status} />
                        </td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>
                          {h.clustersScanned} / {h.snapshotsScanned} / {h.objectsScanned}
                        </td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: h.matchesFound > 0 ? 'var(--rbk-crit)' : 'var(--rbk-ink-muted)', fontWeight: h.matchesFound > 0 ? 700 : 400 }}>
                          {h.matchesFound}
                        </td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatWhen(h.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
