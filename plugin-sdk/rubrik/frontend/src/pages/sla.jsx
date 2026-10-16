// Rubrik v2.0.0 SLA Domains page — restyled onto the rbk- kit (./ui,
// ./charts). Same data, same fetch (/sla-domains), same columns.

import { PageHeader, SkeletonTable, EmptyState, RefreshButton, ShieldIcon } from '../ui';
import { Donut } from '../charts';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function complianceColor(pct) {
  if (pct >= 90) return '#34D399';
  if (pct >= 75) return '#FBBF24';
  return '#F87171';
}

export default function SlaDomainsPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const loadDomains = React.useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/sla-domains')
      .then((rows) => setData(rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { loadDomains(); }, [loadDomains]);

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ShieldIcon} title="SLA Domains" description="Snapshot frequency, retention, and compliance per SLA domain">
        <RefreshButton onClick={loadDomains} refreshing={loading} />
      </PageHeader>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <SkeletonTable rows={6} colWidths={['18%', '14%', '14%', '10%', '16%', '14%', '14%']} />
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <EmptyState icon={ShieldIcon} title="No SLA domains found" />
        </div>
      ) : (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Name</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Frequency</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Retention</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Objects</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Compliance</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Archival</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Replication</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{s.name}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.snapshotFrequency}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.retention}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.objectCount}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Donut pct={s.compliancePct} size={32} stroke={5} colors={{ default: complianceColor(s.compliancePct) }} centerLabel=" " />
                        <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{s.compliancePct}%</span>
                      </div>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.archivalLocation || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.replicationTarget || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
