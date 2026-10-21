import { useEffect, useState, useMemo } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { BRAND, DASH, arr, fmtNum, fmtMbps, fmtWhen, fmtShortTime, chartOpts } from './helpers';
import { Modal, chipBtn, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

// 24h and 7d come from the raw history (hours); the rest from the daily rollup (days).
const RANGES = [
  { label: '24h', hours: 24 }, { label: '7d', hours: 168 },
  { label: '30d', days: 30 }, { label: '90d', days: 90 }, { label: '365d', days: 365 },
];

const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// "sessions_util_pct" -> "Sessions util pct"; the unit is shown beside it.
export const metricLabel = (k) => {
  const s = String(k || '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function fmtMetricValue(m) {
  const v = numOrNull(m?.value);
  if (v == null) return DASH;
  const unit = m?.unit || '';
  if (/^bps$/i.test(unit)) return fmtMbps(v / 1e6);
  if (/^kbps$/i.test(unit)) return fmtMbps(v / 1e3);
  const shown = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(+v.toFixed(2));
  if (unit === '%' || m?.kind === 'pct') return `${shown}%`;
  return unit ? `${shown} ${unit}` : shown;
}

// Epoch seconds from LM; tolerate milliseconds.
const epochDate = (e) => {
  const n = numOrNull(e);
  if (n == null) return null;
  return new Date(n > 1e11 ? n : n * 1000);
};

export function MetricHistoryModal({ deviceId, sourceId, hdsId, instanceKey, instanceName, metric, unit, title, onClose }) {
  const [range, setRange] = useState(RANGES[0]);
  const [points, setPoints] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setPoints(null);
    setError(false);
    const params = { deviceId, hdsId, instanceKey, metric };
    if (range.days) params.days = range.days; else params.hours = range.hours;
    if (sourceId) params.sourceId = sourceId;
    client.get('/logicmonitor/metrics/history', { params })
      .then(({ data }) => setPoints(Array.isArray(data) ? data : arr(data?.points)))
      .catch(() => setError(true));
  }, [deviceId, sourceId, hdsId, instanceKey, metric, range]);

  const daily = !!range.days;
  const labels = useMemo(() => arr(points).map((p) => (p.t ? String(p.t).slice(5) : fmtShortTime(epochDate(p.epoch)?.toISOString()))), [points]);
  const name = `${metricLabel(metric)}${unit ? ` (${unit})` : ''}`;
  const avgSet = {
    label: daily ? `${name} avg` : name, data: arr(points).map((p) => numOrNull(p.value)),
    borderColor: BRAND, backgroundColor: 'rgba(26,115,232,0.12)', fill: !daily, pointRadius: 0, borderWidth: 2, tension: 0.2,
  };
  // Daily points draw the avg line over a min to max band (min first, max fills down to it).
  const chart = {
    labels,
    datasets: daily ? [
      { label: 'Min', data: arr(points).map((p) => numOrNull(p.min)), borderColor: 'rgba(26,115,232,0.25)', borderWidth: 1, pointRadius: 0, fill: false, tension: 0.2 },
      { label: 'Max', data: arr(points).map((p) => numOrNull(p.max)), borderColor: 'rgba(26,115,232,0.25)', borderWidth: 1, pointRadius: 0, backgroundColor: 'rgba(26,115,232,0.14)', fill: '-1', tension: 0.2 },
      avgSet,
    ] : [avgSet],
  };
  const options = daily ? {
    ...chartOpts,
    plugins: { ...chartOpts.plugins, legend: { ...chartOpts.plugins.legend, labels: { ...chartOpts.plugins.legend.labels, filter: (item) => item.text !== 'Min' && item.text !== 'Max' } } },
  } : chartOpts;
  const stat = useMemo(() => {
    const rows = arr(points);
    if (!rows.length) return null;
    const vals = rows.map((p) => numOrNull(p.value)).filter((v) => v != null);
    const maxes = rows.map((p) => numOrNull(daily ? p.max : p.value)).filter((v) => v != null);
    const last = rows[rows.length - 1];
    return {
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      max: maxes.length ? Math.max(...maxes) : null,
      last: numOrNull(daily ? last.last ?? last.value : last.value),
      samples: daily ? rows.reduce((n, p) => n + (Number(p.samples) || 0), 0) : rows.length,
    };
  }, [points, daily]);
  const f = (v) => (v == null ? DASH : `${+Number(v).toFixed(2)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`);

  return (
    <Modal icon={Activity} title={title || metricLabel(metric)} subtitle={instanceName || instanceKey} onClose={onClose} width="max-w-3xl">
      <div className="flex items-center gap-1 mb-3">
        {RANGES.map((r) => <button key={r.label} onClick={() => setRange(r)} className={chipBtn(range.label === r.label)}>{r.label}</button>)}
      </div>
      {error ? <p className="text-sm text-status-crit py-8 text-center">Failed to load the metric history.</p>
        : points == null ? <LoadingPanel label="Loading history..." height={160} />
          : points.length === 0 ? <p className="text-sm text-ink-muted py-8 text-center">{daily ? 'No daily history stored for this metric yet. It builds from the next metrics poll.' : 'No history stored for this metric. Only DataSources the catalog marks for history keep samples.'}</p>
            : (
              <>
                <div className="h-64"><Line data={chart} options={options} /></div>
                {stat && (
                  <p className="text-[12px] text-ink-muted mt-2 tnum">
                    Avg {f(stat.avg)}, max {f(stat.max)}, last {f(stat.last)}, {fmtNum(stat.samples)} samples{daily ? ` over ${fmtNum(points.length)} day(s)` : ''}
                  </p>
                )}
              </>
            )}
    </Modal>
  );
}

function DatasourceTable({ ds, onHistory }) {
  const instances = arr(ds.instances);
  const metricKeys = useMemo(() => {
    const seen = [];
    for (const i of instances) for (const k of Object.keys(i?.metrics || {})) if (!seen.includes(k)) seen.push(k);
    return seen;
  }, [instances]);
  const firstMetric = (k) => {
    for (const i of instances) { const m = i?.metrics?.[k]; if (m) return m; }
    return null;
  };
  const rows = useMemo(() => instances.map((i) => ({ ...i, label: i.name || i.key })), [instances]);
  const sortValues = useMemo(() => Object.fromEntries(metricKeys.map((k) => [`m:${k}`, (r) => numOrNull(r.metrics?.[k]?.value)])), [metricKeys]);
  const ctl = useTableControls(rows, { searchKeys: ['label', 'key'], defaultSortKey: 'label', paginate: true, defaultPageSize: 25, sortValues, deepLink: false });

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <p className="text-xs font-semibold text-ink">{ds.label || ds.name}</p>
        {ds.label && ds.label !== ds.name && <span className="text-[10px] text-ink-faint font-mono">{ds.name}</span>}
        <span className="text-[11px] text-ink-faint">{fmtNum(instances.length)} instance(s)</span>
        <span className="text-[11px] text-ink-faint ml-auto">Sampled {ds.lastAt ? fmtWhen(ds.lastAt) : DASH}</span>
      </div>
      {instances.length > 10 && <div className="mb-2"><TableSearch ctl={ctl} placeholder="Search instances..." /></div>}
      {instances.length === 0 ? <p className="text-[12px] text-ink-muted py-2">No instances collected for this DataSource.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <SortTh k="label" label="Instance" ctl={ctl} />
              {metricKeys.map((k) => {
                const fm = firstMetric(k);
                const unit = fm?.unit || '';
                return <SortTh key={k} k={`m:${k}`} label={`${fm?.label || metricLabel(k)}${unit && unit !== '%' ? ` (${unit})` : ''}`} ctl={ctl} align="right" />;
              })}
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((i) => (
                <tr key={i.key} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 text-ink text-[12px] truncate max-w-[260px]" title={i.key}>{i.label}</td>
                  {metricKeys.map((k) => {
                    const m = i.metrics?.[k];
                    const canHist = m && m.kind !== 'state' && numOrNull(m.value) != null;
                    return (
                      <td key={k} className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px] whitespace-nowrap" title={m?.datapoint ? `Datapoint: ${m.datapoint}` : undefined}>
                        {m ? fmtMetricValue(m) : DASH}
                        {canHist && (
                          <button onClick={() => onHistory({ ds, instance: i, metric: k, unit: m.unit || '', label: m.label })}
                            className="ml-1.5 text-[10px] text-brand hover:underline cursor-pointer">History</button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
    </div>
  );
}

function FamilyBlock({ fam, open, onToggle, onHistory }) {
  const dss = arr(fam.datasources);
  const Chev = open ? ChevronDown : ChevronRight;
  const instCount = dss.reduce((n, d) => n + arr(d.instances).length, 0);
  return (
    <div className="border border-cohesity-border rounded-lg mb-3">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-surface-overlay/60 rounded-lg">
        <Chev size={14} className="text-ink-faint" />
        <span className="text-sm font-semibold text-ink">{fam.label || fam.family}</span>
        <span className="text-[11px] text-ink-faint">{fmtNum(dss.length)} DataSource(s), {fmtNum(instCount)} instance(s)</span>
      </button>
      {open && (
        <div className="px-3 pt-2">
          {dss.map((ds) => <DatasourceTable key={`${ds.hdsId}-${ds.name}`} ds={ds} onHistory={onHistory} />)}
        </div>
      )}
    </div>
  );
}

// payload: GET /logicmonitor/devices/:id/metrics (null while loading, false on error).
export default function LmMetricsTab({ payload, deviceId, sourceId }) {
  const families = arr(payload?.families).filter((f) => arr(f.datasources).length > 0);
  const [openMap, setOpenMap] = useState({});
  const [hist, setHist] = useState(null);

  if (payload == null) return <LoadingPanel label="Loading metrics..." height={120} />;
  if (payload === false) return <p className="text-sm text-status-crit py-6 text-center">Failed to load the collected metrics.</p>;
  if (families.length === 0) {
    return <p className="text-sm text-ink-muted py-6 text-center">No metrics collected yet. The metrics tier runs every 30 minutes by default; check Settings &gt; Scope &gt; Metric families.</p>;
  }
  const isOpen = (f, idx) => (openMap[f.family] != null ? openMap[f.family] : idx === 0 || families.length <= 2);

  return (
    <>
      {families.map((f, idx) => (
        <FamilyBlock key={f.family} fam={f} open={isOpen(f, idx)} onToggle={() => setOpenMap((cur) => ({ ...cur, [f.family]: !isOpen(f, idx) }))} onHistory={setHist} />
      ))}
      {hist && (
        <MetricHistoryModal deviceId={deviceId} sourceId={sourceId} hdsId={hist.ds.hdsId} instanceKey={hist.instance.key} instanceName={hist.instance.name}
          metric={hist.metric} unit={hist.unit} title={`${hist.ds.label || hist.ds.name}: ${hist.label || metricLabel(hist.metric)}`} onClose={() => setHist(null)} />
      )}
    </>
  );
}
