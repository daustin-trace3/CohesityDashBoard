// Rubrik v2.0.0 — Licensing page. Mirrors the host LicensingPage.jsx core
// experience (license meter cards + consumption-by-cluster table) using the
// rbk- kit exclusively. The host's "Explorer" what-if simulation mode is
// intentionally NOT mirrored per the WP brief.

import {
  injectStyles, PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  ClipboardIcon, DownloadIcon,
} from '../ui';
import { Donut } from '../charts';

injectStyles();

const TB = 1e12;
const toTb = (b) => (b || 0) / TB;
function fmtTb(b) {
  const t = toTb(b);
  if (t >= 100) return t.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' TB';
  return t.toFixed(1) + ' TB';
}

function useRbkFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [path, nonce]);

  return { data, error, reload };
}

const METER_ICON = () => <ClipboardIcon size={18} />;

function MeterGauge({ pct, entitled }) {
  if (entitled == null || entitled <= 0) {
    return <Donut notSet size={112} stroke={11} centerLabel="Set entitlement" />;
  }
  const over = pct > 100;
  return (
    <Donut
      pct={pct}
      size={112}
      stroke={11}
      thresholds={{ crit: 90, warn: 75 }}
      centerLabel={over ? 'Over' : `${Math.round(pct)}%`}
      centerSub={over ? '' : 'Used'}
    />
  );
}

function MeterCard({ meter }) {
  const consumedTb = toTb(meter.consumedBytes);
  const entitled = meter.entitledTb || 0;
  const pct = entitled > 0 ? (consumedTb / entitled) * 100 : null;
  const headroom = entitled > 0 ? entitled - consumedTb : null;

  return (
    <div className="rbk-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,179,136,0.1)', border: '1px solid rgba(0,179,136,0.2)', flexShrink: 0 }}>
          <ClipboardIcon size={18} style={{ color: 'var(--rbk-brand)' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--rbk-ink)', margin: 0 }}>{meter.label}</p>
          <p style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: '2px 0 0', lineHeight: 1.4 }}>
            {meter.basis === 'cloud' ? 'Data archived to cloud tiers.' : meter.basis === 'security' ? 'Objects covered by ransomware/anomaly detection.' : 'Front-end capacity of protected workloads.'}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <MeterGauge pct={pct} entitled={entitled} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--rbk-ink-muted)', fontSize: 12 }}>Consumed</span>
            <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)', fontWeight: 600 }}>{fmtTb(meter.consumedBytes)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--rbk-ink-muted)', fontSize: 12 }}>Entitled</span>
            <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)', fontWeight: 600 }}>{entitled > 0 ? fmtTb(entitled * TB) : '— not set'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--rbk-ink-muted)', fontSize: 12 }}>Headroom</span>
            <span className="rbk-tnum" style={{ fontWeight: 600, color: headroom == null ? 'var(--rbk-ink-faint)' : headroom < 0 ? 'var(--rbk-crit)' : 'var(--rbk-ink)' }}>
              {headroom == null ? '—' : (headroom < 0 ? '-' : '') + fmtTb(Math.abs(headroom) * TB)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const CLUSTER_SORT = {
  cluster: (r) => r.cluster || '',
  frontEndBytes: (r) => r.frontEndBytes || 0,
  physicalBytes: (r) => r.physicalBytes || 0,
  capacityBytes: (r) => r.capacityBytes || 0,
  usagePercent: (r) => r.usagePercent ?? -1,
  dataReduction: (r) => r.dataReduction ?? -1,
};

export default function LicensingPage() {
  const { data, error, reload } = useRbkFetch('/licensing');
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = () => {
    setRefreshing(true);
    reload();
    setTimeout(() => setRefreshing(false), 500);
  };

  const byCluster = data?.byCluster || [];
  const ctl = useTableControls(byCluster, {
    searchKeys: ['cluster'],
    defaultSortKey: 'frontEndBytes',
    defaultSortDir: 'desc',
    sortValues: CLUSTER_SORT,
  });

  const meters = data?.meters || [];
  const loading = !data && !error;

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader
        icon={METER_ICON}
        title="Licensing"
        description={data?.capturedAt ? `Capacity consumption by license meter · updated ${new Date(data.capturedAt.replace(' ', 'T') + 'Z').toLocaleString()}` : 'Capacity consumption by license meter'}
      >
        <Badge tone="brand">Enterprise</Badge>
        <RefreshButton onClick={refresh} refreshing={refreshing} />
        <CsvExportButton
          filename="rubrik-licensing"
          rows={byCluster}
          columns={[
            { label: 'Cluster', get: 'cluster' },
            { label: 'Front-End TB', get: (r) => (toTb(r.frontEndBytes)).toFixed(2) },
            { label: 'Physical TB', get: (r) => (toTb(r.physicalBytes)).toFixed(2) },
            { label: 'Raw Capacity TB', get: (r) => (toTb(r.capacityBytes)).toFixed(2) },
            { label: 'Used %', get: (r) => r.usagePercent != null ? r.usagePercent.toFixed(1) : '' },
            { label: 'Data Reduction', get: (r) => r.dataReduction != null ? r.dataReduction.toFixed(2) : '' },
          ]}
        />
        <button onClick={() => window.print()} className="rbk-btn-accent">Print / PDF</button>
      </PageHeader>

      {loading ? (
        <div className="rbk-panel"><LoadingPanel label="Loading licensing data…" height={280} /></div>
      ) : error ? (
        <div className="rbk-panel" style={{ padding: 24, textAlign: 'center', color: 'var(--rbk-ink-muted)', fontSize: 13 }}>
          Could not load licensing data. <button onClick={reload} className="rbk-btn-ghost" style={{ display: 'inline-flex', marginLeft: 6 }}>Retry</button>
        </div>
      ) : (
        <>
          <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {meters.map((m, i) => (
              <div key={m.key} style={{ '--rbk-i': i }}>
                <MeterCard meter={m} />
              </div>
            ))}
            {meters.length === 0 && (
              <div className="rbk-panel" style={{ padding: 32, textAlign: 'center', gridColumn: '1 / -1' }}>
                <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', margin: 0 }}>No license meters collected yet.</p>
              </div>
            )}
          </div>

          <div style={{ height: 16 }} />

          <Panel
            title="Consumption by Cluster"
            actions={<span style={{ fontSize: 11, color: 'var(--rbk-ink-faint)' }}>{byCluster.length} clusters</span>}
          >
            <TableControls ctl={ctl} rows={byCluster} searchPlaceholder="Filter by cluster…" />
            {byCluster.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--rbk-ink-faint)', textAlign: 'center', padding: '24px 0' }}>No per-cluster capacity data yet.</p>
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <SortTh k="cluster" label="Cluster" ctl={ctl} align="left" />
                      <SortTh k="frontEndBytes" label="Front-End (FETB)" ctl={ctl} />
                      <SortTh k="physicalBytes" label="Physical" ctl={ctl} />
                      <SortTh k="capacityBytes" label="Raw Capacity" ctl={ctl} />
                      <SortTh k="usagePercent" label="% Used" ctl={ctl} />
                      <SortTh k="dataReduction" label="Data Reduction" ctl={ctl} />
                    </tr>
                  </thead>
                  <tbody>
                    {ctl.pageRows.map((r, i) => {
                      const pct = r.usagePercent;
                      const tone = pct == null ? 'neutral' : pct >= 86 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
                      return (
                        <tr key={r.cluster || i} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                          <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', fontWeight: 500 }}>{r.cluster || '—'}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(r.frontEndBytes)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(r.physicalBytes)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(r.capacityBytes)}</td>
                          <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>
                            <Badge tone={tone}>{pct != null ? pct.toFixed(1) + '%' : '—'}</Badge>
                          </td>
                          <td className="rbk-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{r.dataReduction != null ? r.dataReduction.toFixed(2) + 'x' : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </Panel>
        </>
      )}
    </div>
  );
}
