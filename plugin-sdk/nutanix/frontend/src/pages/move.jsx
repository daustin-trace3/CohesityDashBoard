// Nutanix Move — port of NxMovePage.jsx onto the nx- style kit. Shows a
// not-configured panel when overview.moveConfigured is false (per contract
// decision 5 — this page also independently checks /move/summary.configured
// so a direct nav to /nutanix/move still degrades gracefully).
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, ProgressBar,
  ArrowRightLeftIcon, AlertOctagonIcon, fmtNum, fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };
const th = { textAlign: 'left', padding: '8px 12px 8px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--nx-ink-faint)', borderBottom: '1px solid var(--nx-border)' };

const planStateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('fail') || v.includes('error')) return 'crit';
  if (v.includes('complet') || v.includes('done') || v.includes('cutover')) return 'ok';
  return 'info';
};

export default function MovePage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/move/summary', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setData(json); setLastRefreshed(new Date()); })
    .catch(() => setData({ configured: false, plans: [], workloads: [], events: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  if (data && data.configured === false) {
    return (
      <div className="nx-root nx-fade-in">
        <PageHeader icon={ArrowRightLeftIcon} title="Move" description="VM migration plans via Nutanix Move appliances">
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="nx-panel" style={{ padding: 24, textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: 'var(--nx-ink-muted)', margin: 0 }}>
            Move is not configured — add a Move appliance under{' '}
            <ReactRouterDOM.Link to="/nutanix/settings" style={{ color: 'var(--nx-brand)', textDecoration: 'underline' }}>Settings</ReactRouterDOM.Link>.
          </p>
        </div>
      </div>
    );
  }

  const plans = data?.plans || [];
  const workloads = data?.workloads || [];
  const events = data?.events || [];
  const failedEvents = events.filter((e) => e.failure_notes);

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={ArrowRightLeftIcon} title="Move" description="VM migration plans via Nutanix Move appliances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)' }}>Migration Plans</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : plans.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ok)', padding: '24px 0', textAlign: 'center' }}>No migration plans — healthy.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Plan</th><th style={th}>State</th><th style={th}>Progress</th>
                <th style={th}>Source → Target</th><th style={{ ...th, textAlign: 'right' }}>VMs</th>
              </tr></thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} className="nx-row">
                    <td style={td}>{p.name || '—'}</td>
                    <td style={td}><Badge tone={planStateTone(p.migration_status || p.state)}>{p.migration_status || p.state || '—'}</Badge></td>
                    <td style={td}><ProgressBar pct={p.progress} /></td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{p.source_provider || '—'} → {p.target_provider || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(p.vm_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)' }}>VM Workloads</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : workloads.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No VM workloads found.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>VM</th><th style={th}>Plan</th><th style={th}>State</th><th style={th}>Progress</th>
              </tr></thead>
              <tbody>
                {workloads.map((w) => (
                  <tr key={w.id} className="nx-row">
                    <td style={td}>{w.vm_name || '—'}</td>
                    <td style={tdMuted}>{w.plan_name || '—'}</td>
                    <td style={td}><Badge tone={String(w.state_label || '').toLowerCase().includes('cutover') ? 'ok' : 'info'}>{w.state_label || `State ${w.state_code}`}</Badge></td>
                    <td style={td}><ProgressBar pct={w.progress} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertOctagonIcon size={15} style={{ color: failedEvents.length ? 'var(--nx-crit)' : 'var(--nx-brand)' }} /> Failure Events
        </p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : failedEvents.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ok)', padding: '24px 0', textAlign: 'center' }}>No failures reported.</div>
        ) : (
          <div className="nx-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '40vh', overflowY: 'auto', paddingRight: 4 }}>
            {failedEvents.map((e) => (
              <div key={e.id} style={{ background: 'var(--nx-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--nx-ink)' }}>{e.event_name || '—'} · {e.vm_name || '—'} · {e.plan_name || '—'}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--nx-crit)' }}>{e.failure_notes}</p>
                <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--nx-ink-faint)' }}>{fmtWhen(e.created_at)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
