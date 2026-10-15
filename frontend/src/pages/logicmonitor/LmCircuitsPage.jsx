import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, Download, RefreshCw, Activity } from 'lucide-react';
import { Bar, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, arr, fmtNum, fmtPct, fmtSpeed, stateTone, stateLabel, stateRank, chartOpts, downloadCsv, useVisibleInterval,
} from './helpers';
import { Modal, Fact, headRow, chipBtn } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const REFRESH_MS = 60000;
const pctOpts = { ...chartOpts, scales: { x: chartOpts.scales.x, y: { ...chartOpts.scales.y, min: 0, suggestedMax: 100 } } };
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function ProfileModal({ circuit, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null); setError(false);
    client.get(`/logicmonitor/circuits/${circuit.instanceId}/profile`)
      .then(({ data: d }) => setData(d || {}))
      .catch(() => setError(true));
  }, [circuit.instanceId]);

  const hours = arr(data?.hours);
  const daily = arr(data?.daily);

  const hourChart = useMemo(() => {
    const byHour = new Map(hours.map((h) => [Number(h.hour), h]));
    const labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    const col = (k) => labels.map((_, i) => num(byHour.get(i)?.[k]));
    return {
      labels,
      datasets: [
        { type: 'bar', label: 'Avg in %', data: col('avgInPct'), backgroundColor: 'rgba(26,115,232,0.55)' },
        { type: 'bar', label: 'Avg out %', data: col('avgOutPct'), backgroundColor: 'rgba(63,185,80,0.55)' },
        { type: 'line', label: 'Max in %', data: col('maxInPct'), borderColor: '#D4A24E', pointRadius: 0, borderWidth: 2, tension: 0.2 },
        { type: 'line', label: 'Max out %', data: col('maxOutPct'), borderColor: '#C75D5D', pointRadius: 0, borderWidth: 2, tension: 0.2 },
      ],
    };
  }, [hours]);

  const dayLabel = (r) => String(r.day || r.date || r.dayStart || '').slice(5, 10);
  const dayChart = useMemo(() => ({
    labels: daily.map(dayLabel),
    datasets: [
      { label: 'Max in %', data: daily.map((r) => num(r.maxInPct ?? r.inMaxPct)), borderColor: BRAND, pointRadius: 2, borderWidth: 2, tension: 0.2 },
      { label: 'Max out %', data: daily.map((r) => num(r.maxOutPct ?? r.outMaxPct)), borderColor: '#C75D5D', pointRadius: 2, borderWidth: 2, tension: 0.2 },
    ],
  }), [daily]);

  return (
    <Modal icon={Activity} title={`${circuit.deviceName} ${circuit.port}`} subtitle={circuit.label} onClose={onClose} width="max-w-5xl">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Speed">{fmtSpeed(circuit.speedBps)}</Fact>
        <Fact label="p95 in / out">{`${fmtPct(circuit.p95InPct)} / ${fmtPct(circuit.p95OutPct)}`}</Fact>
        <Fact label="Highest daily max">{fmtPct(circuit.maxDailyPct)}</Fact>
        <Fact label="Busiest hour">{circuit.busiestHour != null ? `${String(circuit.busiestHour).padStart(2, '0')}:00 UTC` : '-'}</Fact>
      </div>
      {error ? <p className="text-sm text-status-crit py-6 text-center">Failed to load the circuit profile.</p> : data == null ? <LoadingPanel label="Loading profile..." height={200} /> : (
        <>
          <p className="text-xs font-semibold text-ink mb-1">Hour of day (UTC)</p>
          {hours.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No hourly history yet.</p> : <div className="h-56 mb-4"><Bar data={hourChart} options={pctOpts} /></div>}
          <p className="text-xs font-semibold text-ink mb-1">Daily maximum, last 30 days</p>
          {daily.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No daily rollups yet.</p> : <div className="h-56"><Line data={dayChart} options={pctOpts} /></div>}
        </>
      )}
    </Modal>
  );
}

export default function LmCircuitsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/circuits')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load circuits' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const list = useMemo(() => (rows || []).map((c) => ({
    ...c,
    stateRank: stateRank(c.state),
    siteLabel: c.siteName || c.siteKey || '',
  })).filter((c) => !stateFilter || stateTone(c.state) === stateFilter), [rows, stateFilter]);

  const ctl = useTableControls(list, {
    searchKeys: ['deviceName', 'port', 'label', 'siteLabel', 'circuitId', 'carrier'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
  });

  const recompute = async () => {
    setBusy(true);
    try {
      const { data } = await client.post('/logicmonitor/circuits/recompute');
      toast({ type: 'success', title: 'Circuits recomputed', message: data?.marked != null ? `${data.marked} WAN interface(s) marked.` : undefined });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Recompute failed', message: err?.response?.data?.error });
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/interfaces.csv', { wan: 1 }, 'logicmonitor-circuits'); }
    catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setExporting(false); }
  };

  const setState = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('state', v); else next.delete('state');
    setSearchParams(next, { replace: true });
  };

  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cable} title="Circuits" description="WAN interfaces with p95 load, headroom and busiest hour, flagged when they run near saturation">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search site, device, port or label..." />
          <FilterSelect ctl={ctl} k="siteLabel" rows={list} label="sites" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} circuit(s)</span>
          <button onClick={recompute} disabled={busy} className={`${btn} ml-auto`} title="Re-mark WAN interfaces (admin)">
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Recompute circuits
          </button>
          <button onClick={exportCsv} disabled={exporting} className={btn}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>

        {rows == null ? <LoadingPanel label="Loading circuits..." height={200} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">{rows.length === 0 ? 'No WAN circuits identified yet. Circuits are router and firewall interfaces whose description names a carrier, interfaces carrying a circuit ID (ifAlias, description or a circuit property), or ones you force under Settings.' : 'No circuits match.'}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="deviceName" label="Device" ctl={ctl} />
                  <SortTh k="port" label="Port" ctl={ctl} />
                  <SortTh k="label" label="Label" ctl={ctl} />
                  <SortTh k="circuitId" label="Circuit ID" ctl={ctl} />
                  <SortTh k="carrier" label="Carrier" ctl={ctl} />
                  <SortTh k="speedBps" label="Speed" ctl={ctl} align="right" />
                  <SortTh k="inUtilPct" label="Now in" ctl={ctl} align="right" />
                  <SortTh k="outUtilPct" label="Now out" ctl={ctl} align="right" />
                  <SortTh k="p95InPct" label="p95 in" ctl={ctl} align="right" />
                  <SortTh k="p95OutPct" label="p95 out" ctl={ctl} align="right" />
                  <SortTh k="headroomPct" label="Headroom" ctl={ctl} align="right" />
                  <SortTh k="busiestHour" label="Busiest" ctl={ctl} align="right" />
                  <SortTh k="errors24h" label="Errors" ctl={ctl} align="right" />
                  <SortTh k="flaps24h" label="Flaps" ctl={ctl} align="right" />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((c) => (
                    <tr key={c.instanceId} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setProfile(c)}>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.siteLabel || '-'}</td>
                      <td className="py-2 pr-3 text-ink text-[12px]">{c.deviceName}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.port}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[220px]" title={c.label}>{c.label || '-'}{c.wanReason === 'override' ? <Badge tone="neutral" className="ml-1">Forced</Badge> : null}</td>
                      <td className="py-2 pr-3 text-ink text-[12px] font-mono" title={c.circuitIdSource ? `from ${c.circuitIdSource}` : undefined}>{c.circuitId || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.carrier || '-'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtSpeed(c.speedBps)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(c.inUtilPct)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(c.outUtilPct)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${num(c.p95InPct) >= 80 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtPct(c.p95InPct)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${num(c.p95OutPct) >= 80 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtPct(c.p95OutPct)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(c.headroomPct)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.busiestHour != null ? `${String(c.busiestHour).padStart(2, '0')}:00` : '-'}</td>
                      <td className={`py-2 pr-3 text-right tnum ${c.errors24h ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(c.errors24h)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${c.flaps24h ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(c.flaps24h)}</td>
                      <td className="py-2 pr-3"><Badge tone={stateTone(c.state)}>{stateLabel(c.state)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {profile && <ProfileModal circuit={profile} onClose={() => setProfile(null)} />}
    </div>
  );
}
