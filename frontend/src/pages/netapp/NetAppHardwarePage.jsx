import { useEffect, useState, useCallback } from 'react';
import { HardDrive, Cpu, CircuitBoard, Server } from 'lucide-react';
import client from '../../api/client';
import useDnsResolve from '../../api/useDnsResolve';
import IpWithHost from '../../components/IpWithHost';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtNum, statusTone } from './helpers';

export default function NetAppHardwarePage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [hw, setHw] = useState(null);
  const [lifs, setLifs] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const loadArrays = useCallback(() => client.get('/netapp/arrays')
    .then(({ data }) => { setArrays(data); setSelectedId((cur) => (cur && data.some((x) => x.id === cur) ? cur : data[0]?.id ?? null)); setLastRefreshed(new Date()); })
    .catch(() => { setArrays([]); toast({ type: 'error', title: 'Failed to load clusters' }); }), [toast]);

  useEffect(() => { loadArrays(); }, [loadArrays]);

  useEffect(() => {
    if (!selectedId) { setHw(null); setLifs(null); return; }
    let cancelled = false;
    setHw(null); setLifs(null);
    client.get(`/netapp/arrays/${selectedId}/hardware`)
      .then(({ data }) => { if (!cancelled) setHw(data); })
      .catch(() => { if (!cancelled) setHw({ nodes: [], disks: [], svms: [] }); });
    client.get(`/netapp/arrays/${selectedId}/network`)
      .then(({ data }) => { if (!cancelled) setLifs(data); })
      .catch(() => { if (!cancelled) setLifs([]); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const nodes = hw?.nodes || [];
  const disks = hw?.disks || [];
  const svms = hw?.svms || [];
  const diskCapacity = disks.reduce((s, d) => s + (d.size_bytes || 0), 0);
  const lifDns = useDnsResolve((lifs || []).map((l) => l.address).filter(Boolean));

  const diskCtl = useTableControls(disks, { searchKeys: ['name', 'type', 'model'], defaultSortKey: 'name' });
  const lifCtl = useTableControls(lifs, { searchKeys: ['name', 'svm_name', 'address', 'node_name', 'port_name'], defaultSortKey: 'name' });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="NetApp Hardware" description="Nodes, disks and storage VMs">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={loadArrays} />
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading clusters…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>No NetApp clusters registered yet.</div>
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
            <StatCard icon={Cpu} label="Nodes" value={fmtNum(nodes.length)} tone="brand" />
            <StatCard icon={CircuitBoard} label="Disks" value={fmtNum(disks.length)} sub={fmtBytes(diskCapacity)} />
            <StatCard icon={Server} label="Storage VMs" value={fmtNum(svms.length)} />
            <StatCard icon={HardDrive} label="Raw Capacity" value={fmtBytes(diskCapacity)} />
          </div>

          {hw == null ? (
            <LoadingPanel label="Loading hardware…" />
          ) : (
            <>
              <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Nodes</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Model</th><th className="py-2 pr-3">Serial</th><th className="py-2 pr-3">ONTAP</th><th className="py-2 pr-3">State</th>
                    </tr></thead>
                    <tbody>
                      {nodes.map((n) => (
                        <tr key={n.id} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink">{n.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{n.model || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted tnum">{n.serial_number || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px]">{(n.version || '').replace('NetApp Release ', '') || '—'}</td>
                          <td className="py-2 pr-3"><Badge tone={statusTone(n.state)}>{n.state || 'unknown'}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">Disks ({disks.length})</p>
                  <TableControls ctl={diskCtl} rows={disks} searchPlaceholder="Filter by name, type or model…"
                    filters={[{ k: 'type', label: 'Types' }, { k: 'state', label: 'States' }]} />
                  <div className="overflow-x-auto max-h-[48vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <SortTh k="name" label="Name" ctl={diskCtl} />
                        <SortTh k="type" label="Type" ctl={diskCtl} />
                        <SortTh k="model" label="Model" ctl={diskCtl} />
                        <SortTh k="size_bytes" label="Size" ctl={diskCtl} align="right" />
                        <SortTh k="state" label="State" ctl={diskCtl} />
                      </tr></thead>
                      <tbody>
                        {diskCtl.rows.map((d) => (
                          <tr key={d.id} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{d.name}</td>
                            <td className="py-2 pr-3 text-ink-muted">{d.type || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{d.model || '—'}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.size_bytes)}</td>
                            <td className="py-2 pr-3"><Badge tone={statusTone(d.state)}>{d.state || 'unknown'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">Storage VMs ({svms.length})</p>
                  <div className="overflow-x-auto max-h-[48vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">State</th>
                      </tr></thead>
                      <tbody>
                        {svms.map((s) => (
                          <tr key={s.id} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{s.name}</td>
                            <td className="py-2 pr-3"><Badge tone={statusTone(s.state)}>{s.state || 'unknown'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* LIFs */}
              <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Logical Interfaces (LIFs) {lifs ? `(${lifs.length})` : ''}</p>
                {lifs == null ? (
                  <LoadingPanel label="Loading LIFs…" height={100} />
                ) : lifs.length === 0 ? (
                  <div className="text-sm text-ink-muted py-4 text-center">No LIF data.</div>
                ) : (
                  <>
                  <TableControls ctl={lifCtl} rows={lifs} searchPlaceholder="Filter by name, SVM, address or node…"
                    filters={[{ k: 'svm_name', label: 'SVMs' }, { k: 'node_name', label: 'Nodes' }]} />
                  <div className="overflow-x-auto max-h-[48vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <SortTh k="name" label="Name" ctl={lifCtl} />
                        <SortTh k="svm_name" label="SVM" ctl={lifCtl} />
                        <SortTh k="address" label="Address" ctl={lifCtl} />
                        <SortTh k="node_name" label="Node" ctl={lifCtl} />
                        <SortTh k="port_name" label="Port" ctl={lifCtl} />
                        <SortTh k="is_home" label="Home" ctl={lifCtl} />
                        <SortTh k="state" label="State" ctl={lifCtl} />
                      </tr></thead>
                      <tbody>
                        {lifCtl.rows.map((l) => (
                          <tr key={l.id} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{l.name}</td>
                            <td className="py-2 pr-3 text-ink-muted">{l.svm_name || '—'}</td>
                            <td className="py-2 pr-3">{l.address ? <IpWithHost ip={l.address} dns={lifDns} /> : <span className="text-ink-faint">—</span>}</td>
                            <td className="py-2 pr-3 text-ink-muted">{l.node_name || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{l.port_name || '—'}</td>
                            <td className="py-2 pr-3"><Badge tone={l.is_home ? 'ok' : 'warn'}>{l.is_home ? 'home' : 'roamed'}</Badge></td>
                            <td className="py-2 pr-3"><Badge tone={statusTone(l.state)}>{l.state || 'unknown'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
