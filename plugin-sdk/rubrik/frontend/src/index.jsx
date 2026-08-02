// Rubrik demo platform frontend module (ICC contract C9.4). Bundled as an
// IIFE with no ESM imports at runtime — React comes from `window.React`
// (injected by the build banner, see plugin-sdk/build.mjs). No Tailwind:
// the host's CSS purge only scans host source files, so plugin markup uses
// inline styles exclusively.

const ACCENT = '#00B388';
const PANEL_BG = '#232323';
const BORDER = '#333333';
const TEXT = '#E5E5E5';
const MUTED = '#9aa0a6';

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 48) return `${Math.round(diffH)}h ago`;
  return d.toLocaleString();
}

function panelStyle(extra) {
  return {
    background: PANEL_BG,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: 16,
    ...extra,
  };
}

const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 12,
  color: MUTED,
  borderBottom: `1px solid ${BORDER}`,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const tdStyle = {
  padding: '8px 10px',
  fontSize: 13,
  color: TEXT,
  borderBottom: `1px solid ${BORDER}`,
};

function UsageBar({ used, capacity }) {
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  const color = pct >= 90 ? '#DC2626' : pct >= 75 ? '#D97706' : ACCENT;
  return (
    <div>
      <div style={{ height: 6, background: '#141414', borderRadius: 4, overflow: 'hidden', border: `1px solid ${BORDER}` }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
        {formatBytes(used)} / {formatBytes(capacity)} ({pct}%)
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const isFail = status === 'Failed';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: isFail ? 'rgba(220,38,38,0.15)' : 'rgba(0,179,136,0.15)',
        color: isFail ? '#F87171' : ACCENT,
        border: `1px solid ${isFail ? '#DC2626' : ACCENT}`,
      }}
    >
      {status}
    </span>
  );
}

function useFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, error };
}

function PageShell({ title, error, children }) {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: TEXT, background: 'transparent' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16, color: TEXT }}>{title}</h1>
      {error && <p style={{ color: '#F87171' }}>{error}</p>}
      {children}
    </div>
  );
}

function OverviewPage() {
  const { data, error } = useFetch('/overview');
  const { data: jobs } = useFetch('/jobs');
  const failedJobs = (jobs || []).filter((j) => j.status === 'Failed').slice(0, 5);

  return (
    <PageShell title="Rubrik Overview" error={error}>
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Clusters</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>{data.clusters}</div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Protected Objects</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.objects}</div>
              {data.outOfCompliance > 0 && (
                <div style={{ fontSize: 12, color: '#F87171', marginTop: 4 }}>
                  {data.outOfCompliance} out of compliance
                </div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Jobs (24h)</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.jobs24h}</div>
              {data.failed24h > 0 && (
                <div style={{ fontSize: 12, color: '#F87171', marginTop: 4 }}>{data.failed24h} failed</div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Capacity Used</div>
              <UsageBar used={data.usedBytes} capacity={data.capacityBytes} />
            </div>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Recent Failed Jobs</div>
            {failedJobs.length === 0 && <div style={{ fontSize: 13, color: MUTED }}>No failed jobs in the last 24h.</div>}
            {failedJobs.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Object</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Cluster</th>
                    <th style={thStyle}>Started</th>
                    <th style={thStyle}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {failedJobs.map((j) => (
                    <tr key={j.id}>
                      <td style={tdStyle}>{j.objectName}</td>
                      <td style={tdStyle}>{j.jobType}</td>
                      <td style={tdStyle}>{j.clusterName}</td>
                      <td style={tdStyle}>{formatWhen(j.startedAt)}</td>
                      <td style={{ ...tdStyle, color: MUTED }}>{j.errorMessage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </PageShell>
  );
}

function ClustersPage() {
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
                <th style={thStyle}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td style={tdStyle}>{c.name}</td>
                  <td style={tdStyle}>{c.model}</td>
                  <td style={tdStyle}>{c.nodes}</td>
                  <td style={tdStyle}>{c.version}</td>
                  <td style={tdStyle}>
                    <StatusPill status={c.status === 'Connected' ? 'Succeeded' : c.status} />
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

const OBJECT_TYPES = ['All', 'VM', 'MSSQL DB', 'NAS Share', 'EC2 Instance'];

function ObjectsPage() {
  const { data, error } = useFetch('/objects');
  const [filter, setFilter] = React.useState('All');
  const rows = (data || []).filter((o) => filter === 'All' || o.type === filter);

  return (
    <PageShell title="Rubrik Protected Objects" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        {OBJECT_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${filter === t ? ACCENT : BORDER}`,
              background: filter === t ? 'rgba(0,179,136,0.15)' : PANEL_BG,
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
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>SLA Domain</th>
                <th style={thStyle}>Last Backup</th>
                <th style={thStyle}>Compliance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} style={{ background: o.compliant ? 'transparent' : 'rgba(220,38,38,0.08)' }}>
                  <td style={tdStyle}>{o.name}</td>
                  <td style={tdStyle}>{o.type}</td>
                  <td style={tdStyle}>{o.clusterName}</td>
                  <td style={tdStyle}>{o.slaDomain}</td>
                  <td style={tdStyle}>{formatWhen(o.lastBackupAt)}</td>
                  <td style={{ ...tdStyle, color: o.compliant ? ACCENT : '#F87171', fontWeight: 600 }}>
                    {o.compliant ? 'Compliant' : 'Out of Compliance'}
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

function JobsPage() {
  const { data, error } = useFetch('/jobs');
  return (
    <PageShell title="Rubrik Jobs" error={error}>
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
              {data.map((j) => (
                <tr key={j.id} style={{ background: j.status === 'Failed' ? 'rgba(220,38,38,0.08)' : 'transparent' }}>
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
          {data.some((j) => j.status === 'Failed') && (
            <div style={{ padding: 10, borderTop: `1px solid ${BORDER}` }}>
              {data
                .filter((j) => j.status === 'Failed')
                .map((j) => (
                  <div key={j.id} style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
                    <span style={{ color: '#F87171', fontWeight: 600 }}>{j.objectName}:</span> {j.errorMessage}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

window.__ICC_REGISTER_PLUGIN__({
  id: 'rubrik',
  label: 'Rubrik',
  color: ACCENT,
  switcherRoute: '/rubrik',
  basePath: '/rubrik',
  isActive: (p) => p.startsWith('/rubrik'),
  navGroups: [
    {
      label: 'Monitor',
      items: [{ label: 'Overview', route: '/rubrik', isActive: (p) => p === '/rubrik' }],
    },
    {
      label: 'Protection',
      items: [
        { label: 'Clusters', route: '/rubrik/clusters', isActive: (p) => p === '/rubrik/clusters' },
        { label: 'Protected Objects', route: '/rubrik/objects', isActive: (p) => p === '/rubrik/objects' },
        { label: 'Jobs', route: '/rubrik/jobs', isActive: (p) => p === '/rubrik/jobs' },
      ],
    },
  ],
  routes: [
    { path: 'rubrik', Component: OverviewPage },
    { path: 'rubrik/clusters', Component: ClustersPage },
    { path: 'rubrik/objects', Component: ObjectsPage },
    { path: 'rubrik/jobs', Component: JobsPage },
  ],
});
