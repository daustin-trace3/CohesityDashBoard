import { useEffect, useState, useCallback, useMemo } from 'react';
import { Wifi, Radio, ShieldAlert, Activity, Lock, Repeat } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const BUCKET_COLOR = { excellent: '#6CB33F', good: '#8FA3B0', fair: '#D4A24E', poor: '#C75D5D' };
const BUCKET_LABEL = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' };
const BAND_LABEL = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };
const LINE_COLORS = ['#006FFF', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#8FA3B0', '#FF9900', '#0091DA'];

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

function SignalBar({ buckets }) {
  const total = Object.values(buckets || {}).reduce((a, b) => a + (b || 0), 0);
  if (!total) return <p className="text-sm text-ink-muted">No wireless clients.</p>;
  return (
    <div>
      <div className="flex w-full h-3 rounded-full overflow-hidden mb-2">
        {['excellent', 'good', 'fair', 'poor'].map((k) => {
          const pct = ((buckets[k] || 0) / total) * 100;
          return pct > 0 ? <div key={k} style={{ width: `${pct}%`, backgroundColor: BUCKET_COLOR[k] }} /> : null;
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {['excellent', 'good', 'fair', 'poor'].map((k) => (
          <span key={k} className="text-[11px] text-ink-muted inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: BUCKET_COLOR[k] }} />
            {BUCKET_LABEL[k]} ({buckets[k] || 0})
          </span>
        ))}
      </div>
    </div>
  );
}

function ApSignalRows({ signalByAp }) {
  if (!signalByAp?.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2.5">
      <p className="text-[11px] uppercase tracking-wide text-ink-faint">By access point</p>
      {signalByAp.map((a) => (
        <div key={a.apMac} className="flex items-center gap-3">
          <div className="w-44 shrink-0 min-w-0">
            <p className="text-xs text-ink truncate">{a.apName}</p>
            <p className="text-[10px] text-ink-faint tnum">{a.total} client{a.total === 1 ? '' : 's'}{a.avgSignal != null ? ` · avg ${a.avgSignal} dBm` : ''}</p>
          </div>
          <div className="flex flex-1 h-2.5 rounded-full overflow-hidden bg-surface-overlay">
            {['excellent', 'good', 'fair', 'poor'].map((k) => {
              const pct = a.total ? ((a.buckets[k] || 0) / a.total) * 100 : 0;
              return pct > 0 ? (
                <div key={k} style={{ width: `${pct}%`, backgroundColor: BUCKET_COLOR[k] }}
                  title={`${BUCKET_LABEL[k]}: ${a.buckets[k]}`} />
              ) : null;
            })}
          </div>
          <div className="w-28 shrink-0 text-right text-[10px] text-ink-faint tnum">
            {['excellent', 'good', 'fair', 'poor'].filter((k) => a.buckets[k]).map((k) => `${a.buckets[k]} ${BUCKET_LABEL[k].toLowerCase()}`).slice(0, 2).join(' · ')}
          </div>
        </div>
      ))}
    </div>
  );
}

function wpaTone(posture) {
  const mode = String(posture?.wpa_mode || '').toLowerCase();
  if (!mode || mode === 'open' || mode === 'wep') return 'crit';
  if ((mode === 'wpapsk' || mode === 'wpa' || mode === 'wpa2') && !posture?.wpa3_transition && !posture?.wpa3_support) return 'warn';
  return 'ok';
}

function PostureChips({ wlan }) {
  const p = wlan.posture;
  if (!p) return <span className="text-[11px] text-ink-faint">No posture data collected.</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={wpaTone(p)}>{p.wpa_mode || 'open'}</Badge>
      {p.pmf_mode && <Badge tone="neutral">PMF {p.pmf_mode}</Badge>}
      {(p.wpa3_support || p.wpa3_transition) && <Badge tone="ok">{p.wpa3_transition ? 'WPA3 transition' : 'WPA3'}</Badge>}
      {p.hide_ssid ? <Badge tone="neutral">Hidden</Badge> : null}
      {p.l2_isolation ? <Badge tone="info">L2 Isolation</Badge> : null}
      {p.fast_roaming_enabled ? <Badge tone="info">802.11r Fast Roaming</Badge> : null}
    </div>
  );
}

function TrafficCharts({ history, hours, setHours }) {
  const site = history?.site || [];
  const aps = history?.aps || [];

  const siteLabels = useMemo(() => {
    const times = [...new Set(site.map((h) => h.time))].sort((a, b) => a - b);
    return times.map((t) => new Date(t).toLocaleString(undefined, hours > 24 ? undefined : { hour: '2-digit', minute: '2-digit' }));
  }, [site, hours]);

  const siteSources = useMemo(() => [...new Set(site.map((h) => h.sourceId))], [site]);

  const bytesChart = useMemo(() => {
    const times = [...new Set(site.map((h) => h.time))].sort((a, b) => a - b);
    return {
      labels: siteLabels,
      datasets: siteSources.map((sid, i) => {
        const rows = site.filter((h) => h.sourceId === sid);
        const name = rows[0]?.sourceName || `Source ${sid}`;
        const byTime = new Map(rows.map((r) => [r.time, r.wlanBytes]));
        return {
          label: `${name} — Wireless Traffic`,
          data: times.map((t) => (byTime.get(t) != null ? byTime.get(t) / 1e9 : null)),
          borderColor: LINE_COLORS[i % LINE_COLORS.length],
          backgroundColor: `${LINE_COLORS[i % LINE_COLORS.length]}20`,
          pointRadius: 0, borderWidth: 2, tension: 0.2, fill: true, yAxisID: 'y',
        };
      }),
    };
  }, [site, siteLabels, siteSources]);

  const staChart = useMemo(() => {
    const times = [...new Set(site.map((h) => h.time))].sort((a, b) => a - b);
    return {
      labels: siteLabels,
      datasets: siteSources.map((sid, i) => {
        const rows = site.filter((h) => h.sourceId === sid);
        const name = rows[0]?.sourceName || `Source ${sid}`;
        const byTime = new Map(rows.map((r) => [r.time, r.wlanNumSta ?? r.numSta]));
        return {
          label: `${name} — Wireless Clients`,
          data: times.map((t) => byTime.get(t) ?? null),
          borderColor: LINE_COLORS[(i + 2) % LINE_COLORS.length],
          pointRadius: 0, borderWidth: 1.5, tension: 0.2,
        };
      }),
    };
  }, [site, siteLabels, siteSources]);

  const apChart = useMemo(() => {
    const times = [...new Set(aps.map((h) => h.time))].sort((a, b) => a - b);
    const labels = times.map((t) => new Date(t).toLocaleString(undefined, hours > 24 ? undefined : { hour: '2-digit', minute: '2-digit' }));
    const byMac = new Map();
    aps.forEach((r) => {
      const key = r.apMac;
      if (!byMac.has(key)) byMac.set(key, { name: r.apName || key, rows: new Map() });
      byMac.get(key).rows.set(r.time, r.numSta);
    });
    const macs = [...byMac.keys()].slice(0, 8);
    return {
      labels,
      datasets: macs.map((mac, i) => {
        const entry = byMac.get(mac);
        return {
          label: entry.name,
          data: times.map((t) => entry.rows.get(t) ?? null),
          borderColor: LINE_COLORS[i % LINE_COLORS.length],
          pointRadius: 0, borderWidth: 1.5, tension: 0.2,
        };
      }),
    };
  }, [aps, hours]);

  const bytesOpts = {
    ...chartOpts,
    scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, title: { display: true, text: 'GB', color: '#8FA3B0', font: { size: 10 } } } },
  };

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-ink flex items-center gap-2"><Activity size={15} className="text-brand" /> WiFi Traffic</p>
        <div className="flex items-center gap-1">
          {[24, 168].map((h) => (
            <button key={h} onClick={() => setHours(h)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${hours === h ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
              {h === 24 ? '24h' : '7d'}
            </button>
          ))}
        </div>
      </div>
      {site.length === 0 && aps.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center mb-4">No traffic history available for this window.</div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-3 mb-4">
          {site.length > 0 && (
            <>
              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-xs font-semibold text-ink mb-2">Wireless Traffic (GB)</p>
                <div className="h-40"><Line data={bytesChart} options={bytesOpts} /></div>
              </div>
              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-xs font-semibold text-ink mb-2">Wireless Clients</p>
                <div className="h-40"><Line data={staChart} options={chartOpts} /></div>
              </div>
            </>
          )}
          {aps.length > 0 && (
            <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-xs font-semibold text-ink mb-2">Per-AP Client Load</p>
              <div className="h-44"><Line data={apChart} options={chartOpts} /></div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function RoamingTable({ roaming }) {
  if (!roaming?.length) return null;
  return (
    <>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Repeat size={15} className="text-brand" /> Roaming &amp; Stability (24h)</p>
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <th className="py-2 pr-3">Client</th>
              <th className="py-2 pr-3 text-right">Roams</th>
              <th className="py-2 pr-3 text-right">Disconnects</th>
              <th className="py-2 pr-3 text-right">Signal</th>
              <th className="py-2 pr-3">Status</th>
            </tr></thead>
            <tbody>
              {roaming.map((r, i) => (
                <tr key={r.mac || i} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink">{r.name || r.mac}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.roams24h)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.disconnects24h)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.signal ?? '—'}</td>
                  <td className="py-2 pr-3">{r.sticky ? <Badge tone="warn">Sticky</Badge> : <Badge tone="neutral">—</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function UnifiWifiPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [hours, setHours] = useState(24);

  const load = useCallback((h) => client.get('/unifi/wifi', { params: { hours: h ?? hours } })
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ wlans: [], radios: [], rogues: [], signalBuckets: {}, roaming: [], history: {} }); toast({ type: 'error', title: 'Failed to load WiFi data' }); }), [toast, hours]);

  useEffect(() => { load(hours); }, [hours]); // eslint-disable-line react-hooks/exhaustive-deps

  const wlans = data?.wlans || [];
  const radios = data?.radios || [];
  const rogues = data?.rogues || [];
  const signalBuckets = data?.signalBuckets || {};
  const roaming = data?.roaming || [];

  const rogueList = rogues.map((r) => ({ ...r, rogue_label: r.is_rogue ? 'Flagged' : 'Neighbor' }));
  const ctl = useTableControls(rogueList, {
    searchKeys: ['essid', 'bssid', 'oui'],
    defaultSortKey: 'signal', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wifi} title="WiFi" description="Wireless networks, radios and nearby access points">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={() => load(hours)} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading WiFi data…" height={160} />
      ) : (
        <>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Wifi size={15} className="text-brand" /> WLANs</p>
          {wlans.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center mb-4">No WLANs configured.</div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {wlans.map((w) => (
                <div key={w.id || w.wlan_id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-sm font-semibold text-ink truncate">{w.name}</p>
                    <Badge tone={w.enabled ? 'ok' : 'neutral'}>{w.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge tone="neutral">{w.security || 'open'}</Badge>
                    {w.is_guest ? <Badge tone="info">Guest</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {wlans.length > 0 && (
            <>
              <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Lock size={15} className="text-brand" /> WLAN Security Posture</p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                {wlans.map((w) => (
                  <div key={`posture-${w.id || w.wlan_id}`} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                    <p className="text-sm font-semibold text-ink truncate mb-2">{w.name}</p>
                    <PostureChips wlan={w} />
                  </div>
                ))}
              </div>
            </>
          )}

          <TrafficCharts history={data?.history} hours={hours} setHours={setHours} />

          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Radio size={15} className="text-brand" /> Radios</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            {radios.length === 0 ? (
              <div className="text-sm text-ink-muted py-4 text-center">No radio data collected.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Access Point</th>
                    <th className="py-2 pr-3">Band</th>
                    <th className="py-2 pr-3 text-right">Channel</th>
                    <th className="py-2 pr-3 text-right">Width</th>
                    <th className="py-2 pr-3 text-right">Tx Power</th>
                    <th className="py-2 pr-3 text-right">Utilization</th>
                    <th className="py-2 pr-3 text-right">Retry %</th>
                    <th className="py-2 pr-3 text-right">Interference</th>
                    <th className="py-2 pr-3 text-right">Satisfaction</th>
                    <th className="py-2 pr-3 text-right">Clients</th>
                  </tr></thead>
                  <tbody>
                    {radios.map((r, i) => (
                      <tr key={i} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink">{r.deviceName || r.deviceMac}</td>
                        <td className="py-2 pr-3 text-ink-muted">{BAND_LABEL[r.radio] || r.radio || '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.channel ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.width ? `${r.width} MHz` : '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.txPower != null ? `${r.txPower} dBm${r.txPowerMode ? ` (${r.txPowerMode})` : ''}` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.utilization > 60 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.utilization != null ? `${r.utilization}%` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.txRetriesPct > 15 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.txRetriesPct != null ? `${r.txRetriesPct}%` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.interferencePct > 20 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.interferencePct != null ? `${r.interferencePct}%` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.satisfaction != null && r.satisfaction < 70 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.satisfaction != null ? `${r.satisfaction}%` : '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.numSta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-sm font-semibold text-ink mb-3">Signal Quality Distribution</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <SignalBar buckets={signalBuckets} />
            <ApSignalRows signalByAp={data?.signalByAp} />
          </div>

          <RoamingTable roaming={roaming} />

          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Neighboring / Rogue Access Points</p>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <TableControls ctl={ctl} rows={rogueList} searchPlaceholder="Filter by SSID, BSSID or vendor…"
              filters={[{ k: 'rogue_label', label: 'Flag' }, { k: 'security', label: 'Security' }]} />
            {rogueList.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No neighboring access points detected.</div>
            ) : ctl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No results match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="essid" label="SSID" ctl={ctl} />
                    <SortTh k="bssid" label="BSSID" ctl={ctl} />
                    <SortTh k="channel" label="Channel" ctl={ctl} align="right" />
                    <SortTh k="signal" label="Signal" ctl={ctl} align="right" />
                    <SortTh k="security" label="Security" ctl={ctl} />
                    <SortTh k="rogue_label" label="Flag" ctl={ctl} />
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((r, i) => (
                      <tr key={r.id || i} className={`border-b border-cohesity-border/50 ${r.is_rogue ? 'bg-status-crit/5' : ''}`}>
                        <td className="py-2 pr-3 text-ink">{r.essid || '(hidden)'}</td>
                        <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{r.bssid}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.channel ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.signal ?? '—'}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.security || '—'}</td>
                        <td className="py-2 pr-3"><Badge tone={r.is_rogue ? 'crit' : 'neutral'}>{r.rogue_label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </div>
        </>
      )}
    </div>
  );
}
