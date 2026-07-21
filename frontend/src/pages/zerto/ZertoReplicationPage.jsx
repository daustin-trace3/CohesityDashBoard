import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftRight, Globe2, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, fmtRpo, healthTone } from './helpers';

// Lane color follows the worst VPG health on the flow.
function flowColor(f) {
  if (f.error > 0) return '#C75D5D';
  if (f.warning > 0) return '#D4A24E';
  return '#6CB33F';
}

/**
 * Animated replication lane: protected site → recovery site with data
 * "packets" travelling along the wire (SVG SMIL animateMotion — no JS timers).
 * Packet speed slows as the flow degrades, echoing a struggling link.
 */
function FlowWire({ color, degraded }) {
  const dur = degraded ? '3.6s' : '1.8s';
  return (
    <svg viewBox="0 0 200 24" className="w-full h-6" preserveAspectRatio="none" aria-hidden="true">
      <line x1="4" y1="12" x2="188" y2="12" stroke={color} strokeOpacity="0.25" strokeWidth="2" strokeDasharray="6 5" />
      <polygon points="188,6 198,12 188,18" fill={color} fillOpacity="0.8" />
      {[0, 1, 2].map((i) => (
        <circle key={i} r="3" fill={color}>
          <animateMotion dur={dur} begin={`${(i * (degraded ? 1.2 : 0.6)).toFixed(1)}s`} repeatCount="indefinite" path="M 4 12 L 186 12" />
        </circle>
      ))}
    </svg>
  );
}

function SiteBox({ name, type, side }) {
  return (
    <div className={`flex flex-col ${side === 'right' ? 'items-start' : 'items-end'} min-w-0 w-44 flex-shrink-0`}>
      <div className="flex items-center gap-1.5 max-w-full">
        <Globe2 size={13} className="text-ink-faint flex-shrink-0" />
        <span className="text-sm font-semibold text-ink truncate">{name}</span>
      </div>
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">{type || (side === 'left' ? 'Protected' : 'Recovery')}</span>
    </div>
  );
}

export default function ZertoReplicationPage() {
  const { toast } = useToast();
  const [flows, setFlows] = useState(null);
  const [openKeys, setOpenKeys] = useState(() => new Set());
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/zerto/replication')
    .then(({ data }) => { setFlows(data); setLastRefreshed(new Date()); })
    .catch(() => { setFlows([]); toast({ type: 'error', title: 'Failed to load replication flows' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setOpenKeys((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totals = (flows || []).reduce((t, f) => ({
    vpgs: t.vpgs + f.vpgCount, vms: t.vms + f.vmCount, pairs: t.pairs + 1,
  }), { vpgs: 0, vms: 0, pairs: 0 });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="Zerto Replication" description="Live replication flows between sites — every VPG travels one of these lanes">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-4 mb-4 text-sm text-ink-muted">
        <span><span className="text-ink font-semibold tnum">{fmtNum(totals.pairs)}</span> site pair{totals.pairs === 1 ? '' : 's'}</span>
        <span><span className="text-ink font-semibold tnum">{fmtNum(totals.vpgs)}</span> VPGs</span>
        <span><span className="text-ink font-semibold tnum">{fmtNum(totals.vms)}</span> VMs replicating</span>
      </div>

      {flows == null ? (
        <LoadingPanel label="Loading replication flows…" height={200} />
      ) : flows.length === 0 ? (
        <div className="panel p-8 text-sm text-ink-muted text-center">No VPGs found — replication lanes appear once the Zerto poller has VPG data.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {flows.map((f) => {
            const key = `${f.from}|${f.to}`;
            const color = flowColor(f);
            const open = openKeys.has(key);
            const degraded = f.error > 0 || f.warning > 0;
            return (
              <div key={key} className="panel p-4" style={{ borderLeft: `3px solid ${color}` }}>
                <button onClick={() => toggle(key)} className="w-full cursor-pointer text-left">
                  <div className="flex items-center gap-4">
                    <SiteBox name={f.from} type={f.fromType} side="left" />
                    <div className="flex-1 min-w-0">
                      <FlowWire color={color} degraded={degraded} />
                      <div className="flex items-center justify-center gap-3 text-[11px] text-ink-faint mt-1">
                        <span className="tnum"><ShieldCheck size={11} className="inline mr-1" style={{ color }} />{f.vpgCount} VPG{f.vpgCount === 1 ? '' : 's'}</span>
                        <span className="tnum">{fmtNum(f.vmCount)} VMs</span>
                        <span className="tnum">worst RPO {fmtRpo(f.worstRpo)}</span>
                      </div>
                    </div>
                    <SiteBox name={f.to} type={f.toType} side="right" />
                    <span className="text-ink-faint flex-shrink-0">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    {f.healthy > 0 && <Badge tone="ok">{f.healthy} healthy</Badge>}
                    {f.warning > 0 && <Badge tone="warn">{f.warning} warning</Badge>}
                    {f.error > 0 && <Badge tone="crit">{f.error} error</Badge>}
                  </div>
                </button>
                {open && (
                  <div className="mt-3 pt-3 border-t border-cohesity-border/60 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-1.5 pr-3">VPG</th>
                        <th className="py-1.5 pr-3">Health</th>
                        <th className="py-1.5 pr-3">Status</th>
                        <th className="py-1.5 pr-3 text-right">VMs</th>
                        <th className="py-1.5 pr-3 text-right">Actual RPO</th>
                        <th className="py-1.5 pr-3 text-right">SLA RPO</th>
                      </tr></thead>
                      <tbody>
                        {f.vpgs.map((v) => (
                          <tr key={v.name} className="border-b border-cohesity-border/40">
                            <td className="py-1.5 pr-3 text-ink">{v.name}</td>
                            <td className="py-1.5 pr-3"><Badge tone={healthTone(v.health)}>{v.health || '—'}</Badge></td>
                            <td className="py-1.5 pr-3 text-ink-muted text-[11px]">{v.status || '—'}</td>
                            <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(v.vms_count)}</td>
                            <td className={`py-1.5 pr-3 text-right tnum ${v.configured_rpo && v.actual_rpo > v.configured_rpo ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtRpo(v.actual_rpo)}</td>
                            <td className="py-1.5 pr-3 text-right tnum text-ink-faint">{fmtRpo(v.configured_rpo)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
