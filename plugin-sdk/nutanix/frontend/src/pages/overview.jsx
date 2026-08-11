// Nutanix Overview — port of frontend/src/pages/nutanix/NxOverviewPage.jsx
// onto the nx- style kit. No react-chartjs-2 / lucide-react / react-router
// imports — React/ReactRouterDOM/Chart come from build-banner globals.
import {
  injectStyles, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated,
  GaugeIcon, ServerIcon, MonitorIcon, DbIcon, ShieldAlertIcon, ActivityIcon, CpuIcon, MemoryIcon,
  fmtNum, fmtBytes, fmtRatio, ppmPct, usageTone, severityTone, ftTone, ftLabel,
} from '../ui.jsx';
import { LineChart } from '../charts.jsx';

injectStyles();

const BRAND = '#7855FA';

function useNxFetch(path) {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch(`/api/nutanix${path}`, { credentials: 'include' })
    .then((res) => {
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      return res.json();
    })
    .then((json) => { setData(json); setLastRefreshed(new Date()); })
    .catch(() => setData((d) => d ?? {})), [path]);

  React.useEffect(() => { load(); }, [load]);

  return { data, lastRefreshed, refetch: load };
}

const utilTone = (p) => (p == null ? 'ok' : p > 90 ? 'crit' : p > 80 ? 'warn' : 'ok');

export default function OverviewPage() {
  const { data, lastRefreshed, refetch } = useNxFetch('/overview');
  const navigate = ReactRouterDOM.useNavigate();

  const totals = data?.totals || {};
  const clusters = data?.clusters || [];
  const issues = data?.issues || [];
  const trend = data?.trend || [];
  const prov = data?.provisioning || {};
  const loading = data == null;

  const storagePct = totals.storageCapacityBytes > 0 ? (totals.storageUsageBytes / totals.storageCapacityBytes) * 100 : null;
  const critCount = totals.criticalAlerts || 0;
  const warnCount = totals.warningAlerts || 0;

  const cpuPct = ppmPct(data?.utilization?.cpuPpm);
  const memPct = ppmPct(data?.utilization?.memPpm);
  const cpuRatio = prov.physicalCores > 0 ? prov.vcpus / prov.physicalCores : null;
  const memRatio = prov.physicalMemBytes > 0 ? (prov.vmemMb * 1024 * 1024) / prov.physicalMemBytes : null;

  const storageSeries = React.useMemo(() => ([
    { label: 'Capacity', color: '#8FA3B0', fill: true, points: trend.map((t, i) => ({ x: i, y: t.storage_capacity_bytes / 1e12 })) },
    { label: 'Used', color: BRAND, fill: true, points: trend.map((t, i) => ({ x: i, y: t.storage_usage_bytes / 1e12 })) },
  ]), [trend]);

  const perfSeries = React.useMemo(() => ([
    { label: 'IOPS', color: BRAND, axis: 'y', points: trend.map((t, i) => ({ x: i, y: t.controller_iops })) },
    { label: 'Latency (ms)', color: '#D4A24E', axis: 'y1', points: trend.map((t, i) => ({ x: i, y: t.controller_latency_usecs != null ? t.controller_latency_usecs / 1000 : null })) },
  ]), [trend]);

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={GaugeIcon} title="Nutanix Overview" description="Prism Central and Prism Element clusters registered across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={refetch} />
      </PageHeader>

      {data && totals.sources === 0 && (
        <div className="nx-panel" style={{ padding: 16, marginBottom: 16, border: '1px solid rgba(251,191,36,0.4)' }}>
          <p style={{ fontSize: 13, color: 'var(--nx-ink)', margin: 0 }}>
            No Nutanix sources registered yet. Add one under{' '}
            <ReactRouterDOM.Link to="/nutanix/settings" style={{ color: 'var(--nx-brand)', textDecoration: 'underline' }}>Nutanix → Settings</ReactRouterDOM.Link> to start polling.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nx-kpi-grid">
        <style>{`
          @media (min-width: 768px) { .nx-kpi-grid { grid-template-columns: repeat(3,1fr) !important; } }
          @media (min-width: 1280px) { .nx-kpi-grid { grid-template-columns: repeat(6,1fr) !important; } }
        `}</style>
        <StatCard icon={ServerIcon} label="Sources" value={fmtNum(totals.sources)} onClick={() => navigate('/nutanix/settings')} loading={loading} />
        <StatCard icon={ServerIcon} label="Clusters" value={fmtNum(totals.clusters)} onClick={() => navigate('/nutanix/clusters')} loading={loading} />
        <StatCard icon={ServerIcon} label="Hosts" value={fmtNum(totals.hosts)} onClick={() => navigate('/nutanix/hosts')} loading={loading} />
        <StatCard icon={MonitorIcon} label="VMs" value={fmtNum(totals.vms)} onClick={() => navigate('/nutanix/vms')} loading={loading} />
        <StatCard icon={DbIcon} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={totals.storageCapacityBytes ? `${fmtBytes(totals.storageUsageBytes)} of ${fmtBytes(totals.storageCapacityBytes)}` : undefined}
          tone={usageTone(storagePct)} onClick={() => navigate('/nutanix/storage')} loading={loading} />
        <StatCard icon={ShieldAlertIcon} label="Alerts" value={fmtNum(critCount + warnCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/nutanix/alerts')} loading={loading} />
      </div>

      {/* Estate utilization + provisioning band */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nx-util-grid">
        <style>{`@media (min-width: 1024px) { .nx-util-grid { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
        <StatCard icon={CpuIcon} label="CPU Utilization" tone={utilTone(cpuPct)}
          value={cpuPct != null ? `${cpuPct.toFixed(1)}%` : '—'} sub="estate weighted · 30d trend"
          spark={trend.map((t) => ppmPct(t.cpu_usage_ppm))} loading={loading} />
        <StatCard icon={MemoryIcon} label="Memory Utilization" tone={utilTone(memPct)}
          value={memPct != null ? `${memPct.toFixed(1)}%` : '—'} sub="estate weighted · 30d trend"
          spark={trend.map((t) => ppmPct(t.memory_usage_ppm))} loading={loading} />
        <StatCard icon={CpuIcon} label="vCPU : Core" tone={cpuRatio > 4 ? 'warn' : 'ok'}
          value={cpuRatio != null ? `${cpuRatio.toFixed(2)}:1` : '—'}
          sub={prov.physicalCores ? `${fmtNum(prov.vcpus)} vCPU on ${fmtNum(prov.physicalCores)} cores` : undefined} loading={loading} />
        <StatCard icon={MemoryIcon} label="vMem : Physical" tone={memRatio > 1 ? 'warn' : 'ok'}
          value={memRatio != null ? `${memRatio.toFixed(2)}:1` : '—'}
          sub={prov.physicalMemBytes ? `${fmtBytes(prov.vmemMb * 1024 * 1024)} of ${fmtBytes(prov.physicalMemBytes)}` : undefined} loading={loading} />
      </div>

      {/* Trend charts */}
      {trend.length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nx-trend-grid">
          <style>{`@media (min-width: 1024px) { .nx-trend-grid { grid-template-columns: 2fr 1fr !important; } }`}</style>
          <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <DbIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Storage — 30 Days (TB)
              </p>
              {data?.worstRunway && (
                <Badge tone={data.worstRunway.runway_days < 90 ? 'warn' : 'neutral'}>
                  shortest runway: {data.worstRunway.name} · {data.worstRunway.runway_days}d
                </Badge>
              )}
            </div>
            <LineChart series={storageSeries} height={192} yUnit={(v) => `${v.toFixed(1)} TB`} />
          </div>
          <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ActivityIcon size={15} style={{ color: 'var(--nx-brand)' }} /> IOPS / Latency — 30 Days
            </p>
            <LineChart series={perfSeries} height={192} dualAxis yUnit={(v) => `${Math.round(v)}`} y1Unit={(v) => `${v.toFixed(0)}ms`} />
          </div>
        </div>
      )}

      {totals.unprotectedVms > 0 && (
        <div className="nx-panel" style={{ padding: 12, marginBottom: 16, border: '1px solid rgba(251,191,36,0.4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlertIcon size={14} style={{ color: 'var(--nx-warn)', flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--nx-ink)' }}>{fmtNum(totals.unprotectedVms)} VM(s) have no protection domain.</p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="nx-bottom-grid">
        <style>{`@media (min-width: 1024px) { .nx-bottom-grid { grid-template-columns: 2fr 1fr !important; } }`}</style>
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ServerIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Clusters
          </p>
          {loading ? (
            <LoadingPanel label="Loading clusters…" height={160} />
          ) : clusters.length === 0 ? (
            <div className="nx-panel" style={{ padding: 24, fontSize: 13, color: 'var(--nx-ink-muted)', textAlign: 'center' }}>No clusters found.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="nx-cluster-grid">
              <style>{`@media (max-width: 640px) { .nx-cluster-grid { grid-template-columns: 1fr !important; } }`}</style>
              {clusters.map((c) => {
                const usedPct = c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null;
                const barColor = usedPct > 90 ? 'var(--nx-crit)' : usedPct > 80 ? 'var(--nx-warn)' : BRAND;
                return (
                  <div key={c.id} className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name || c.uuid}</p>
                        <p style={{ margin: 0, fontSize: 11, color: 'var(--nx-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.source_name}{c.aos_version ? ` · AOS ${c.aos_version}` : ''}</p>
                      </div>
                      <Badge tone={ftTone(c)}>{ftLabel(c)}</Badge>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <div style={{ width: '100%', height: 6, borderRadius: 999, background: 'var(--nx-surface-overlay)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 999, width: `${Math.min(100, usedPct || 0)}%`, background: barColor }} />
                      </div>
                      <span className="nx-tnum" style={{ fontSize: 11, color: 'var(--nx-ink-muted)', whiteSpace: 'nowrap' }}>{usedPct != null ? `${usedPct.toFixed(0)}%` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--nx-ink-faint)', marginTop: 8 }}>
                      <span>{fmtNum(c.num_nodes)} node{c.num_nodes === 1 ? '' : 's'}</span>
                      <span>Reduction {fmtRatio(c.overall_reduction_ratio_ppm ?? c.reduction_ratio_ppm)}</span>
                      {c.runway_days != null && (
                        <Badge tone={c.runway_days < 90 ? 'warn' : 'neutral'}>{c.runway_days}d runway</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ActivityIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Top Issues
          </p>
          {loading ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nx-ok)', padding: '24px 0', textAlign: 'center' }}>No issues detected.</div>
          ) : (
            <div className="nx-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflowY: 'auto', paddingRight: 4 }}>
              {issues.map((i, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--nx-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--nx-ink)', lineHeight: 1.5 }}>{i.message}</p>
                    <p style={{ margin: 0, fontSize: 10, color: 'var(--nx-ink-faint)' }}>{i.source}{i.target ? ` · ${i.target}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
