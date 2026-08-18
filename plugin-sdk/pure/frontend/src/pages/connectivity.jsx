// Ported from frontend/src/pages/pure/PureConnectivityPage.jsx. The built-in
// page resolves interface IPs to hostnames via the host-only useDnsResolve
// hook + IpWithHost component (api/useDnsResolve.js, components/IpWithHost)
// — neither is importable in the plugin sandbox, so the IP address renders
// as plain text here (gap, noted in the conversion report).
import { Network, Cable, Radio } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtNum } from '../ui.jsx';
import { usePure1Arrays, ArraySelect } from './usePure1Arrays.jsx';

function fmtSpeed(bps) {
  if (!bps) return '—';
  const gb = bps / 1e9;
  if (gb >= 1) return `${gb % 1 === 0 ? gb : gb.toFixed(1)} Gb/s`;
  return `${Math.round(bps / 1e6)} Mb/s`;
}

export default function PureConnectivityPage() {
  const { arrays, arrayId, setArrayId } = usePure1Arrays();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => {
    if (!arrayId) return undefined;
    setLoading(true);
    return apiFetch(`/pure/pure1/connectivity?arrayId=${arrayId}`)
      .then((data) => { setData(data); setLastRefreshed(new Date()); })
      .catch(() => setData({ interfaces: [], ports: [] }))
      .finally(() => setLoading(false));
  }, [arrayId]);

  React.useEffect(() => { load(); }, [load]);

  const interfaces = data?.interfaces || [];
  const ports = data?.ports || [];
  const withIp = React.useMemo(() => interfaces.filter((i) => i.address).length, [interfaces]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Pure Connectivity" description="Network interfaces and ports from Pure Storage">
        <div className="flex items-center gap-2">
          <ArraySelect arrays={arrays} value={arrayId} onChange={setArrayId} />
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} refreshing={loading} />
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard icon={Cable} label="Network Interfaces" value={fmtNum(interfaces.length)} tone="brand" />
        <StatCard icon={Network} label="With IP Address" value={fmtNum(withIp)} />
        <StatCard icon={Radio} label="Ports" value={fmtNum(ports.length)} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Network Interfaces</p>
        {data == null ? <LoadingPanel label="Loading…" height={140} /> : interfaces.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No interfaces.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">IP Address</th><th className="py-2 pr-3">Netmask</th><th className="py-2 pr-3">Gateway</th><th className="py-2 pr-3">Services</th><th className="py-2 pr-3">Speed</th><th className="py-2 pr-3">MTU</th><th className="py-2 pr-3">Enabled</th>
              </tr></thead>
              <tbody>
                {interfaces.map((i) => (
                  <tr key={i.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{i.name}</td>
                    <td className="py-2 pr-3 tnum text-ink-muted">{i.address || <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[12px]">{i.netmask || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[12px]">{i.gateway || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{i.services || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{fmtSpeed(i.speed)}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{i.mtu || '—'}</td>
                    <td className="py-2 pr-3">{i.enabled ? <Badge tone="ok">yes</Badge> : <Badge tone="neutral">no</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Ports ({ports.length})</p>
        {data == null ? <LoadingPanel label="Loading…" height={120} /> : ports.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ports.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Port</th><th className="py-2 pr-3">Identifier</th><th className="py-2 pr-3">Portal</th><th className="py-2 pr-3">Failover</th>
              </tr></thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{p.name}</td>
                    <td className="py-2 pr-3 text-ink-muted font-mono text-[11px]">{p.wwn || p.iqn || p.nqn || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{p.portal || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{p.failover || '—'}</td>
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
