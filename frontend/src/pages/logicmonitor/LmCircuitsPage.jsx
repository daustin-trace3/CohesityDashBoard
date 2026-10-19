import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, Cloud, Download, RefreshCw, Activity } from 'lucide-react';
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
import Sparkline from './overview/Sparkline';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const REFRESH_MS = 60000;
const pctOpts = { ...chartOpts, scales: { x: chartOpts.scales.x, y: { ...chartOpts.scales.y, min: 0, suggestedMax: 100 } } };
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const CLOUD_KIND_LABEL = { 'aws-dx': 'Direct Connect', 'aws-vif': 'Direct Connect VIF', 'azure-er': 'ExpressRoute', 'azure-ecx': 'ExpressRoute' };
const CLOUD_STATE_LABEL = { critical: 'Down', warning: 'Saturated', ok: 'OK', unknown: 'No data' };
const cloudTone = (s) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : s === 'ok' ? 'ok' : 'neutral');
const fmtBps = (v) => (v == null ? '-' : fmtSpeed(v));
// Cost center tag when present, else the first tag as "key: value" (round 10; tag keys come from system.aws.tag.* and system.azure.tag.*).
const costCenterOf = (c) => {
  const tags = c.tags && typeof c.tags === 'object' ? c.tags : {};
  if (tags['cost-center'] != null) return String(tags['cost-center']);
  const first = Object.entries(tags)[0];
  return first ? `${first[0]}: ${first[1]}` : '-';
};
const ownerOf = (c) => c.ownerAccount || c.subscription || '-';
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function exportCloudCsv(rows) {
  const head = ['Connection', 'Kind', 'Region', 'Location', 'Bandwidth', 'Owner', 'Cost center', 'State', 'In bps', 'Out bps', 'BGP'];
  const lines = [head.join(',')].concat(rows.map((c) => [
    c.name, CLOUD_KIND_LABEL[c.kind] || c.kindLabel || c.kind, c.region, c.location, c.bandwidthText || (c.bandwidthBps ? fmtSpeed(c.bandwidthBps) : ''),
    c.ownerAccount || c.subscription, costCenterOf(c) === '-' ? '' : costCenterOf(c), CLOUD_STATE_LABEL[c.state] || c.state, c.bpsIn, c.bpsOut, c.bgp,
  ].map(csvCell).join(',')));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'logicmonitor-cloud-circuits.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// AWS Direct Connect and Azure ExpressRoute from the DataSource metrics (round 9). Small, so no paging.
function CloudCircuits({ rows }) {
  if (!rows.length) return null;
  return (
    <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex items-center gap-2 mb-3">
        <Cloud size={14} className="text-ink-muted" />
        <h3 className="text-sm font-semibold text-ink">Cloud circuits</h3>
        <span className="text-[11px] text-ink-faint tnum">{fmtNum(rows.length)} connection(s)</span>
        <button onClick={() => exportCloudCsv(rows)} className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"><Download size={12} /> Export</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <th className="text-left py-2 pr-3 font-medium">Connection</th>
            <th className="text-left py-2 pr-3 font-medium">Kind</th>
            <th className="text-left py-2 pr-3 font-medium">Region</th>
            <th className="text-left py-2 pr-3 font-medium">Location</th>
            <th className="text-right py-2 pr-3 font-medium">Bandwidth</th>
            <th className="text-left py-2 pr-3 font-medium">Owner</th>
            <th className="text-left py-2 pr-3 font-medium">Cost center</th>
            <th className="text-left py-2 pr-3 font-medium">State</th>
            <th className="text-right py-2 pr-3 font-medium">In</th>
            <th className="text-right py-2 pr-3 font-medium">Out</th>
            <th className="text-right py-2 pr-3 font-medium">BGP</th>
            <th className="text-right py-2 pr-3 font-medium">Load</th>
            <th className="text-left py-2 pr-3 font-medium">24 h</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => {
              const series = arr(c.series24h).map((p) => Math.max(num(p.inBps) || 0, num(p.outBps) || 0));
              return (
                <tr key={`${c.sourceId}:${c.deviceId}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink text-[12px]">{c.name}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{CLOUD_KIND_LABEL[c.kind] || c.kindLabel || c.kind}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.region || '-'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.location || '-'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted" title={c.bandwidthText || undefined}>{fmtBps(c.bandwidthBps)}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px] tnum">{ownerOf(c)}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{costCenterOf(c)}</td>
                  <td className="py-2 pr-3">
                    <span title={c.stateRaw != null ? `Raw state value ${c.stateRaw} (enum unverified)` : undefined}>
                      <Badge tone={cloudTone(c.state)}>{CLOUD_STATE_LABEL[c.state] || c.state}</Badge>
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBps(c.bpsIn)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBps(c.bpsOut)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.bgp == null ? '-' : fmtNum(c.bgp)}</td>
                  <td className={`py-2 pr-3 text-right tnum ${num(c.utilPct) >= 80 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtPct(c.utilPct)}</td>
                  <td className="py-2 pr-3"><Sparkline values={series} color={c.state === 'critical' ? '#C75D5D' : c.state === 'warning' ? '#D4A24E' : BRAND} width={96} height={24} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
  const [cloud, setCloud] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/circuits', { params: { cloud: 1 } })
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setCloud(arr(data?.cloud)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load circuits' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const list = useMemo(() => (rows || []).map((c) => ({
    ...c,
    stateRank: stateRank(c.state),
    siteLabel: c.siteName || c.siteKey || '',
    carrierLabel: c.carrier || 'Unknown',
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
          <FilterSelect ctl={ctl} k="carrierLabel" rows={list} label="carriers" />
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
                      <td className="py-2 pr-3 text-[12px]">{c.carrier ? <span className="text-ink-muted">{c.carrier}</span> : <span className="text-ink-faint" title={c.label || 'No label text'}>Unknown</span>}</td>
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

      <CloudCircuits rows={cloud} />

      {profile && <ProfileModal circuit={profile} onClose={() => setProfile(null)} />}
    </div>
  );
}
