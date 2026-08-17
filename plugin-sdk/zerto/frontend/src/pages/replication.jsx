// Zerto Replication — ported from frontend/src/pages/zerto/ZertoReplicationPage.jsx.
// The animated lane uses ui.jsx's `.zr-packet` / `@keyframes zr-flow` (scoped
// clones of the host's `.zerto-packet` / `@keyframes zerto-flow` in
// frontend/src/index.css) instead of SVG SMIL, matching the original's
// "no paint-trail artifacts in Chromium" fix.
import { ArrowLeftRight, Globe2, ShieldCheck, ChevronDown, ChevronUp } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, fmtNum, fmtRpo, healthTone,
} from '../ui.jsx';

function flowColor(f) {
  if (f.error > 0) return '#C75D5D';
  if (f.warning > 0) return '#D4A24E';
  return '#6CB33F';
}

const SEVERITY_DUR = { ok: 1.8, warn: 4.2, error: 7.5 };

function laneJitter(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return (h >>> 0) / 4294967295;
}

function FlowWire({ color, severity, seed }) {
  const j = laneJitter(seed || '');
  const dur = (SEVERITY_DUR[severity] || SEVERITY_DUR.ok) * (0.85 + j * 0.3);
  const phase = j * dur;
  return (
    <div className="relative w-full h-6 overflow-hidden" aria-hidden="true">
      <div className="absolute top-1/2 -translate-y-1/2 border-t-2 border-dashed"
        style={{ left: 4, right: 14, borderColor: color, opacity: 0.25 }} />
      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0"
        style={{ borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: `10px solid ${color}`, opacity: 0.8 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="absolute top-1/2 rounded-full zr-packet"
          style={{
            width: 26, height: 6, marginTop: -3, backgroundColor: color,
            animationDuration: `${dur.toFixed(2)}s`,
            animationDelay: `${(-(i * dur / 3) - phase).toFixed(2)}s`,
          }} />
      ))}
    </div>
  );
}

function FlowVpgTable({ vpgs }) {
  const ctl = useTableControls(vpgs, {
    searchKeys: ['name', 'status', 'health'],
    defaultSortKey: 'actual_rpo', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="mt-3 pt-3 border-t border-cohesity-border/60 overflow-x-auto">
      <TableControls ctl={ctl} rows={vpgs} searchPlaceholder="Filter by VPG, status or health…"
        filters={[{ k: 'health', label: 'Health' }, { k: 'status', label: 'Statuses' }]} />
      {ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-4 text-center">No VPGs match your filters.</div>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <SortTh k="name" label="VPG" ctl={ctl} />
            <SortTh k="health" label="Health" ctl={ctl} />
            <SortTh k="status" label="Status" ctl={ctl} />
            <SortTh k="vms_count" label="VMs" ctl={ctl} align="right" />
            <SortTh k="actual_rpo" label="Actual RPO" ctl={ctl} align="right" />
            <SortTh k="configured_rpo" label="SLA RPO" ctl={ctl} align="right" />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((v) => (
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
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </div>
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
  const [flows, setFlows] = React.useState(null);
  const [openKeys, setOpenKeys] = React.useState(() => new Set());
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/zerto/replication')
    .then((json) => { setFlows(json); setLastRefreshed(new Date()); })
    .catch(() => setFlows([])), []);

  React.useEffect(() => { load(); }, [load]);

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
            const severity = f.error > 0 ? 'error' : f.warning > 0 ? 'warn' : 'ok';
            return (
              <div key={key} className="panel p-4" style={{ borderLeft: `3px solid ${color}` }}>
                <button onClick={() => toggle(key)} className="w-full cursor-pointer text-left"
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit' }}>
                  <div className="flex items-center gap-4">
                    <SiteBox name={f.from} type={f.fromType} side="left" />
                    <div className="flex-1 min-w-0">
                      <FlowWire color={color} severity={severity} seed={key} />
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
                {open && <FlowVpgTable vpgs={f.vpgs} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
