import { useEffect, useState, useMemo, useCallback } from 'react';
import { HardDrive, RefreshCw, Cpu, Server, ShieldCheck, CircuitBoard } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, fmtDateMs, daysUntilMs, statusTone } from './helpers';

export default function PureHardwarePage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [hw, setHw] = useState(null);
  const [compliance, setCompliance] = useState([]);
  const [issuesOnly, setIssuesOnly] = useState(false);

  const loadArrays = useCallback(() => {
    return Promise.allSettled([client.get('/pure/arrays'), client.get('/pure/compliance')]).then(([a, c]) => {
      const list = a.status === 'fulfilled' ? a.value.data : [];
      setArrays(list);
      setCompliance(c.status === 'fulfilled' ? c.value.data : []);
      setSelectedId((cur) => (cur && list.some((x) => x.id === cur) ? cur : list[0]?.id ?? null));
      if (a.status === 'rejected') toast({ type: 'error', title: 'Failed to load Pure arrays' });
    });
  }, [toast]);

  useEffect(() => { loadArrays(); }, [loadArrays]);

  useEffect(() => {
    if (!selectedId) { setHw(null); return; }
    let cancelled = false;
    setHw(null);
    client.get(`/pure/arrays/${selectedId}/hardware`)
      .then(({ data }) => { if (!cancelled) setHw(data); })
      .catch(() => { if (!cancelled) setHw({ hardware: [], drives: [], controllers: [] }); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const comp = compliance.find((c) => c.id === selectedId);
  const components = hw?.hardware || [];
  const drives = hw?.drives || [];
  const controllers = hw?.controllers || [];

  const statusCounts = useMemo(() => {
    const c = { ok: 0, warn: 0, crit: 0 };
    for (const h of components) {
      const t = statusTone(h.status);
      if (t === 'ok') c.ok += 1; else if (t === 'warn') c.warn += 1; else if (t === 'crit') c.crit += 1;
    }
    return c;
  }, [components]);

  const driveCapacity = drives.reduce((s, d) => s + (d.capacity_bytes || 0), 0);
  const shownComponents = issuesOnly ? components.filter((h) => statusTone(h.status) !== 'ok') : components;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Pure Hardware & Compliance" description="Physical inventory, controllers, drives, certificates and software versions">
        <button
          onClick={loadArrays}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading arrays…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No Pure arrays registered yet.
        </div>
      ) : (
        <>
          {/* Array selector */}
          <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 mb-4 self-start overflow-x-auto">
            {arrays.map((a) => {
              const active = a.id === selectedId;
              return (
                <button key={a.id} onClick={() => setSelectedId(a.id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${
                    active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                  }`}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: BRAND }} />{a.name}
                </button>
              );
            })}
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={Cpu} label="Controllers" value={fmtNum(controllers.length)} tone="brand" />
            <StatCard icon={CircuitBoard} label="Drives" value={fmtNum(drives.length)} sub={fmtBytes(driveCapacity)} />
            <StatCard icon={Server} label="Components" value={fmtNum(components.length)} />
            <StatCard icon={ShieldCheck} label="Component Health"
              value={statusCounts.crit > 0 ? `${statusCounts.crit} critical` : statusCounts.warn > 0 ? `${statusCounts.warn} warning` : 'All OK'}
              tone={statusCounts.crit > 0 ? 'crit' : statusCounts.warn > 0 ? 'warn' : 'ok'} />
          </div>

          {hw == null ? (
            <LoadingPanel label="Loading hardware…" />
          ) : (
            <>
              {/* Controllers */}
              <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Controllers</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Model</th>
                        <th className="py-2 pr-3">Mode</th><th className="py-2 pr-3">Purity</th><th className="py-2 pr-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {controllers.map((c) => (
                        <tr key={c.id} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink">{c.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{c.model || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted capitalize">{c.mode || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted tnum">{c.version || '—'}</td>
                          <td className="py-2 pr-3"><Badge tone={statusTone(c.status)}>{c.status || 'unknown'}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                {/* Drives */}
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">Drives ({drives.length})</p>
                  <div className="overflow-x-auto max-h-[42vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface">
                        <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <th className="py-2 pr-3">Bay</th><th className="py-2 pr-3">Type</th>
                          <th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Capacity</th><th className="py-2 pr-3">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drives.map((d) => (
                          <tr key={d.id} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{d.name}</td>
                            <td className="py-2 pr-3 text-ink-muted">{d.type || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{d.protocol || '—'}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.capacity_bytes)}</td>
                            <td className="py-2 pr-3"><Badge tone={statusTone(d.status)}>{d.status || 'unknown'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Certificates + versions */}
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-3">Certificates & Software</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(comp?.versions || []).map((v) => (
                      <Badge key={v} tone="brand">Purity {v}</Badge>
                    ))}
                    {(!comp || comp.versions.length === 0) && <span className="text-xs text-ink-faint">No version data yet.</span>}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <th className="py-2 pr-3">Certificate</th><th className="py-2 pr-3">Status</th>
                          <th className="py-2 pr-3 text-right">Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(comp?.certificates || []).map((c) => {
                          const days = daysUntilMs(c.valid_to_ms);
                          const tone = days == null ? 'neutral' : days < 30 ? 'crit' : days < 90 ? 'warn' : 'ok';
                          return (
                            <tr key={c.id} className="border-b border-cohesity-border/50">
                              <td className="py-2 pr-3 text-ink">{c.name}{c.common_name ? <span className="text-ink-faint"> · {c.common_name}</span> : ''}</td>
                              <td className="py-2 pr-3 text-ink-muted">{c.status || '—'}</td>
                              <td className="py-2 pr-3 text-right">
                                <Badge tone={tone}>{fmtDateMs(c.valid_to_ms)}{days != null ? ` (${days}d)` : ''}</Badge>
                              </td>
                            </tr>
                          );
                        })}
                        {(!comp || comp.certificates.length === 0) && (
                          <tr><td colSpan={3} className="py-4 text-center text-xs text-ink-faint">No certificate data yet.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Components */}
              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-ink">Components ({components.length})</p>
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
                    <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} className="accent-brand cursor-pointer" />
                    Issues only
                  </label>
                </div>
                <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface">
                      <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Component</th><th className="py-2 pr-3">Type</th>
                        <th className="py-2 pr-3">Model / Serial</th><th className="py-2 pr-3 text-right">Temp</th><th className="py-2 pr-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownComponents.map((h) => (
                        <tr key={h.id} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink">{h.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{h.type || '—'}</td>
                          <td className="py-2 pr-3 text-ink-muted">{h.model || h.serial || '—'}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{h.temperature != null ? `${h.temperature}°C` : '—'}</td>
                          <td className="py-2 pr-3"><Badge tone={statusTone(h.status)}>{h.status || 'unknown'}</Badge></td>
                        </tr>
                      ))}
                      {shownComponents.length === 0 && (
                        <tr><td colSpan={5} className="py-4 text-center text-xs text-status-ok">No component issues.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
