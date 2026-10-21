import { useEffect, useMemo, useState } from 'react';
import client from '../../api/client';
import { LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { DASH, arr, fmtNum } from './helpers';
import { chipBtn, headRow } from './ui';

const STRIP_DAYS = [30, 90];

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtVal = (v) => (num(v) == null ? DASH : String(+Number(v).toFixed(2)));

// One square per day: red any dead sample, amber dead-collector only, blue SDT only, green normal, grey no samples.
function dayState(r) {
  if (!r || !r.samples) return { cls: 'bg-surface-overlay', name: 'no samples' };
  if (r.deadPct > 0) return { cls: 'bg-status-crit', name: 'dead' };
  if (r.deadCollectorPct > 0) return { cls: 'bg-status-warn', name: 'collector down' };
  if (r.sdtPct > 0) return { cls: 'bg-brand', name: 'in SDT' };
  return { cls: 'bg-status-ok', name: 'normal' };
}

// Every calendar day of the window, filled from the daily rows (missing days are grey).
function fillDays(rows, days) {
  const byDay = new Map(arr(rows).map((r) => [r.day, r]));
  const out = [];
  for (let k = days - 1; k >= 0; k -= 1) {
    const day = new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
    out.push(byDay.get(day) || { day, samples: 0 });
  }
  return out;
}

function BaselineTable({ rows }) {
  const list = useMemo(() => arr(rows).map((r) => ({ ...r, label: r.instanceName || r.instanceKey })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['datasourceName', 'label', 'instanceKey', 'metric'], defaultSortKey: 'datasourceName', paginate: true, defaultPageSize: 25, deepLink: false,
  });
  if (!list.length) return <p className="text-sm text-ink-muted py-4">No daily metric history yet. It builds from the next metrics poll.</p>;
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <TableSearch ctl={ctl} placeholder="Search DataSource, instance or metric..." />
        <span className="text-[11px] text-ink-faint ml-auto">{fmtNum(ctl.rows.length)} metric(s)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <SortTh k="datasourceName" label="DataSource" ctl={ctl} />
            <SortTh k="label" label="Instance" ctl={ctl} />
            <SortTh k="metric" label="Metric" ctl={ctl} />
            <SortTh k="avg" label="Avg" ctl={ctl} align="right" />
            <SortTh k="min" label="Min" ctl={ctl} align="right" />
            <SortTh k="max" label="Max" ctl={ctl} align="right" />
            <SortTh k="last" label="Last" ctl={ctl} align="right" />
            <SortTh k="days" label="Days" ctl={ctl} align="right" />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r) => (
              <tr key={`${r.datasourceName}|${r.instanceKey}|${r.metric}`} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink text-[12px] truncate max-w-[200px]" title={r.datasourceName}>{r.datasourceName}</td>
                <td className="py-1.5 pr-3 text-ink-muted text-[12px] truncate max-w-[200px]" title={r.instanceKey}>{r.label}</td>
                <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{r.metric}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink text-[12px]">{fmtVal(r.avg)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtVal(r.min)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtVal(r.max)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtVal(r.last)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-faint text-[12px]">{fmtNum(r.days)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
    </>
  );
}

// Device 360 History tab: day strip from /devices/:id/daily, 30-day baseline from /devices/:id/baseline.
export default function LmDeviceHistoryTab({ deviceId, sourceId }) {
  const [days, setDays] = useState(30);
  const [daily, setDaily] = useState(null); // null loading, false failed
  const [baseline, setBaseline] = useState(null);

  useEffect(() => {
    setDaily(null);
    const params = { days };
    if (sourceId) params.sourceId = sourceId;
    client.get(`/logicmonitor/devices/${deviceId}/daily`, { params })
      .then(({ data }) => setDaily(data || { rows: [], summary: {} }))
      .catch(() => setDaily(false));
  }, [deviceId, sourceId, days]);

  useEffect(() => {
    setBaseline(null);
    const params = { days: 30 };
    if (sourceId) params.sourceId = sourceId;
    client.get(`/logicmonitor/devices/${deviceId}/baseline`, { params })
      .then(({ data }) => setBaseline(data || { metrics: [] }))
      .catch(() => setBaseline(false));
  }, [deviceId, sourceId]);

  const strip = useMemo(() => fillDays(daily?.rows, days), [daily, days]);
  const sm = daily?.summary || {};

  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        {STRIP_DAYS.map((d) => <button key={d} onClick={() => setDays(d)} className={chipBtn(days === d)}>{d} days</button>)}
      </div>
      {daily === false ? <p className="text-sm text-status-crit py-4">Failed to load the device history.</p>
        : daily == null ? <LoadingPanel label="Loading history..." height={80} />
          : (
            <>
              <div className="flex flex-wrap gap-1" data-testid="lm-day-strip">
                {strip.map((r) => {
                  const st = dayState(r);
                  const opened = num(r.alertsOpened) || 0;
                  const title = r.samples
                    ? `${r.day}: dead ${fmtVal(r.deadPct ?? 0)}%, SDT ${fmtVal(r.sdtPct ?? 0)}%, ${opened} alerts (${st.name})`
                    : `${r.day}: no samples${opened ? `, ${opened} alerts` : ''}`;
                  return (
                    <span key={r.day} title={title}
                      className={`inline-flex items-center justify-center w-5 h-5 rounded-sm text-[9px] font-semibold tnum ${st.cls} ${st.cls === 'bg-surface-overlay' ? 'text-ink-faint' : 'text-white'}`}>
                      {opened > 0 ? (opened > 9 ? '9+' : opened) : ''}
                    </span>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-2 text-[10px] text-ink-faint">
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-status-crit align-middle mr-1" />Dead</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-status-warn align-middle mr-1" />Collector down</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-brand align-middle mr-1" />In SDT</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-status-ok align-middle mr-1" />Normal</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-surface-overlay align-middle mr-1" />No samples</span>
                <span>The number in a square is the alerts opened that day.</span>
              </div>
              <p className="text-[12px] text-ink-muted mt-2 tnum">
                {fmtNum(sm.days || 0)} day(s) recorded: dead on {fmtNum(sm.daysDead || 0)}, collector down on {fmtNum(sm.daysDeadCollector || 0)},
                in SDT on {fmtNum(sm.daysInSdt || 0)}; {fmtNum(sm.alertsOpened || 0)} alerts opened ({fmtNum(sm.alertsCritical || 0)} critical).
              </p>
            </>
          )}
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mt-5 mb-2">30-day baseline</p>
      {baseline === false ? <p className="text-sm text-status-crit py-4">Failed to load the baseline.</p>
        : baseline == null ? <LoadingPanel label="Loading baseline..." height={80} />
          : <BaselineTable rows={baseline.metrics} />}
    </div>
  );
}
