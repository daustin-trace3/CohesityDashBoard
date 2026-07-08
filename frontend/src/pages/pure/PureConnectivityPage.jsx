import { useEffect, useState, useCallback, useMemo } from 'react';
import { Network, RefreshCw, Cable, Radio } from 'lucide-react';
import client from '../../api/client';
import useDnsResolve from '../../api/useDnsResolve';
import IpWithHost from '../../components/IpWithHost';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtNum } from './helpers';
import { usePure1Arrays, ArraySelect } from './usePure1Arrays';

function fmtSpeed(bps) {
  if (!bps) return '—';
  const gb = bps / 1e9;
  if (gb >= 1) return `${gb % 1 === 0 ? gb : gb.toFixed(1)} Gb/s`;
  return `${Math.round(bps / 1e6)} Mb/s`;
}

export default function PureConnectivityPage() {
  const { toast } = useToast();
  const { arrays, arrayId, setArrayId } = usePure1Arrays();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!arrayId) return undefined;
    setLoading(true);
    return client.get(`/pure1/connectivity?arrayId=${arrayId}`)
      .then(({ data }) => setData(data))
      .catch(() => { setData({ interfaces: [], ports: [] }); toast({ type: 'error', title: 'Failed to load connectivity' }); })
      .finally(() => setLoading(false));
  }, [arrayId, toast]);

  useEffect(() => { load(); }, [load]);

  const interfaces = data?.interfaces || [];
  const ports = data?.ports || [];
  const ipList = useMemo(() => interfaces.map((i) => i.address).filter(Boolean), [interfaces]);
  const dns = useDnsResolve(ipList);
  const withIp = useMemo(() => interfaces.filter((i) => i.address).length, [interfaces]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Pure Connectivity" description="Network interfaces and ports from Pure Storage">
        <div className="flex items-center gap-2">
          <ArraySelect arrays={arrays} value={arrayId} onChange={setArrayId} />
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard icon={Cable} label="Network Interfaces" value={fmtNum(interfaces.length)} tone="brand" />
        <StatCard icon={Network} label="With IP Address" value={fmtNum(withIp)} />
        <StatCard icon={Radio} label="Ports" value={fmtNum(ports.length)} />
      </div>

      {/* Interfaces */}
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
                    <td className="py-2 pr-3">{i.address ? <IpWithHost ip={i.address} dns={dns} /> : <span className="text-ink-faint">—</span>}</td>
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

      {/* Ports */}
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
