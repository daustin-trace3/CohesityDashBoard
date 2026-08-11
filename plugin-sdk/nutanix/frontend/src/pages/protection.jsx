// Nutanix Protection & Replication — port of NxProtectionPage.jsx onto the
// nx- style kit.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, ProgressBar,
  ShieldIcon, ArrowRightLeftIcon, GlobeIcon, ClipboardListIcon, AlertTriangleIcon,
  fmtNum, fmtBytes, fmtWhen, secsToHuman,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };
const th = { textAlign: 'left', padding: '8px 12px 8px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--nx-ink-faint)', borderBottom: '1px solid var(--nx-border)' };

export default function ProtectionPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/protection', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setData(json); setLastRefreshed(new Date()); })
    .catch(() => setData({ pds: [], replications: [], remoteSites: [], policies: [], rpoCompliance: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  const pds = data?.pds || [];
  const replications = data?.replications || [];
  const remoteSites = data?.remoteSites || [];
  const policies = data?.policies || [];
  const rpoCompliance = data?.rpoCompliance || [];
  const nonCompliant = rpoCompliance.filter((r) => !r.compliant).length;

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={ShieldIcon} title="Protection & Replication" description="Protection domains, in-flight replications, remote sites and policies">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)' }}>Protection Domains</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : pds.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No protection domains found.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Name</th><th style={th}>Active</th><th style={{ ...th, textAlign: 'right' }}>VMs</th>
                <th style={th}>Next Snapshot</th><th style={{ ...th, textAlign: 'right' }}>Pending</th><th style={{ ...th, textAlign: 'right' }}>Ongoing</th>
              </tr></thead>
              <tbody>
                {pds.map((p) => (
                  <tr key={p.id} className="nx-row">
                    <td style={td}>{p.name || '—'}</td>
                    <td style={td}><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(p.vm_count)}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{p.next_snapshot_usecs ? new Date(Number(p.next_snapshot_usecs) / 1000).toLocaleString() : '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(p.pending_replications)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(p.ongoing_replications)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArrowRightLeftIcon size={15} style={{ color: 'var(--nx-brand)' }} /> In-flight Replications
        </p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : replications.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No replications in progress.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Protection Domain</th><th style={th}>Remote Site</th><th style={th}>Progress</th>
                <th style={{ ...th, textAlign: 'right' }}>Transferred</th><th style={{ ...th, textAlign: 'right' }}>ETA</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {replications.map((r) => (
                  <tr key={r.id} className="nx-row">
                    <td style={td}>{r.pd_name || '—'}</td>
                    <td style={tdMuted}>{r.remote_site || '—'}</td>
                    <td style={td}><ProgressBar pct={r.completed_percentage} tone={r.paused ? 'warn' : 'brand'} /></td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtBytes(r.completed_bytes)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{secsToHuman(r.eta_secs)}</td>
                    <td style={td}>
                      {r.paused ? <Badge tone="warn">Paused</Badge> : r.eta_secs > 86400 ? <Badge tone="warn">Slow</Badge> : <Badge tone="ok">Running</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nx-remote-grid">
        <style>{`@media (min-width: 1024px) { .nx-remote-grid { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
        <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <GlobeIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Remote Sites
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : remoteSites.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No remote sites configured.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {remoteSites.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--nx-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--nx-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</p>
                    <p style={{ margin: 0, fontSize: 11, color: 'var(--nx-ink-faint)' }}>{s.latency_usecs != null ? `${(s.latency_usecs / 1000).toFixed(1)} ms latency` : 'latency unknown'}</p>
                  </div>
                  <Badge tone={/^(kUseSSHTunnel|connected|Complete|kEnabled)$/i.test(s.status || '') ? 'ok' : 'warn'}>{s.status || 'unknown'}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClipboardListIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Policies
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : policies.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No protection policies found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {policies.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--nx-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--nx-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                  <span className="nx-tnum" style={{ fontSize: 11, color: 'var(--nx-ink-faint)' }}>RPO {secsToHuman(p.rpo_secs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangleIcon size={15} style={{ color: nonCompliant ? 'var(--nx-warn)' : 'var(--nx-brand)' }} /> RPO Compliance
        </p>
        <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--nx-ink-faint)' }}>VMs whose latest recovery point is older than their policy's RPO (with grace factor) are flagged non-compliant.</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : rpoCompliance.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No RPO-policy-bound VMs found.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>VM</th><th style={th}>Policy</th><th style={{ ...th, textAlign: 'right' }}>RPO</th>
                <th style={th}>Latest Recovery Point</th><th style={{ ...th, textAlign: 'right' }}>Age</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {rpoCompliance.map((r, i) => (
                  <tr key={i} className="nx-row" style={!r.compliant ? { background: 'rgba(251,191,36,0.05)' } : undefined}>
                    <td style={td}>{r.vmName || '—'}</td>
                    <td style={tdMuted}>{r.policyName || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{secsToHuman(r.rpoSecs)}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{fmtWhen(r.latestRecoveryPoint)}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{secsToHuman(r.ageSecs)}</td>
                    <td style={td}><Badge tone={r.compliant ? 'ok' : 'crit'}>{r.compliant ? 'Compliant' : 'Violation'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
