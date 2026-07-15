import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, RefreshCw, Database, ShieldCheck, ArrowLeftRight, FolderTree, FolderLock, Layers, CalendarClock, Settings as SettingsIcon, ChevronUp, ChevronDown, ChevronsUpDown, Download, Printer, FlaskConical, RotateCcw } from 'lucide-react';
import { Chart as ChartJS, ArcElement, CategoryScale, LinearScale, BarElement, Tooltip as ChartTooltip, Legend } from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import client from '../api/client';
import { PageHeader, Panel, Badge, StatCard, LoadingPanel } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

ChartJS.register(ArcElement, CategoryScale, LinearScale, BarElement, ChartTooltip, Legend);

// Cohesity licenses in decimal TB, so all capacities render in TB.
const TB = 1e12;
const toTb = (b) => (b || 0) / TB;

function fmtTb(b) {
  const t = toTb(b);
  if (t >= 100) return t.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' TB';
  return t.toFixed(1) + ' TB';
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

// ── Table sorting ─────────────────────────────────────────────
function useTableSort(defaultKey, defaultDir = 'desc') {
  const [sort, setSort] = useState({ key: defaultKey, dir: defaultDir });
  const toggle = (key) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  return [sort, toggle];
}

function sortRows(rows, sort, accessors) {
  const get = accessors[sort.key];
  if (!get) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return dir * String(va ?? '').localeCompare(String(vb ?? ''));
    }
    return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
}

function SortTh({ label, colKey, sort, onSort, align = 'right', last = false, children }) {
  const active = sort.key === colKey;
  const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th className={`py-2 ${last ? '' : 'pr-4'} font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => onSort(colKey)}
        className={`inline-flex items-center gap-1 cursor-pointer transition-colors ${active ? 'text-brand' : 'hover:text-ink'}`}
      >
        {children || label}
        <Icon size={11} className={active ? 'flex-shrink-0' : 'flex-shrink-0 opacity-40'} />
      </button>
    </th>
  );
}

const TYPE_META = {
  dataProtect: { icon: ShieldCheck, blurb: 'All backed-up workloads (VMware, databases, physical, M365, NAS backups). Usage from Cohesity’s license meter.' },
  replica: { icon: ArrowLeftRight, blurb: 'Data replicated in from other Cohesity clusters. Usage from Cohesity’s license meter (dataProtectReplica).' },
  smartFiles: { icon: FolderTree, blurb: 'Views / NAS shares served to clients. Usage from Cohesity’s license meter (externalViews).' },
};

const BASIS_LABEL = {
  cohesityMeter: '',
  usedPhysical: ' (used at targets)',
  frontEnd: ' (front-end)',
};

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
const CATEGORY_LICENSE = {
  backup: 'dataProtect',
  replication: 'replica',
  viewsReplicated: 'replica',
  views: 'smartFiles',
  viewBackups: 'dataProtect',
};

function TypeGauge({ pct }) {
  const clamped = Math.max(0, Math.min(pct, 100));
  const color = pct >= 90 ? '#EF4444' : pct >= 75 ? '#F59E0B' : '#6CB33F';
  const data = {
    labels: ['Consumed', 'Remaining'],
    datasets: [{ data: [clamped, 100 - clamped], backgroundColor: [color, 'rgba(255,255,255,0.08)'], borderWidth: 0, circumference: 360 }],
  };
  const options = { responsive: true, maintainAspectRatio: false, cutout: '74%', animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } };
  return (
    <div className="relative h-28 w-28 flex-shrink-0">
      <Doughnut data={data} options={options} />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold tnum" style={{ color }}>{pct.toFixed(0)}%</span>
        <span className={`text-[9px] font-semibold uppercase tracking-wide ${pct > 100 ? 'text-status-crit' : 'text-ink-faint'}`}>{pct > 100 ? 'Over' : 'Used'}</span>
      </div>
    </div>
  );
}

function LicenseTypeCard({ type }) {
  const Icon = TYPE_META[type.key]?.icon || BadgeCheck;
  const simActive = type.simConsumedBytes != null && (type.simExcludedBytes || 0) > 0;
  const effectiveBytes = simActive ? type.simConsumedBytes : type.consumedBytes;
  const consumedTb = toTb(effectiveBytes);
  const entitled = type.entitledTb || 0;
  const pct = entitled > 0 ? (consumedTb / entitled) * 100 : null;
  const headroom = entitled > 0 ? entitled - consumedTb : null;

  return (
    <div className={`panel p-4 flex flex-col gap-3 ${simActive ? 'border-status-info/40' : ''}`}>
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 border border-brand/20 flex-shrink-0">
          <Icon size={18} className="text-brand" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink flex items-center gap-2">
            {type.label}
            {simActive && <Badge tone="info">Simulated</Badge>}
          </p>
          <p className="text-[11px] text-ink-muted leading-snug">{TYPE_META[type.key]?.blurb}</p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {pct != null ? (
          <TypeGauge pct={pct} />
        ) : (
          <div className="h-28 w-28 flex-shrink-0 flex flex-col items-center justify-center gap-1 rounded-full border border-dashed border-cohesity-border text-center px-3">
            <span className="text-[10px] text-ink-muted leading-tight">Set entitlement in Settings</span>
          </div>
        )}
        <div className="flex-1 flex flex-col gap-1.5 text-sm min-w-0">
          {simActive && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-muted text-xs">Actual (billed)</span>
              <span className="text-ink-faint tnum line-through">{fmtTb(type.consumedBytes)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-muted text-xs">{simActive ? 'Simulated' : `Consumed${BASIS_LABEL[type.basis] ?? ''}`}</span>
            <span className="text-ink font-semibold tnum">{fmtTb(effectiveBytes)}</span>
          </div>
          {simActive && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-muted text-xs">Excluded</span>
              <span className="text-status-info font-semibold tnum">−{fmtTb(type.simExcludedBytes)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-muted text-xs">Entitled</span>
            <span className="text-ink font-semibold tnum">{entitled > 0 ? fmtTb(entitled * TB) : '— not set'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-muted text-xs">Headroom</span>
            <span className={`font-semibold tnum ${headroom == null ? 'text-ink-faint' : headroom < 0 ? 'text-status-crit' : 'text-ink'}`}>
              {headroom == null ? '—' : (headroom < 0 ? '-' : '') + fmtTb(Math.abs(headroom) * TB)}
            </span>
          </div>
        </div>
      </div>
      {type.key === 'smartFiles' && (
        <p className="text-[11px] text-ink-faint leading-snug -mt-1">
          Per-view inventory (backup, replication, DataLock) is on the{' '}
          <Link to="/views" className="text-brand hover:underline">Views page</Link> — its writable-views consumed
          figure matches the Views (SmartFiles) column of the breakdown below on a physical on-disk basis.
        </p>
      )}
    </div>
  );
}

function ViewDetailPanel({ systems, explorer, excludedViews, onToggleView }) {
  const withViews = systems.filter(s =>
    (s.categories.views?.physicalBytes || 0) + (s.categories.viewsReplicated?.physicalBytes || 0) > 0
  );
  const [systemId, setSystemId] = useState(withViews[0]?.systemId || '');
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('');
  const [sort, toggleSort] = useTableSort('physicalBytes');

  useEffect(() => {
    if (!systemId) return;
    setRows(null);
    client.get(`/licensing/views/${systemId}`)
      .then(r => setRows(r.data))
      .catch(() => setRows([]));
  }, [systemId]);

  if (withViews.length === 0) return null;
  const VIEW_COLS = {
    viewName: r => r.viewName,
    attribution: r => (r.isReadOnly ? 1 : 0),
    createdMs: r => r.createdMs || 0,
    physicalBytes: r => r.physicalBytes || 0,
    dataWrittenBytes: r => r.dataWrittenBytes || 0,
    logicalBytes: r => r.logicalBytes || 0,
  };
  const kw = filter.trim().toLowerCase();
  const shown = sortRows(
    (rows || []).filter(r => r.physicalBytes > 0 && (!kw || r.viewName.toLowerCase().includes(kw))),
    sort, VIEW_COLS
  );

  // Select/deselect-all applies to the rows visible in THIS card (current
  // system + keyword filter), so a keyword can scope a bulk include/exclude.
  const allShownIncluded = shown.length > 0 && shown.every(r => !excludedViews.has(`${systemId}|${r.viewName}`));
  const bulkToggleShown = () => {
    for (const r of shown) {
      const isExcluded = excludedViews.has(`${systemId}|${r.viewName}`);
      if (allShownIncluded ? !isExcluded : isExcluded) onToggleView(systemId, r);
    }
  };

  return (
    <Panel title="View Detail — Replicated vs Receiving Backups" icon={FolderTree}
      actions={
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter view names…"
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink placeholder-ink-faint focus:border-brand/60 outline-none w-40"
          />
          <select value={systemId} onChange={e => setSystemId(e.target.value)}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
            {withViews.map(s => <option key={s.systemId} value={s.systemId}>{s.systemName || s.systemId}</option>)}
          </select>
        </div>
      }>
      {rows == null ? (
        <LoadingPanel label="Loading views…" height={120} />
      ) : shown.length === 0 ? (
        <p className="text-xs text-ink-faint py-4 text-center">
          {kw ? <>No views matching "{filter.trim()}" on this system.</> : 'No views with data on this system.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-ink-muted">
            <thead>
              <tr className="text-ink-faint border-b border-cohesity-border text-left">
                {explorer && (
                  <th className="py-2 pr-3 font-semibold" title="Unchecked views are removed from the simulated totals">
                    <span className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={allShownIncluded}
                        onChange={bulkToggleShown}
                        title={allShownIncluded ? 'Deselect all views shown below' : 'Select all views shown below'}
                        className="accent-brand cursor-pointer"
                      />
                      Incl.
                    </span>
                  </th>
                )}
                <SortTh label="View" colKey="viewName" sort={sort} onSort={toggleSort} align="left" />
                <SortTh label="License Attribution" colKey="attribution" sort={sort} onSort={toggleSort} align="left" />
                <SortTh label="Created" colKey="createdMs" sort={sort} onSort={toggleSort} align="left" />
                <SortTh label="Physical" colKey="physicalBytes" sort={sort} onSort={toggleSort} />
                <SortTh label="Data Written" colKey="dataWrittenBytes" sort={sort} onSort={toggleSort} />
                <SortTh label="Logical" colKey="logicalBytes" sort={sort} onSort={toggleSort} last />
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const excluded = explorer && excludedViews.has(`${systemId}|${r.viewName}`);
                return (
                <tr key={r.viewName} className={`border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors ${excluded ? 'opacity-50' : ''}`}>
                  {explorer && (
                    <td className="py-2 pr-3">
                      <input type="checkbox" checked={!excluded} onChange={() => onToggleView(systemId, r)}
                        className="accent-brand cursor-pointer" />
                    </td>
                  )}
                  <td className={`py-2 pr-4 text-ink font-medium ${excluded ? 'line-through' : ''}`}>{r.viewName}</td>
                  <td className="py-2 pr-4">
                    {r.isReadOnly
                      ? <Badge tone="info">Replicated in · Replica</Badge>
                      : <Badge tone="warn">Receiving data · SmartFiles</Badge>}
                  </td>
                  <td className="py-2 pr-4 tnum">{r.createdMs ? new Date(r.createdMs).toISOString().slice(0, 10) : '—'}</td>
                  <td className="py-2 pr-4 text-right tnum">{fmtTb(r.physicalBytes)}</td>
                  <td className="py-2 pr-4 text-right tnum">{fmtTb(r.dataWrittenBytes)}</td>
                  <td className="py-2 text-right tnum">{fmtTb(r.logicalBytes)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-ink-faint mt-3">
        Read-only views were replicated in from another cluster and count toward Replica licensing. Writable views are
        actively receiving data (NAS shares or backup-into-view targets) and count toward SmartFiles. The full estate-wide
        inventory, including protection and DataLock status, is on the{' '}
        <Link to="/views" className="text-brand hover:underline">Views page</Link>.
      </p>
    </Panel>
  );
}

function BreakdownSection({ breakdown, sim, explorer, excludedSystems, excludedCategories, onToggleSystem, onToggleCategory }) {
  const [sort, toggleSort] = useTableSort('total');
  const eff = sim?.breakdown || breakdown;
  const totals = eff?.totals || {};
  const origMap = new Map((breakdown?.bySystem || []).map(s => [s.systemId, s]));
  const systems = (eff?.bySystem || []).filter(s => {
    const o = origMap.get(s.systemId) || s;
    return Object.values(o.categories).some(c => c.physicalBytes > 0);
  });
  if (systems.length === 0) return null;

  const sysTotal = (s) => BREAKDOWN_META.reduce((acc, m) => acc + (s.categories[m.key]?.physicalBytes || 0), 0);
  const BD_COLS = {
    system: s => s.systemName || s.systemId,
    total: sysTotal,
    ...Object.fromEntries(BREAKDOWN_META.map(m => [m.key, s => s.categories[m.key]?.physicalBytes || 0])),
  };
  const tableRows = sortRows(systems, sort, BD_COLS);

  const top = systems.slice(0, 12);
  const chartData = {
    labels: top.map(s => s.systemName || s.systemId),
    datasets: BREAKDOWN_META.map(m => ({
      label: m.label,
      data: top.map(s => toTb(s.categories[m.key]?.physicalBytes)),
      backgroundColor: m.color,
      stack: 'consumed',
      borderWidth: 0,
    })),
  };
  const chartOptions = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: '#E5E5E5', font: { size: 11 } } },
      tooltip: {
        backgroundColor: '#2C2C2C', borderColor: '#3D3D3D', borderWidth: 1,
        titleColor: '#E5E5E5', bodyColor: '#9ca3af',
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.x.toFixed(1)} TB` },
      },
    },
    scales: {
      x: { stacked: true, ticks: { color: '#E5E5E5', font: { size: 10 }, callback: (v) => v + ' TB' }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { stacked: true, ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { display: false } },
    },
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {BREAKDOWN_META.map(m => {
          const t = totals[m.key] || {};
          const noun = m.key === 'views' || m.key === 'viewsReplicated' ? 'views' : 'jobs';
          const catExcluded = explorer && excludedCategories.has(m.key);
          return (
            <div key={m.key} className={`relative ${catExcluded ? 'opacity-50' : ''}`}>
              {explorer && (
                <input type="checkbox" checked={!catExcluded} onChange={() => onToggleCategory(m.key)}
                  title={`Include all ${m.label} in the simulation`}
                  className="absolute top-2.5 right-2.5 z-10 accent-brand cursor-pointer" />
              )}
              <StatCard icon={m.icon} label={m.label} tone="default"
                value={fmtTb(t.physicalBytes)}
                sub={`${t.consumers || 0} ${noun} · ${fmtTb(t.logicalBytes)} logical`} />
            </div>
          );
        })}
      </div>

      <Panel title="Backup vs Replication vs Views — by System" icon={Layers}
        actions={<span className="text-[11px] text-ink-faint">physical (on-disk) consumption · top {top.length} of {systems.length} systems</span>}>
        <div style={{ height: Math.max(240, top.length * 34) }}>
          <Bar data={chartData} options={chartOptions} />
        </div>

        <div className="overflow-x-auto mt-4">
          <table className="w-full text-xs text-ink-muted">
            <thead>
              <tr className="text-ink-faint border-b border-cohesity-border text-left">
                {explorer && <th className="py-2 pr-3 font-semibold" title="Unchecked systems are removed from the simulated totals">Incl.</th>}
                <SortTh label="System" colKey="system" sort={sort} onSort={toggleSort} align="left" />
                {BREAKDOWN_META.map(m => (
                  <SortTh key={m.key} colKey={m.key} sort={sort} onSort={toggleSort}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: m.color }} />
                      {m.label}
                    </span>
                  </SortTh>
                ))}
                <SortTh label="Total" colKey="total" sort={sort} onSort={toggleSort} last />
              </tr>
            </thead>
            <tbody>
              {tableRows.map(s => {
                const sysExcluded = explorer && excludedSystems.has(s.systemId);
                const display = sysExcluded ? (origMap.get(s.systemId) || s) : s;
                const total = sysTotal(display);
                return (
                  <tr key={s.systemId} className={`border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors ${sysExcluded ? 'opacity-50' : ''}`}>
                    {explorer && (
                      <td className="py-2 pr-3">
                        <input type="checkbox" checked={!sysExcluded} onChange={() => onToggleSystem(s.systemId)}
                          className="accent-brand cursor-pointer" />
                      </td>
                    )}
                    <td className={`py-2 pr-4 text-ink font-medium ${sysExcluded ? 'line-through' : ''}`}>{s.systemName || s.systemId}</td>
                    {BREAKDOWN_META.map(m => {
                      const catExcluded = explorer && excludedCategories.has(m.key);
                      const source = catExcluded ? (origMap.get(s.systemId) || s) : display;
                      const v = source.categories[m.key]?.physicalBytes || 0;
                      const struck = sysExcluded || catExcluded;
                      return <td key={m.key} className={`py-2 pr-4 text-right tnum ${v === 0 ? 'text-ink-faint' : ''} ${struck && v > 0 ? 'line-through text-ink-faint' : ''}`}>{v > 0 ? fmtTb(v) : '—'}</td>;
                    })}
                    <td className={`py-2 text-right tnum text-ink font-semibold ${sysExcluded ? 'line-through text-ink-faint' : ''}`}>{fmtTb(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-ink-faint mt-3">
          Replicated data is measured on the cluster it lands on (DR targets). Views are split by provenance:
          read-only views were replicated in and count toward Replica licensing; writable views hold data written
          directly to that cluster and count as SmartFiles. Logical (front-end) sizes are in the summary cards above.
        </p>
      </Panel>
    </>
  );
}

const CLUSTER_COLS = {
  systemName: r => r.systemName || r.systemId || '',
  frontEndBytes: r => r.frontEndBytes || 0,
  physicalBytes: r => r.physicalBytes || 0,
  capacityBytes: r => r.capacityBytes || 0,
  usagePercent: r => r.usagePercent ?? null,
  dataReduction: r => r.dataReduction ?? null,
};

const BASIS_CSV = { cohesityMeter: 'Cohesity license meter', usedPhysical: 'Used at targets', frontEnd: 'Front-end' };

export default function LicensingPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clusterSort, toggleClusterSort] = useTableSort('frontEndBytes');
  const { toast } = useToast();

  // ── What-if explorer ────────────────────────────────────────
  const [explorer, setExplorer] = useState(false);
  const [excludedSystems, setExcludedSystems] = useState(() => new Set());
  const [excludedCategories, setExcludedCategories] = useState(() => new Set());
  // key `${systemId}|${viewName}` → view row snapshot (bytes + attribution)
  const [excludedViews, setExcludedViews] = useState(() => new Map());

  const toggleSystem = (id) => setExcludedSystems(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleCategory = (key) => setExcludedCategories(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const toggleView = (systemId, row) => setExcludedViews(prev => {
    const next = new Map(prev);
    const key = `${systemId}|${row.viewName}`;
    if (next.has(key)) next.delete(key);
    else next.set(key, {
      systemId, viewName: row.viewName, isReadOnly: !!row.isReadOnly,
      physicalBytes: row.physicalBytes || 0, logicalBytes: row.logicalBytes || 0,
    });
    return next;
  });
  const resetExplorer = () => {
    setExcludedSystems(new Set());
    setExcludedCategories(new Set());
    setExcludedViews(new Map());
  };

  // Simulated breakdown + license figures with the excluded items removed.
  // License-card impact is an estimate: excluded on-disk bytes are subtracted
  // from the meter figure, which uses Cohesity's own accounting.
  const sim = useMemo(() => {
    if (!explorer || !data?.breakdown) return null;
    const bySystem = (data.breakdown.bySystem || []).map(s => {
      const categories = {};
      for (const [k, c] of Object.entries(s.categories)) {
        const zeroed = excludedSystems.has(s.systemId) || excludedCategories.has(k);
        categories[k] = zeroed
          ? { ...c, physicalBytes: 0, logicalBytes: 0, consumers: 0 }
          : { ...c };
      }
      return { ...s, categories };
    });
    for (const v of excludedViews.values()) {
      const catKey = v.isReadOnly ? 'viewsReplicated' : 'views';
      if (excludedSystems.has(v.systemId) || excludedCategories.has(catKey)) continue;
      const cat = bySystem.find(s => s.systemId === v.systemId)?.categories[catKey];
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
    const types = data.types.map(t => ({
      ...t,
      simConsumedBytes: Math.max(0, t.consumedBytes - excludedByType[t.key]),
      simExcludedBytes: excludedByType[t.key],
    }));
    return {
      breakdown: { ...data.breakdown, totals, bySystem },
      types,
      excludedByType,
      excludedCount: excludedSystems.size + excludedCategories.size + excludedViews.size,
      excludedBytes: Object.values(excludedByType).reduce((a, b) => a + b, 0),
    };
  }, [explorer, data, excludedSystems, excludedCategories, excludedViews]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/licensing');
      setData(data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      // The per-type pull hits a heavier Helios report; allow well beyond the default timeout.
      // Body must be {} not null: axios serializes null to a literal "null" body,
      // which Express's strict JSON parser rejects with a 400.
      const { data } = await client.post('/licensing/refresh', {}, { timeout: 200000 });
      setData(data);
      const failed = data.refreshFailedSources || [];
      if (failed.length > 0) {
        toast({ type: 'warning', title: 'Partially refreshed', message: `Helios was slow for: ${failed.join(', ')}. Previous figures kept for those; everything else is fresh.` });
      } else {
        toast({ type: 'success', title: 'Licensing refreshed', message: 'Pulled the latest consumption from Helios.' });
      }
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not refresh licensing data.';
      toast({ type: 'error', title: 'Refresh failed', message: msg });
    } finally {
      setRefreshing(false);
    }
  };

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
        rows.push([q(t.label), tb(t.consumedBytes), t.entitledTb || '', pct, q(BASIS_CSV[t.basis] || t.basis)]
          .concat(data.expiry ? [data.expiry] : []).join(','));
      }
      rows.push('');

      const systems = (data.breakdown?.bySystem || []).filter(s =>
        Object.values(s.categories).some(c => c.physicalBytes > 0)
      );
      rows.push('CONSUMPTION BREAKDOWN BY SYSTEM (physical TB)');
      rows.push('System,' + BREAKDOWN_META.map(m => q(m.label)).join(',') + ',Total');
      for (const s of systems) {
        const vals = BREAKDOWN_META.map(m => tb(s.categories[m.key]?.physicalBytes));
        const total = vals.reduce((a, b) => a + b, 0);
        rows.push([q(s.systemName || s.systemId), ...vals, +total.toFixed(2)].join(','));
      }
      rows.push('');

      rows.push('SYSTEM CAPACITY');
      rows.push('System,Front-End TB,Physical Stored TB,Raw Capacity TB,Used %,Data Reduction');
      for (const r of data.byCluster) {
        rows.push([
          q(r.systemName || r.systemId), tb(r.frontEndBytes), tb(r.physicalBytes), tb(r.capacityBytes),
          r.usagePercent != null ? r.usagePercent.toFixed(1) : '',
          r.dataReduction != null ? r.dataReduction.toFixed(2) : '',
        ].join(','));
      }
      rows.push('');

      // Per-view detail for every system that has views (fetched per system).
      const withViews = systems.filter(s =>
        (s.categories.views?.physicalBytes || 0) + (s.categories.viewsReplicated?.physicalBytes || 0) > 0
      );
      const detailResults = await Promise.allSettled(
        withViews.map(s => client.get(`/licensing/views/${s.systemId}`).then(r => ({ system: s, views: r.data })))
      );
      rows.push('VIEW DETAIL');
      rows.push('System,View,License Attribution,Created,Physical TB,Data Written TB,Logical TB');
      for (const res of detailResults) {
        if (res.status !== 'fulfilled') continue;
        for (const v of res.value.views.filter(v => v.physicalBytes > 0)) {
          rows.push([
            q(res.value.system.systemName || res.value.system.systemId), q(v.viewName),
            v.isReadOnly ? 'Replicated in (Replica)' : 'Receiving data (SmartFiles)',
            v.createdMs ? new Date(v.createdMs).toISOString().slice(0, 10) : '',
            tb(v.physicalBytes), tb(v.dataWrittenBytes), tb(v.logicalBytes),
          ].join(','));
        }
      }

      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cohesity-licensing-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ type: 'success', title: 'CSV exported', message: 'Licensing report downloaded.' });
    } catch {
      toast({ type: 'error', title: 'Export failed', message: 'Could not build the licensing export.' });
    } finally {
      setExporting(false);
    }
  };

  const hasTypes = (data?.types?.some(t => t.consumedBytes > 0)) || false;
  const hasSystems = (data?.byCluster?.length || 0) > 0;
  const edition = data?.edition;
  const expiry = data?.expiry;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={BadgeCheck}
        title="Licensing"
        description={data?.capturedAt ? `Front-end capacity (FETB) by license type · updated ${timeAgo(data.capturedAt)}` : 'Cohesity capacity licensing — consumed vs entitled front-end TB by license type'}
      >
        {(edition || expiry) && (
          <div className="flex items-center gap-1.5">
            {edition && <Badge tone="brand">{edition}</Badge>}
            {expiry && (
              <Badge tone={new Date(expiry) < new Date() ? 'crit' : (new Date(expiry) - Date.now()) < 90 * 864e5 ? 'warn' : 'neutral'}>
                <CalendarClock size={11} /> Expires {expiry}
              </Badge>
            )}
          </div>
        )}
        <button onClick={() => setExplorer(e => !e)} disabled={loading || !data}
          className={`text-xs px-3 py-1.5 border rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
            explorer
              ? 'bg-status-info/10 border-status-info/40 text-status-info font-medium'
              : 'border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand'
          }`}>
          <FlaskConical size={13} /> {explorer ? 'Exit Explorer' : 'Explorer'}
        </button>
        <button onClick={refresh} disabled={refreshing}
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button onClick={exportCsv} disabled={loading || exporting || !data}
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
          <Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        <button onClick={() => window.print()} disabled={loading}
          className="text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
          <Printer size={13} /> Print / PDF
        </button>
      </PageHeader>

      {loading ? (
        <div className="panel"><LoadingPanel label="Loading licensing data…" height={280} /></div>
      ) : (!hasTypes && !hasSystems) ? (
        <Panel>
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <BadgeCheck size={28} className="text-ink-faint" />
            <p className="text-sm text-ink">No licensing data yet</p>
            <p className="text-xs text-ink-muted max-w-md">
              Consumption is pulled from Helios hourly. Ensure <code className="text-brand">HELIOS_API_KEY</code> is configured,
              then use <span className="text-ink">Refresh</span> to pull now.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          {explorer && (
            <div className="panel p-3 border-status-info/40">
              <div className="flex flex-wrap items-center gap-3">
                <FlaskConical size={16} className="text-status-info flex-shrink-0" />
                <p className="text-xs text-ink-muted flex-1 min-w-[240px] leading-snug">
                  <span className="text-ink font-semibold">What-if mode.</span> Uncheck views, systems, or breakdown
                  categories to remove them from the simulated totals — e.g. duplicate data you shouldn't be charged for.
                  License-card impact is an estimate: excluded on-disk bytes are subtracted from Cohesity's meter figure.
                  Nothing is changed on the clusters.
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {sim && sim.excludedCount > 0 ? (
                    <>
                      <Badge tone="info">{sim.excludedCount} excluded · −{fmtTb(sim.excludedBytes)}</Badge>
                      {data.types.filter(t => (sim.excludedByType[t.key] || 0) > 0).map(t => (
                        <Badge key={t.key} tone="neutral">{t.label} −{fmtTb(sim.excludedByType[t.key])}</Badge>
                      ))}
                    </>
                  ) : (
                    <Badge tone="neutral">Nothing excluded yet</Badge>
                  )}
                  <button onClick={resetExplorer} disabled={!sim || sim.excludedCount === 0}
                    className="text-xs px-2.5 py-1 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-40">
                    <RotateCcw size={11} /> Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {(sim?.types || data.types).map(t => <LicenseTypeCard key={t.key} type={t} />)}
          </div>

          <p className="text-[11px] text-ink-faint leading-snug -mt-1">
            These cards read Cohesity's own license meter — the billing figure. Cohesity re-baselines
            it on its own schedule, typically 24–48 h behind changes (longer after deleting DataLocked
            views, whose data is held until retention expires). The consumption breakdown below is
            physical on-disk usage and follows this dashboard's hourly refresh, so it reflects
            additions and deletions much sooner.
          </p>

          <BreakdownSection breakdown={data.breakdown} sim={sim} explorer={explorer}
            excludedSystems={excludedSystems} excludedCategories={excludedCategories}
            onToggleSystem={toggleSystem} onToggleCategory={toggleCategory} />

          <ViewDetailPanel systems={data.breakdown?.bySystem || []} explorer={explorer}
            excludedViews={excludedViews} onToggleView={toggleView} />

          <Panel title="Consumption by System" icon={Database}
            actions={<span className="text-[11px] text-ink-faint">{data.totals.systems} systems · {fmtTb(data.totals.consumedFrontEndBytes)} front-end · {fmtTb(data.totals.physicalBytes)} stored</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-ink-muted">
                <thead>
                  <tr className="text-ink-faint border-b border-cohesity-border text-left">
                    <SortTh label="System" colKey="systemName" sort={clusterSort} onSort={toggleClusterSort} align="left" />
                    <SortTh label="Front-End (FETB)" colKey="frontEndBytes" sort={clusterSort} onSort={toggleClusterSort} />
                    <SortTh label="Physical Stored" colKey="physicalBytes" sort={clusterSort} onSort={toggleClusterSort} />
                    <SortTh label="Raw Capacity" colKey="capacityBytes" sort={clusterSort} onSort={toggleClusterSort} />
                    <SortTh label="% Used" colKey="usagePercent" sort={clusterSort} onSort={toggleClusterSort} />
                    <SortTh label="Data Reduction" colKey="dataReduction" sort={clusterSort} onSort={toggleClusterSort} last />
                  </tr>
                </thead>
                <tbody>
                  {sortRows(data.byCluster, clusterSort, CLUSTER_COLS).map((r, i) => {
                    const pctUsed = r.usagePercent;
                    const tone = pctUsed == null ? 'neutral' : pctUsed >= 86 ? 'crit' : pctUsed >= 70 ? 'warn' : 'ok';
                    return (
                      <tr key={r.systemId || i} className="border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                        <td className="py-2 pr-4 text-ink font-medium">{r.systemName || r.systemId || '—'}</td>
                        <td className="py-2 pr-4 text-right tnum">{fmtTb(r.frontEndBytes)}</td>
                        <td className="py-2 pr-4 text-right tnum">{fmtTb(r.physicalBytes)}</td>
                        <td className="py-2 pr-4 text-right tnum">{fmtTb(r.capacityBytes)}</td>
                        <td className="py-2 pr-4 text-right"><Badge tone={tone} className="tnum">{pctUsed != null ? pctUsed.toFixed(1) + '%' : '—'}</Badge></td>
                        <td className="py-2 text-right tnum">{r.dataReduction != null ? r.dataReduction.toFixed(2) + 'x' : '—'}</td>
                      </tr>
                    );
                  })}
                  {data.byCluster.length === 0 && (
                    <tr><td colSpan={6} className="text-center py-6 text-ink-faint">No per-system data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-faint mt-3 flex items-center gap-1">
              <SettingsIcon size={11} /> Set per-type entitlements in <Link to="/settings" className="text-brand hover:underline">Settings</Link> to see utilization against each license.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
