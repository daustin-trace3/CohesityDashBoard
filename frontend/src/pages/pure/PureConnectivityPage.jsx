import { useEffect, useState, useMemo, useCallback } from 'react';
import { Network, RefreshCw, Cable, Link2 } from 'lucide-react';
import client from '../../api/client';
import useDnsResolve from '../../api/useDnsResolve';
import IpWithHost from '../../components/IpWithHost';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtNum } from './helpers';

const gbps = (bps) => (bps ? `${(bps / 1e9).toFixed(0)} Gb/s` : '—');

export default function PureConnectivityPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [net, setNet] = useState(null);
  const [conns, setConns] = useState(null);

  const loadArrays = useCallback(() => client.get('/pure/arrays')
    .then(({ data }) => { setArrays(data); setSelectedId((cur) => (cur && data.some((x) => x.id === cur) ? cur : data[0]?.id ?? null)); })
    .catch(() => { setArrays([]); toast({ type: 'error', title: 'Failed to load arrays' }); }), [toast]);

  useEffect(() => { loadArrays(); }, [loadArrays]);

  useEffect(() => {
    if (!selectedId) { setNet(null); setConns(null); return; }
    let cancelled = false;
    setNet(null); setConns(null);
    client.get(`/pure/arrays/${selectedId}/network`).then(({ data }) => { if (!cancelled) setNet(data); }).catch(() => { if (!cancelled) setNet({ interfaces: [], ports: [] }); });
    client.get(`/pure/arrays/${selectedId}/connections`).then(({ data }) => { if (!cancelled) setConns(data); }).catch(() => { if (!cancelled) setConns([]); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const interfaces = net?.interfaces || [];
  const ports = net?.ports || [];
  const fc = ports.filter((p) => p.wwn).length;
  const iscsi = ports.filter((p) => p.iqn).length;
  const nvme = ports.filter((p) => p.nqn).length;

  const dns = useDnsResolve(useMemo(() => [
    ...interfaces.map((n) => n.address),
    ...interfaces.map((n) => n.gateway),
  ].filter(Boolean), [interfaces]));

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Pure Connectivity" description="Network interfaces, SAN ports and volume-to-host LUN mappings">
        <button onClick={loadArrays} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading arrays…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>No Pure arrays registered yet.</div>
      ) : (
        <>
          <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 mb-4 self-start overflow-x-auto">
            {arrays.map((a) => {
              const active = a.id === selectedId;
              return (
                <button key={a.id} onClick={() => setSelectedId(a.id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'}`}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: BRAND }} />{a.name}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={Network} label="Interfaces" value={fmtNum(interfaces.length)} tone="brand" />
            <StatCard icon={Cable} label="FC Ports" value={fc} />
            <StatCard icon={Cable} label="iSCSI/NVMe" value={iscsi + nvme} />
            <StatCard icon={Link2} label="LUN Mappings" value={fmtNum((conns || []).length)} />
          </div>

          {net == null ? (
            <LoadingPanel label="Loading connectivity…" />
          ) : (
            <>
              <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Network Interfaces</p>
                <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Services</th><th className="py-2 pr-3">IP Address</th><th className="py-2 pr-3">Gateway</th><th className="py-2 pr-3">Identifier</th><th className="py-2 pr-3 text-right">Speed</th><th className="py-2 pr-3">Enabled</th>
                    </tr></thead>
                    <tbody>
                      {interfaces.map((n) => (
                        <tr key={n.id} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink">{n.name}</td>
                          <td className="py-2 pr-3 text-ink-muted uppercase text-[11px]">{n.interface_type || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px]">{n.services || '—'}</td>
                          <td className="py-2 pr-3 tnum">
                            {n.address
                              ? (
                                <span>
                                  <IpWithHost ip={n.address} dns={dns} />
                                  {n.netmask ? <span className="text-ink-faint text-[10px] block">mask {n.netmask}</span> : null}
                                </span>
                              )
                              : <span className="text-ink-faint">—</span>}
                          </td>
                          <td className="py-2 pr-3">{n.gateway ? <IpWithHost ip={n.gateway} dns={dns} muted /> : <span className="text-ink-faint">—</span>}</td>
                          <td className="py-2 pr-3 tnum text-ink-faint text-[11px] truncate max-w-[190px]">{n.wwn || n.mac_address || '—'}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{gbps(n.speed_bps)}</td>
                          <td className="py-2 pr-3"><Badge tone={n.enabled ? 'ok' : 'neutral'}>{n.enabled ? 'yes' : 'no'}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">SAN Ports ({ports.length})</p>
                  <div className="overflow-x-auto max-h-[46vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Port</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3">Identifier</th>
                      </tr></thead>
                      <tbody>
                        {ports.map((p) => {
                          const proto = p.wwn ? 'FC' : p.iqn ? 'iSCSI' : p.nqn ? 'NVMe' : '—';
                          return (
                            <tr key={p.id} className="border-b border-cohesity-border/50">
                              <td className="py-2 pr-3 text-ink">{p.name}</td>
                              <td className="py-2 pr-3 text-ink-muted">{proto}</td>
                              <td className="py-2 pr-3 text-ink-muted tnum text-[11px] truncate max-w-[240px]">{p.wwn || p.iqn || p.nqn || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">Host LUN Mappings ({(conns || []).length})</p>
                  <div className="overflow-x-auto max-h-[46vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Host</th><th className="py-2 pr-3">Group</th><th className="py-2 pr-3">Volume</th><th className="py-2 pr-3 text-right">LUN</th>
                      </tr></thead>
                      <tbody>
                        {(conns || []).map((c) => (
                          <tr key={c.id} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{c.host_name || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{c.host_group_name || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted truncate max-w-[200px]">{c.volume_name}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.lun}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
