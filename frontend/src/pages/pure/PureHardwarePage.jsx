import { useEffect, useState, useCallback, useMemo } from 'react';
import { HardDrive, RefreshCw, Cpu, CircuitBoard, Database } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum } from './helpers';
import { usePure1Arrays, ArraySelect } from './usePure1Arrays';

function healthTone(s) {
  const v = String(s || '').toLowerCase();
  if (['ok', 'healthy', 'ready'].includes(v)) return 'ok';
  if (['critical', 'failed', 'unhealthy'].includes(v)) return 'crit';
  if (['warning', 'degraded'].includes(v)) return 'warn';
  return 'neutral';
}

export default function PureHardwarePage() {
  const { toast } = useToast();
  const { arrays, arrayId, setArrayId } = usePure1Arrays();
  const [hw, setHw] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!arrayId) return undefined;
    setLoading(true);
    return client.get(`/pure1/hardware?arrayId=${arrayId}`)
      .then(({ data }) => setHw(data))
      .catch(() => { setHw({ controllers: [], components: [], drives: [] }); toast({ type: 'error', title: 'Failed to load hardware' }); })
      .finally(() => setLoading(false));
  }, [arrayId, toast]);

  useEffect(() => { load(); }, [load]);

  const controllers = hw?.controllers || [];
  const components = hw?.components || [];
  const drives = hw?.drives || [];
  const driveCapacity = useMemo(() => drives.reduce((s, d) => s + (d.capacity || 0), 0), [drives]);
  const unhealthy = useMemo(() =>
    [...components, ...drives].filter((c) => !['ok', 'healthy', 'ready', '', null, undefined].includes(String(c.status || '').toLowerCase())).length,
    [components, drives]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Pure Hardware" description="Controllers, components and drives from Pure Storage">
        <div className="flex items-center gap-2">
          <ArraySelect arrays={arrays} value={arrayId} onChange={setArrayId} />
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Cpu} label="Controllers" value={fmtNum(controllers.length)} tone="brand" />
        <StatCard icon={Database} label="Drives" value={fmtNum(drives.length)} sub={driveCapacity ? fmtBytes(driveCapacity) : undefined} />
        <StatCard icon={CircuitBoard} label="Components" value={fmtNum(components.length)} />
        <StatCard icon={HardDrive} label="Unhealthy" value={fmtNum(unhealthy)} tone={unhealthy > 0 ? 'crit' : 'ok'} />
      </div>

      {/* Controllers */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Controllers</p>
        {hw == null ? <LoadingPanel label="Loading…" height={100} /> : controllers.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No controllers.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Mode</th><th className="py-2 pr-3">Model</th><th className="py-2 pr-3">Serial</th><th className="py-2 pr-3">Purity</th><th className="py-2 pr-3">Status</th>
              </tr></thead>
              <tbody>
                {controllers.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                    <td className="py-2 pr-3 text-ink-muted capitalize">{c.mode || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint font-mono text-[12px]">{c.serial || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{c.version || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(c.status)}>{c.status || '—'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drives */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Drives ({drives.length})</p>
        {hw == null ? <LoadingPanel label="Loading…" height={120} /> : drives.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No drives.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Bay</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Capacity</th><th className="py-2 pr-3">Status</th>
              </tr></thead>
              <tbody>
                {drives.map((d) => (
                  <tr key={d.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{d.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.protocol || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.capacity)}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(d.status)}>{d.status || '—'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Components */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Components ({components.length})</p>
        {hw == null ? <LoadingPanel label="Loading…" height={120} /> : components.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No components.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Model</th><th className="py-2 pr-3">Serial</th><th className="py-2 pr-3">Status</th>
              </tr></thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[12px]">{c.serial || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(c.status)}>{c.status || '—'}</Badge></td>
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
