// Cohesity plugin — Licensing page. Ported from frontend/src/pages/LicensingPage.jsx
// + the "Licensing Entitlement" tab body of frontend/src/pages/SettingsPage.jsx
// (exported here as EntitlementTab — settings.jsx's TABS array has a commented
// placeholder for it; the orchestrator wires it in, this file just needs to
// export it). Doughnut/Bar charts rewritten onto the kit's charts.jsx. Sorting
// on every table rewritten onto the kit's useTableControls/SortTh instead of
// the built-in's local useTableSort/sortRows helpers.
import {
  apiFetch, useToast, downloadBlob, timeAgo,
  PageHeader, Panel, Badge, StatCard, LoadingPanel, EmptyState, RefreshButton,
  useTableControls, SortTh, TableSearch,
} from '../ui.jsx';
import { BadgeCheck, Database, ShieldCheck, ArrowLeftRight, Download, Save, Settings as SettingsIcon } from '../icons.jsx';
import { BarChart, DoughnutChart } from '../charts.jsx';

/* ────────────────────────────────────────────────────────────────────────
 * Page-local icons — not in the shared kit (icons.jsx has no folder/tree,
 * layers, calendar-clock, printer, or flask-conical glyphs yet).
 * ────────────────────────────────────────────────────────────────────── */
function Icon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      {children}
    </svg>
  );
}
const FolderTree = (p) => <Icon {...p}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M8 12h5M8 16h3" /></Icon>;
const FolderLock = (p) => <Icon {...p}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><rect x="9" y="11" width="6" height="5" rx="1" /><path d="M10.5 11V9.5a1.5 1.5 0 0 1 3 0V11" /></Icon>;
const Layers = (p) => <Icon {...p}><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></Icon>;
const CalendarClock = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h6" /><circle cx="16" cy="16" r="4" /><path d="M16 14.5V16l1 1" /></Icon>;
const Printer = (p) => <Icon {...p}><path d="M6 9V3h12v6" /><rect x="4" y="9" width="16" height="8" rx="1" /><path d="M6 17v4h12v-4" /></Icon>;
const FlaskConical = (p) => <Icon {...p}><path d="M9 2h6" /><path d="M10 2v6.5L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8.5V2" /><path d="M6.5 14h11" /></Icon>;
const RotateCcwLocal = (p) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></Icon>;

/* Cohesity licenses in decimal TB, so all capacities render in TB. */
const TB = 1e12;
const toTb = (b) => (b || 0) / TB;
function fmtTb(b) {
  const t = toTb(b);
  if (t >= 100) return t.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' TB';
  return t.toFixed(1) + ' TB';
}

const TYPE_META = {
  dataProtect: { icon: ShieldCheck, blurb: 'All backed-up workloads (VMware, databases, physical, M365, NAS backups). Usage from Cohesity’s license meter.' },
  replica: { icon: ArrowLeftRight, blurb: 'Data replicated in from other Cohesity clusters. Usage from Cohesity’s license meter (dataProtectReplica).' },
  smartFiles: { icon: FolderTree, blurb: 'Views / NAS shares served to clients. Usage from Cohesity’s license meter (externalViews).' },
};

const BASIS_LABEL = { cohesityMeter: '', usedPhysical: ' (used at targets)', frontEnd: ' (front-end)' };

// Breakdown categories: what the data on each cluster actually is. Views are
// split by provenance — read-only views were replicated in (Replica license),
// writable views hold data written directly to this cluster (SmartFiles).
const BREAKDOWN_META = [
  { key: 'backup', label: 'Backed Up', icon: ShieldCheck, color: '#6CB33F', blurb: 'Local backup data (protection runs)' },
  { key: 'replication', label: 'Replicated In', icon: ArrowLeftRight, color: '#3B82F6', blurb: 'Data replicated in from other clusters' },
  { key: 'viewsReplicated', label: 'Replicated Views', icon: ArrowLeftRight, color: '#818CF8', blurb: 'Read-only Views replicated in (counts as Replica)' },
  { key: 'views', label: 'Views (SmartFiles)', icon: FolderTree, color: '#F59E0B', blurb: 'Writable Views — shares and backup targets' },
  { key: 'viewBackups', label: 'View Backups', icon: FolderLock, color: '#A78BFA', blurb: 'Backups of Views (protected shares)' },
];

// Which license each breakdown category is billed against — drives the
// what-if explorer's estimated impact on the license cards.
const CATEGORY_LICENSE = { backup: 'dataProtect', replication: 'replica', viewsReplicated: 'replica', views: 'smartFiles', viewBackups: 'dataProtect' };
const BASIS_CSV = { cohesityMeter: 'Cohesity license meter', usedPhysical: 'Used at targets', frontEnd: 'Front-end' };

/* ────────────────────────────────────────────────────────────────────────
 * TypeGauge — doughnut % ring, rewritten onto charts.jsx's DoughnutChart
 * ────────────────────────────────────────────────────────────────────── */
function TypeGauge({ pct }) {
  const clamped = Math.max(0, Math.min(pct, 100));
  const color = pct >= 90 ? '#EF4444' : pct >= 75 ? '#F59E0B' : '#6CB33F';
  const data = {
    labels: ['Consumed', 'Remaining'],
    datasets: [{ data: [clamped, 100 - clamped], backgroundColor: [color, 'rgba(255,255,255,0.08)'], borderWidth: 0, circumference: 360 }],
  };
  const options = { cutout: '74%', plugins: { legend: { display: false }, tooltip: { enabled: false } } };
  return (
    <div style={{ position: 'relative', height: 112, width: 112, flexShrink: 0 }}>
      <DoughnutChart data={data} options={options} height={112} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span className="tnum" style={{ fontSize: 20, fontWeight: 700, color }}>{pct.toFixed(0)}%</span>
        <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: pct > 100 ? 'var(--co-crit)' : 'var(--co-ink-faint)' }}>{pct > 100 ? 'Over' : 'Used'}</span>
      </div>
    </div>
  );
}

function LicenseTypeCard({ type }) {
  const Icon2 = TYPE_META[type.key]?.icon || BadgeCheck;
  const simActive = type.simConsumedBytes != null && (type.simExcludedBytes || 0) > 0;
  const effectiveBytes = simActive ? type.simConsumedBytes : type.consumedBytes;
  const consumedTb = toTb(effectiveBytes);
  const entitled = type.entitledTb || 0;
  const pct = entitled > 0 ? (consumedTb / entitled) * 100 : null;
  const headroom = entitled > 0 ? entitled - consumedTb : null;

  return (
    <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, borderColor: simActive ? 'rgba(96,165,250,0.4)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)', flexShrink: 0 }}>
          <Icon2 size={18} style={{ color: 'var(--co-brand)' }} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            {type.label}
            {simActive && <Badge tone="info">Simulated</Badge>}
          </p>
          <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', lineHeight: 1.375, margin: '2px 0 0' }}>{TYPE_META[type.key]?.blurb}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {pct != null ? (
          <TypeGauge pct={pct} />
        ) : (
          <div style={{ height: 112, width: 112, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: '50%', border: '1px dashed var(--co-border)', textAlign: 'center', padding: '0 12px' }}>
            <span style={{ fontSize: 10, color: 'var(--co-ink-muted)', lineHeight: 1.25 }}>Set entitlement in Settings</span>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, minWidth: 0 }}>
          {simActive && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--co-ink-muted)', fontSize: 12 }}>Actual (billed)</span>
              <span className="tnum" style={{ color: 'var(--co-ink-faint)', textDecoration: 'line-through' }}>{fmtTb(type.consumedBytes)}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--co-ink-muted)', fontSize: 12 }}>{simActive ? 'Simulated' : `Consumed${BASIS_LABEL[type.basis] ?? ''}`}</span>
            <span className="tnum" style={{ color: 'var(--co-ink)', fontWeight: 600 }}>{fmtTb(effectiveBytes)}</span>
          </div>
          {simActive && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--co-ink-muted)', fontSize: 12 }}>Excluded</span>
              <span className="tnum" style={{ color: 'var(--co-info)', fontWeight: 600 }}>−{fmtTb(type.simExcludedBytes)}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--co-ink-muted)', fontSize: 12 }}>Entitled</span>
            <span className="tnum" style={{ color: 'var(--co-ink)', fontWeight: 600 }}>{entitled > 0 ? fmtTb(entitled * TB) : '— not set'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--co-ink-muted)', fontSize: 12 }}>Headroom</span>
            <span className="tnum" style={{ fontWeight: 600, color: headroom == null ? 'var(--co-ink-faint)' : headroom < 0 ? 'var(--co-crit)' : 'var(--co-ink)' }}>
              {headroom == null ? '—' : (headroom < 0 ? '-' : '') + fmtTb(Math.abs(headroom) * TB)}
            </span>
          </div>
        </div>
      </div>
      {type.key === 'smartFiles' && (
        <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', lineHeight: 1.375, marginTop: -4 }}>
          Per-view inventory (backup, replication, DataLock) is on the{' '}
          <window.ReactRouterDOM.Link to="/cohesity/views" style={{ color: 'var(--co-brand)' }}>Views page</window.ReactRouterDOM.Link> — its writable-views consumed
          figure matches the Views (SmartFiles) column of the breakdown below on a physical on-disk basis.
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ViewDetailPanel — per-system, per-view table with a bulk-select-all row
 * ────────────────────────────────────────────────────────────────────── */
function ViewDetailPanel({ systems, explorer, excludedViews, onToggleView }) {
  const withViews = systems.filter((s) => (s.categories.views?.physicalBytes || 0) + (s.categories.viewsReplicated?.physicalBytes || 0) > 0);
  const [systemId, setSystemId] = React.useState(withViews[0]?.systemId || '');
  const [rows, setRows] = React.useState(null);

  React.useEffect(() => {
    if (!systemId) return;
    setRows(null);
    apiFetch(`/cohesity/licensing/views/${systemId}`).then(setRows).catch(() => setRows([]));
  }, [systemId]);

  const withData = React.useMemo(() => (rows || []).filter((r) => r.physicalBytes > 0), [rows]);
  const ctl = useTableControls(withData, {
    searchKeys: ['viewName'],
    defaultSortKey: 'physicalBytes',
    defaultSortDir: 'desc',
    sortValues: {
      viewName: (r) => r.viewName,
      attribution: (r) => (r.isReadOnly ? 1 : 0),
      createdMs: (r) => r.createdMs || 0,
      physicalBytes: (r) => r.physicalBytes || 0,
      dataWrittenBytes: (r) => r.dataWrittenBytes || 0,
      logicalBytes: (r) => r.logicalBytes || 0,
    },
  });

  if (withViews.length === 0) return null;
  const shown = ctl.rows;
  const allShownIncluded = shown.length > 0 && shown.every((r) => !excludedViews.has(`${systemId}|${r.viewName}`));
  const bulkToggleShown = () => {
    for (const r of shown) {
      const isExcluded = excludedViews.has(`${systemId}|${r.viewName}`);
      if (allShownIncluded ? !isExcluded : isExcluded) onToggleView(systemId, r);
    }
  };

  return (
    <Panel title="View Detail — Replicated vs Receiving Backups" icon={FolderTree}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TableSearch ctl={ctl} placeholder="Filter view names…" className="w-40" />
          <select value={systemId} onChange={(e) => setSystemId(e.target.value)} className="co-input" style={{ width: 'auto', cursor: 'pointer' }}>
            {withViews.map((s) => <option key={s.systemId} value={s.systemId}>{s.systemName || s.systemId}</option>)}
          </select>
        </div>
      }>
      {rows == null ? (
        <LoadingPanel label="Loading views…" height={120} />
      ) : shown.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--co-ink-faint)', padding: '16px 0', textAlign: 'center' }}>
          {ctl.q ? `No views matching "${ctl.q.trim()}" on this system.` : 'No views with data on this system.'}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)', textAlign: 'left' }}>
                {explorer && (
                  <th style={{ padding: '8px 12px 8px 0' }} title="Unchecked views are removed from the simulated totals">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={allShownIncluded} onChange={bulkToggleShown} className="accent-brand" style={{ cursor: 'pointer' }}
                        title={allShownIncluded ? 'Deselect all views shown below' : 'Select all views shown below'} />
                      Incl.
                    </span>
                  </th>
                )}
                <SortTh k="viewName" label="View" ctl={ctl} align="left" />
                <SortTh k="attribution" label="License Attribution" ctl={ctl} align="left" />
                <SortTh k="createdMs" label="Created" ctl={ctl} align="left" />
                <SortTh k="physicalBytes" label="Physical" ctl={ctl} align="right" />
                <SortTh k="dataWrittenBytes" label="Data Written" ctl={ctl} align="right" />
                <SortTh k="logicalBytes" label="Logical" ctl={ctl} align="right" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const excluded = explorer && excludedViews.has(`${systemId}|${r.viewName}`);
                return (
                  <tr key={r.viewName} style={{ borderBottom: '1px solid rgba(31,43,55,.6)', opacity: excluded ? 0.5 : 1 }}>
                    {explorer && (
                      <td style={{ padding: '8px 12px 8px 0' }}>
                        <input type="checkbox" checked={!excluded} onChange={() => onToggleView(systemId, r)} className="accent-brand" style={{ cursor: 'pointer' }} />
                      </td>
                    )}
                    <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, textDecoration: excluded ? 'line-through' : 'none' }}>{r.viewName}</td>
                    <td style={{ padding: '8px 16px 8px 0' }}>
                      {r.isReadOnly ? <Badge tone="info">Replicated in · Replica</Badge> : <Badge tone="warn">Receiving data · SmartFiles</Badge>}
                    </td>
                    <td className="tnum" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{r.createdMs ? new Date(r.createdMs).toISOString().slice(0, 10) : '—'}</td>
                    <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.physicalBytes)}</td>
                    <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.dataWrittenBytes)}</td>
                    <td className="tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.logicalBytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 12, lineHeight: 1.375 }}>
        Read-only views were replicated in from another cluster and count toward Replica licensing. Writable views are
        actively receiving data (NAS shares or backup-into-view targets) and count toward SmartFiles. The full estate-wide
        inventory, including protection and DataLock status, is on the{' '}
        <window.ReactRouterDOM.Link to="/cohesity/views" style={{ color: 'var(--co-brand)' }}>Views page</window.ReactRouterDOM.Link>.
      </p>
    </Panel>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * BreakdownSection — category stat cards + stacked bar (charts.jsx) + table
 * ────────────────────────────────────────────────────────────────────── */
function BreakdownSection({ breakdown, sim, explorer, excludedSystems, excludedCategories, onToggleSystem, onToggleCategory }) {
  const eff = sim?.breakdown || breakdown;
  const totals = eff?.totals || {};
  const origMap = new Map((breakdown?.bySystem || []).map((s) => [s.systemId, s]));
  const systems = (eff?.bySystem || []).filter((s) => {
    const o = origMap.get(s.systemId) || s;
    return Object.values(o.categories).some((c) => c.physicalBytes > 0);
  });

  const sysTotal = (s) => BREAKDOWN_META.reduce((acc, m) => acc + (s.categories[m.key]?.physicalBytes || 0), 0);
  const sortValues = {
    system: (s) => s.systemName || s.systemId,
    total: sysTotal,
    ...Object.fromEntries(BREAKDOWN_META.map((m) => [m.key, (s) => s.categories[m.key]?.physicalBytes || 0])),
  };
  const ctl = useTableControls(systems, { defaultSortKey: 'total', defaultSortDir: 'desc', sortValues });

  if (systems.length === 0) return null;
  const tableRows = ctl.rows;

  // top uses the ORIGINAL (unsorted) system order, matching the built-in page.
  const top = systems.slice(0, 12);
  const chartData = {
    labels: top.map((s) => s.systemName || s.systemId),
    datasets: BREAKDOWN_META.map((m) => ({
      label: m.label,
      data: top.map((s) => toTb(s.categories[m.key]?.physicalBytes)),
      backgroundColor: m.color,
      stack: 'consumed',
      borderWidth: 0,
    })),
  };
  const chartOptions = {
    indexAxis: 'y',
    plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.x.toFixed(1)} TB` } } },
    scales: {
      x: { stacked: true, ticks: { callback: (v) => parseFloat(Number(v).toFixed(1)) + ' TB' } },
      y: { stacked: true, grid: { display: false } },
    },
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {BREAKDOWN_META.map((m) => {
          const t = totals[m.key] || {};
          const noun = m.key === 'views' || m.key === 'viewsReplicated' ? 'views' : 'jobs';
          const catExcluded = explorer && excludedCategories.has(m.key);
          return (
            <div key={m.key} style={{ position: 'relative', opacity: catExcluded ? 0.5 : 1 }}>
              {explorer && (
                <input type="checkbox" checked={!catExcluded} onChange={() => onToggleCategory(m.key)}
                  title={`Include all ${m.label} in the simulation`}
                  className="accent-brand" style={{ position: 'absolute', top: 10, right: 10, zIndex: 1, cursor: 'pointer' }} />
              )}
              <StatCard icon={m.icon} label={m.label} value={fmtTb(t.physicalBytes)} sub={`${t.consumers || 0} ${noun} · ${fmtTb(t.logicalBytes)} logical`} />
            </div>
          );
        })}
      </div>

      <Panel title="Backup vs Replication vs Views — by System" icon={Layers}
        actions={<span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>physical (on-disk) consumption · top {top.length} of {systems.length} systems</span>}>
        <BarChart data={chartData} options={chartOptions} height={Math.max(240, top.length * 34)} />

        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)', textAlign: 'left' }}>
                {explorer && <th style={{ padding: '8px 12px 8px 0' }} title="Unchecked systems are removed from the simulated totals">Incl.</th>}
                <SortTh k="system" label="System" ctl={ctl} align="left" />
                {BREAKDOWN_META.map((m) => (
                  <SortTh key={m.key} k={m.key} ctl={ctl} align="right" label={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: m.color }} />
                      {m.label}
                    </span>
                  } />
                ))}
                <SortTh k="total" label="Total" ctl={ctl} align="right" />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((s) => {
                const sysExcluded = explorer && excludedSystems.has(s.systemId);
                const display = sysExcluded ? (origMap.get(s.systemId) || s) : s;
                const total = sysTotal(display);
                return (
                  <tr key={s.systemId} style={{ borderBottom: '1px solid rgba(31,43,55,.6)', opacity: sysExcluded ? 0.5 : 1 }}>
                    {explorer && (
                      <td style={{ padding: '8px 12px 8px 0' }}>
                        <input type="checkbox" checked={!sysExcluded} onChange={() => onToggleSystem(s.systemId)} className="accent-brand" style={{ cursor: 'pointer' }} />
                      </td>
                    )}
                    <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, textDecoration: sysExcluded ? 'line-through' : 'none' }}>{s.systemName || s.systemId}</td>
                    {BREAKDOWN_META.map((m) => {
                      const catExcluded = explorer && excludedCategories.has(m.key);
                      const source = catExcluded ? (origMap.get(s.systemId) || s) : display;
                      const v = source.categories[m.key]?.physicalBytes || 0;
                      const struck = sysExcluded || catExcluded;
                      return (
                        <td key={m.key} className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: v === 0 ? 'var(--co-ink-faint)' : 'var(--co-ink-muted)', textDecoration: struck && v > 0 ? 'line-through' : 'none' }}>
                          {v > 0 ? fmtTb(v) : '—'}
                        </td>
                      );
                    })}
                    <td className="tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--co-ink)', fontWeight: 600, textDecoration: sysExcluded ? 'line-through' : 'none' }}>{fmtTb(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 12, lineHeight: 1.375 }}>
          Replicated data is measured on the cluster it lands on (DR targets). Views are split by provenance:
          read-only views were replicated in and count toward Replica licensing; writable views hold data written
          directly to that cluster and count as SmartFiles. Logical (front-end) sizes are in the summary cards above.
        </p>
      </Panel>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * LicensingPage — default export
 * ────────────────────────────────────────────────────────────────────── */
export default function LicensingPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const { toast } = useToast();

  // ── What-if explorer ────────────────────────────────────────
  const [explorer, setExplorer] = React.useState(false);
  const [excludedSystems, setExcludedSystems] = React.useState(() => new Set());
  const [excludedCategories, setExcludedCategories] = React.useState(() => new Set());
  // key `${systemId}|${viewName}` → view row snapshot (bytes + attribution)
  const [excludedViews, setExcludedViews] = React.useState(() => new Map());

  const toggleSystem = (id) => setExcludedSystems((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleCategory = (key) => setExcludedCategories((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const toggleView = (systemId, row) => setExcludedViews((prev) => {
    const next = new Map(prev);
    const key = `${systemId}|${row.viewName}`;
    if (next.has(key)) next.delete(key);
    else next.set(key, { systemId, viewName: row.viewName, isReadOnly: !!row.isReadOnly, physicalBytes: row.physicalBytes || 0, logicalBytes: row.logicalBytes || 0 });
    return next;
  });
  const resetExplorer = () => { setExcludedSystems(new Set()); setExcludedCategories(new Set()); setExcludedViews(new Map()); };

  // Simulated breakdown + license figures with the excluded items removed.
  // License-card impact is an estimate: excluded on-disk bytes are subtracted
  // from the meter figure, which uses Cohesity's own accounting.
  const sim = React.useMemo(() => {
    if (!explorer || !data?.breakdown) return null;
    const bySystem = (data.breakdown.bySystem || []).map((s) => {
      const categories = {};
      for (const [k, c] of Object.entries(s.categories)) {
        const zeroed = excludedSystems.has(s.systemId) || excludedCategories.has(k);
        categories[k] = zeroed ? { ...c, physicalBytes: 0, logicalBytes: 0, consumers: 0 } : { ...c };
      }
      return { ...s, categories };
    });
    for (const v of excludedViews.values()) {
      const catKey = v.isReadOnly ? 'viewsReplicated' : 'views';
      if (excludedSystems.has(v.systemId) || excludedCategories.has(catKey)) continue;
      const cat = bySystem.find((s) => s.systemId === v.systemId)?.categories[catKey];
      if (!cat) continue;
      cat.physicalBytes = Math.max(0, cat.physicalBytes - v.physicalBytes);
      cat.logicalBytes = Math.max(0, cat.logicalBytes - v.logicalBytes);
      cat.consumers = Math.max(0, cat.consumers - 1);
    }
    const totals = {};
    for (const s of bySystem) {
      for (const [k, c] of Object.entries(s.categories)) {
        if (!totals[k]) totals[k] = { consumers: 0, physicalBytes: 0, logicalBytes: 0 };
        totals[k].consumers += c.consumers;
        totals[k].physicalBytes += c.physicalBytes;
        totals[k].logicalBytes += c.logicalBytes;
      }
    }
    const excludedByType = { dataProtect: 0, replica: 0, smartFiles: 0 };
    for (const [k, t] of Object.entries(data.breakdown.totals || {})) {
      const lic = CATEGORY_LICENSE[k];
      if (!lic) continue;
      excludedByType[lic] += Math.max(0, (t.physicalBytes || 0) - (totals[k]?.physicalBytes || 0));
    }
    const types = data.types.map((t) => ({ ...t, simConsumedBytes: Math.max(0, t.consumedBytes - excludedByType[t.key]), simExcludedBytes: excludedByType[t.key] }));
    return {
      breakdown: { ...data.breakdown, totals, bySystem },
      types,
      excludedByType,
      excludedCount: excludedSystems.size + excludedCategories.size + excludedViews.size,
      excludedBytes: Object.values(excludedByType).reduce((a, b) => a + b, 0),
    };
  }, [explorer, data, excludedSystems, excludedCategories, excludedViews]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/cohesity/licensing')); }
    catch { setData(null); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await apiFetch('/cohesity/licensing/refresh', { method: 'POST', body: {} });
      setData(result);
      const failed = result.refreshFailedSources || [];
      if (failed.length > 0) toast({ type: 'warning', title: 'Partially refreshed', message: `Helios was slow for: ${failed.join(', ')}. Previous figures kept for those; everything else is fresh.` });
      else toast({ type: 'success', title: 'Licensing refreshed', message: 'Pulled the latest consumption from Helios.' });
    } catch (e) {
      toast({ type: 'error', title: 'Refresh failed', message: e.payload?.error || 'Could not refresh licensing data.' });
    } finally {
      setRefreshing(false);
    }
  };

  const clusterCtl = useTableControls(data?.byCluster || [], {
    defaultSortKey: 'frontEndBytes',
    defaultSortDir: 'desc',
    sortValues: {
      systemName: (r) => r.systemName || r.systemId || '',
      frontEndBytes: (r) => r.frontEndBytes || 0,
      physicalBytes: (r) => r.physicalBytes || 0,
      capacityBytes: (r) => r.capacityBytes || 0,
      usagePercent: (r) => r.usagePercent ?? -1,
      dataReduction: (r) => r.dataReduction ?? -1,
    },
  });

  const exportCsv = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const tb = (b) => +toTb(b).toFixed(2);
      const q = (s) => JSON.stringify(String(s ?? ''));
      const rows = [];

      rows.push(`Cohesity Licensing Report,Generated ${new Date().toISOString()},Data captured ${data.capturedAt || 'unknown'}`);
      rows.push('');

      rows.push('LICENSE SUMMARY');
      rows.push('License,Consumed TB,Entitled TB,Utilization %,Usage Basis' + (data.expiry ? ',Renewal Date' : ''));
      for (const t of data.types) {
        const pct = t.entitledTb > 0 ? ((toTb(t.consumedBytes) / t.entitledTb) * 100).toFixed(1) : '';
        rows.push([q(t.label), tb(t.consumedBytes), t.entitledTb || '', pct, q(BASIS_CSV[t.basis] || t.basis)].concat(data.expiry ? [data.expiry] : []).join(','));
      }
      rows.push('');

      const systems = (data.breakdown?.bySystem || []).filter((s) => Object.values(s.categories).some((c) => c.physicalBytes > 0));
      rows.push('CONSUMPTION BREAKDOWN BY SYSTEM (physical TB)');
      rows.push('System,' + BREAKDOWN_META.map((m) => q(m.label)).join(',') + ',Total');
      for (const s of systems) {
        const vals = BREAKDOWN_META.map((m) => tb(s.categories[m.key]?.physicalBytes));
        const total = vals.reduce((a, b) => a + b, 0);
        rows.push([q(s.systemName || s.systemId), ...vals, +total.toFixed(2)].join(','));
      }
      rows.push('');

      rows.push('SYSTEM CAPACITY');
      rows.push('System,Front-End TB,Physical Stored TB,Raw Capacity TB,Used %,Data Reduction');
      for (const r of data.byCluster) {
        rows.push([q(r.systemName || r.systemId), tb(r.frontEndBytes), tb(r.physicalBytes), tb(r.capacityBytes), r.usagePercent != null ? r.usagePercent.toFixed(1) : '', r.dataReduction != null ? r.dataReduction.toFixed(2) : ''].join(','));
      }
      rows.push('');

      // Per-view detail for every system that has views (fetched per system).
      const withViews = systems.filter((s) => (s.categories.views?.physicalBytes || 0) + (s.categories.viewsReplicated?.physicalBytes || 0) > 0);
      const detailResults = await Promise.allSettled(
        withViews.map((s) => apiFetch(`/cohesity/licensing/views/${s.systemId}`).then((views) => ({ system: s, views })))
      );
      rows.push('VIEW DETAIL');
      rows.push('System,View,License Attribution,Created,Physical TB,Data Written TB,Logical TB');
      for (const res of detailResults) {
        if (res.status !== 'fulfilled') continue;
        for (const v of res.value.views.filter((v) => v.physicalBytes > 0)) {
          rows.push([q(res.value.system.systemName || res.value.system.systemId), q(v.viewName), v.isReadOnly ? 'Replicated in (Replica)' : 'Receiving data (SmartFiles)', v.createdMs ? new Date(v.createdMs).toISOString().slice(0, 10) : '', tb(v.physicalBytes), tb(v.dataWrittenBytes), tb(v.logicalBytes)].join(','));
        }
      }

      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      downloadBlob(blob, `cohesity-licensing-report-${new Date().toISOString().slice(0, 10)}.csv`);
      toast({ type: 'success', title: 'CSV exported', message: 'Licensing report downloaded.' });
    } catch {
      toast({ type: 'error', title: 'Export failed', message: 'Could not build the licensing export.' });
    } finally {
      setExporting(false);
    }
  };

  const hasTypes = (data?.types?.some((t) => t.consumedBytes > 0)) || false;
  const hasSystems = (data?.byCluster?.length || 0) > 0;
  const edition = data?.edition;
  const expiry = data?.expiry;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={BadgeCheck}
        title="Licensing"
        description={data?.capturedAt ? `Front-end capacity (FETB) by license type · updated ${timeAgo(data.capturedAt)}` : 'Cohesity capacity licensing — consumed vs entitled front-end TB by license type'}
      >
        {(edition || expiry) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {edition && <Badge tone="brand">{edition}</Badge>}
            {expiry && (
              <Badge tone={new Date(expiry) < new Date() ? 'crit' : (new Date(expiry) - Date.now()) < 90 * 864e5 ? 'warn' : 'neutral'}>
                <CalendarClock size={11} /> Expires {expiry}
              </Badge>
            )}
          </div>
        )}
        <button onClick={() => setExplorer((e) => !e)} disabled={loading || !data} className="co-btn-ghost"
          style={explorer ? { background: 'rgba(96,165,250,0.1)', borderColor: 'rgba(96,165,250,0.4)', color: 'var(--co-info)', fontWeight: 600 } : undefined}>
          <FlaskConical size={13} /> {explorer ? 'Exit Explorer' : 'Explorer'}
        </button>
        <RefreshButton onClick={refresh} refreshing={refreshing} />
        <button onClick={exportCsv} disabled={loading || exporting || !data} className="co-btn-ghost">
          <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        <button onClick={() => window.print()} disabled={loading} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)', fontWeight: 600 }}>
          <Printer size={13} /> Print / PDF
        </button>
      </PageHeader>

      {loading ? (
        <div className="panel"><LoadingPanel label="Loading licensing data…" height={280} /></div>
      ) : (!hasTypes && !hasSystems) ? (
        <Panel>
          <EmptyState
            icon={<BadgeCheck size={28} />}
            title="No licensing data yet"
            message={<>Consumption is pulled from Helios hourly. Ensure <code style={{ color: 'var(--co-brand)' }}>HELIOS_API_KEY</code> is configured, then use Refresh to pull now.</>}
          />
        </Panel>
      ) : (
        <>
          {explorer && (
            <div className="panel" style={{ padding: 12, borderColor: 'rgba(96,165,250,0.4)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <FlaskConical size={16} style={{ color: 'var(--co-info)', flexShrink: 0 }} />
                <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', flex: 1, minWidth: 240, lineHeight: 1.375, margin: 0 }}>
                  <span style={{ color: 'var(--co-ink)', fontWeight: 600 }}>What-if mode.</span> Uncheck views, systems, or breakdown
                  categories to remove them from the simulated totals — e.g. duplicate data you shouldn't be charged for.
                  License-card impact is an estimate: excluded on-disk bytes are subtracted from Cohesity's meter figure.
                  Nothing is changed on the clusters.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {sim && sim.excludedCount > 0 ? (
                    <>
                      <Badge tone="info">{sim.excludedCount} excluded · −{fmtTb(sim.excludedBytes)}</Badge>
                      {data.types.filter((t) => (sim.excludedByType[t.key] || 0) > 0).map((t) => (
                        <Badge key={t.key} tone="neutral">{t.label} −{fmtTb(sim.excludedByType[t.key])}</Badge>
                      ))}
                    </>
                  ) : (
                    <Badge tone="neutral">Nothing excluded yet</Badge>
                  )}
                  <button onClick={resetExplorer} disabled={!sim || sim.excludedCount === 0} className="co-btn-ghost">
                    <RotateCcwLocal size={11} /> Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', lineHeight: 1.375 }}>
            These cards read Cohesity's own license meter — the billing figure. Cohesity re-baselines
            it on its own schedule, typically 24–48 h behind changes (longer after deleting DataLocked
            views, whose data is held until retention expires).
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {(sim?.types || data.types).map((t) => <LicenseTypeCard key={t.key} type={t} />)}
          </div>

          <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', lineHeight: 1.375, marginTop: -4 }}>
            The consumption breakdown below is physical on-disk usage and follows this dashboard's
            hourly refresh, so it reflects additions and deletions much sooner than the meter cards above.
          </p>

          <BreakdownSection breakdown={data.breakdown} sim={sim} explorer={explorer}
            excludedSystems={excludedSystems} excludedCategories={excludedCategories}
            onToggleSystem={toggleSystem} onToggleCategory={toggleCategory} />

          <ViewDetailPanel systems={data.breakdown?.bySystem || []} explorer={explorer}
            excludedViews={excludedViews} onToggleView={toggleView} />

          <Panel title="Consumption by System" icon={Database}
            actions={<span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{data.totals.systems} systems · {fmtTb(data.totals.consumedFrontEndBytes)} front-end · {fmtTb(data.totals.physicalBytes)} stored</span>}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)', textAlign: 'left' }}>
                    <SortTh k="systemName" label="System" ctl={clusterCtl} align="left" />
                    <SortTh k="frontEndBytes" label="Front-End (FETB)" ctl={clusterCtl} align="right" />
                    <SortTh k="physicalBytes" label="Physical Stored" ctl={clusterCtl} align="right" />
                    <SortTh k="capacityBytes" label="Raw Capacity" ctl={clusterCtl} align="right" />
                    <SortTh k="usagePercent" label="% Used" ctl={clusterCtl} align="right" />
                    <SortTh k="dataReduction" label="Data Reduction" ctl={clusterCtl} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {clusterCtl.rows.map((r, i) => {
                    const pctUsed = r.usagePercent;
                    const tone = pctUsed == null ? 'neutral' : pctUsed >= 86 ? 'crit' : pctUsed >= 70 ? 'warn' : 'ok';
                    return (
                      <tr key={r.systemId || i} style={{ borderBottom: '1px solid rgba(31,43,55,.6)' }}>
                        <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500 }}>{r.systemName || r.systemId || '—'}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.frontEndBytes)}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.physicalBytes)}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtTb(r.capacityBytes)}</td>
                        <td style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}><Badge tone={tone} className="tnum">{pctUsed != null ? pctUsed.toFixed(1) + '%' : '—'}</Badge></td>
                        <td className="tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{r.dataReduction != null ? r.dataReduction.toFixed(2) + 'x' : '—'}</td>
                      </tr>
                    );
                  })}
                  {data.byCluster.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--co-ink-faint)' }}>No per-system data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <SettingsIcon size={11} /> Set per-type entitlements in <window.ReactRouterDOM.Link to="/cohesity/settings" style={{ color: 'var(--co-brand)' }}>Settings</window.ReactRouterDOM.Link> to see utilization against each license.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * EntitlementTab — named export. Ported from frontend/src/pages/
 * SettingsPage.jsx's "Licensing Entitlement" tab body. Reads/writes the
 * CORE settings endpoint (GET/PUT /api/settings — not /api/cohesity/*),
 * same as the built-in page and the same core endpoint components.jsx's
 * useAiEnabled() already calls (/settings/ai-config). settings.jsx's TABS
 * array has a commented `entitlement` placeholder for this — the
 * orchestrator wires it in.
 * ────────────────────────────────────────────────────────────────────── */
export function EntitlementTab() {
  const [dpTib, setDpTib] = React.useState('');
  const [replicaTib, setReplicaTib] = React.useState('');
  const [smartFilesTib, setSmartFilesTib] = React.useState('');
  const [licenseExpiry, setLicenseExpiry] = React.useState('');
  const [licenseEdition, setLicenseEdition] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    apiFetch('/settings').then((d) => {
      const e = d.entitled || {};
      setDpTib(e.dataProtect ? String(e.dataProtect) : '');
      setReplicaTib(e.replica ? String(e.replica) : '');
      setSmartFilesTib(e.smartFiles ? String(e.smartFiles) : '');
      setLicenseExpiry(d.licenseExpiry || '');
      setLicenseEdition(d.licenseEdition || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: {
          licenseEntitledDataProtectTb: Number(dpTib) || 0,
          licenseEntitledReplicaTb: Number(replicaTib) || 0,
          licenseEntitledSmartFilesTb: Number(smartFilesTib) || 0,
          licenseExpiry,
          licenseEdition,
        },
      });
      toast({ type: 'success', title: 'Settings saved', message: 'Cohesity licensing entitlement updated.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}>
          <BadgeCheck size={14} style={{ color: 'var(--co-brand)' }} />
        </div>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Licensing Entitlement</p>
          <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: '2px 0 0' }}>
            Your purchased capacity (decimal TB, as on the Cohesity license report) per license type. Consumed usage is
            pulled live from Helios; these are the baselines the Licensing page compares each type against.
          </p>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--co-ink-muted)', fontSize: 13, marginTop: 16 }}>Loading…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 16 }}>
          <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 16 }}>
            <div>
              <label htmlFor="co-dp-tib" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--co-ink)', marginBottom: 4 }}>DataProtect (TB)</label>
              <input id="co-dp-tib" type="number" min="0" step="1" value={dpTib} onChange={(e) => setDpTib(e.target.value)} placeholder="e.g. 15000" className="co-input" />
              <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', marginTop: 4 }}>All backed-up workloads (VMs, DBs, physical, M365, NAS backups).</p>
            </div>
            <div>
              <label htmlFor="co-replica-tib" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--co-ink)', marginBottom: 4 }}>Replica (TB)</label>
              <input id="co-replica-tib" type="number" min="0" step="1" value={replicaTib} onChange={(e) => setReplicaTib(e.target.value)} placeholder="e.g. 5000" className="co-input" />
              <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', marginTop: 4 }}>Replicated data on Cohesity clusters.</p>
            </div>
            <div>
              <label htmlFor="co-sf-tib" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--co-ink)', marginBottom: 4 }}>SmartFiles (TB)</label>
              <input id="co-sf-tib" type="number" min="0" step="1" value={smartFilesTib} onChange={(e) => setSmartFilesTib(e.target.value)} placeholder="e.g. 8000" className="co-input" />
              <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', marginTop: 4 }}>Data in Cohesity Views / NAS shares.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 16 }}>
            <div>
              <label htmlFor="co-license-edition" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--co-ink)', marginBottom: 4 }}>Edition <span style={{ color: 'var(--co-ink-faint)', fontWeight: 400 }}>(optional)</span></label>
              <input id="co-license-edition" type="text" value={licenseEdition} onChange={(e) => setLicenseEdition(e.target.value)} placeholder="e.g. DataProtect Enterprise" className="co-input" />
            </div>
            <div>
              <label htmlFor="co-license-expiry" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--co-ink)', marginBottom: 4 }}>Expiry <span style={{ color: 'var(--co-ink-faint)', fontWeight: 400 }}>(optional)</span></label>
              <input id="co-license-expiry" type="date" value={licenseExpiry} onChange={(e) => setLicenseExpiry(e.target.value)} className="co-input" />
            </div>
          </div>

          <div>
            <button onClick={save} disabled={saving} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}>
              <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
