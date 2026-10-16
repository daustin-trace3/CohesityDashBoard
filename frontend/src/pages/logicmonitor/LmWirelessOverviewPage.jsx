import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wifi, WifiOff, RadioTower, Users, Flame, KeyRound } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { DASH, arr, fmtNum, fmtPct, stateTone, stateLabel, stateRank, useVisibleInterval } from './helpers';
import { SectionPanel, UtilBar, headRow } from './ui';
import { TrendLine } from './LmFirewall360';
import { ApStatusBadge, BAND_COLOR, ShareBars, WL_EMPTY } from './wirelessShared';
import LmWlc360 from './LmWlc360';
import LmAp360 from './LmAp360';

const REFRESH_MS = 120000;

export default function LmWirelessOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [wlc, setWlc] = useState(null);
  const [ap, setAp] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/wireless/overview')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || {}); toast({ type: 'error', title: 'Failed to load the wireless overview' }); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const t = data?.totals || {};
  const a = data?.analytics || {};
  const controllers = useMemo(() => [...arr(data?.controllers)].sort((x, y) => stateRank(y.state) - stateRank(x.state) || (y.apsDown || 0) - (x.apsDown || 0)), [data]);
  const empty = data != null && !t.controllers;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wifi} title="Wireless" description="Controllers, access points, RF and clients from the Cisco WLC DataSources in LogicMonitor">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      {data == null ? <LoadingPanel label="Loading wireless..." height={260} /> : empty ? <div className="panel p-6 text-sm text-ink-muted text-center">{WL_EMPTY}</div> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard icon={RadioTower} label="Controllers" value={fmtNum(t.controllers)} sub={t.controllersDegraded ? `${t.controllersDegraded} with issues` : 'all healthy'} tone={t.controllersDegraded ? 'warn' : 'ok'} onClick={() => navigate('/logicmonitor/wireless/controllers')} />
            <StatCard icon={Wifi} label="APs up" value={`${fmtNum(t.apsUp)} / ${fmtNum(t.aps)}`} onClick={() => navigate('/logicmonitor/wireless/aps')} />
            <StatCard icon={WifiOff} label="APs down" value={fmtNum(t.apsDown)} tone={t.apsDown ? 'crit' : 'ok'} onClick={() => navigate('/logicmonitor/wireless/aps?status=down')} />
            <StatCard icon={Flame} label="Hot radios" value={fmtNum(t.hotRadios)} sub={`>= ${a.channelUtilThresholdPct ?? '-'}% channel util`} tone={t.hotRadios ? 'warn' : 'ok'} onClick={() => navigate('/logicmonitor/wireless/rf?view=hot')} />
            <StatCard icon={Users} label="Clients" value={fmtNum(t.clients)} sub={`${fmtNum(t.ssids)} SSIDs`} onClick={() => navigate('/logicmonitor/wireless/ssids')} />
            <StatCard icon={KeyRound} label="RADIUS unresponsive" value={fmtNum(t.radiusUnresponsive)} tone={t.radiusUnresponsive ? 'warn' : 'ok'} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <SectionPanel title="Clients, 24 hours" className="lg:col-span-2">
              <TrendLine series={[{ label: 'Clients', points: data.clientTrend }]} empty="No client history yet; it builds as the metrics tier runs." />
            </SectionPanel>
            <SectionPanel title="Clients by band" blurb="Radio client counts; dual-band clients count once on the band they joined.">
              <ShareBars rows={arr(a.byBand).map((b) => ({ label: b.band, value: b.clients, sub: b.clientSharePct == null ? null : `${b.clientSharePct}%`, color: BAND_COLOR[b.band] }))} />
              <div className="mt-3 flex flex-col gap-1.5">
                {arr(a.byBand).map((b) => (
                  <div key={b.band} className="flex items-center gap-2 text-[11px]">
                    <span className="w-16 text-ink-muted">{b.band}</span>
                    <div className="flex-1"><UtilBar pct={b.avgChannelUtilPct} /></div>
                    <span className="w-20 text-right text-ink-faint">avg util</span>
                  </div>
                ))}
              </div>
            </SectionPanel>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Clients by SSID"><ShareBars rows={arr(a.bySsid).map((s) => ({ label: s.ssid, value: s.clients, sub: `${s.controllers} WLC` }))} /></SectionPanel>
            <SectionPanel title="Clients by site"><ShareBars rows={arr(a.bySite).map((s) => ({ label: s.site, value: s.clients, sub: s.apsDown ? `${s.apsDown} AP down` : `${s.aps} APs` }))} /></SectionPanel>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Busiest access points" blurb="By associated clients across all radios.">
              <ShareBars rows={arr(a.busiestAps).map((x) => ({ label: x.ap, value: x.clients, sub: x.controller }))} empty="No AP client counts collected yet." />
            </SectionPanel>
            <SectionPanel title="Hottest radios" blurb="By channel utilization: airtime used by this AP, other APs and interference.">
              <ShareBars max={100} unit="%" rows={arr(a.hottestRadios).map((x) => ({ label: x.radio, value: x.channelUtilPct, sub: x.band, color: BAND_COLOR[x.band] }))} empty="No radio utilization collected yet." />
            </SectionPanel>
          </div>

          {arr(a.downAps).length > 0 && (
            <SectionPanel title="Access points down" right={<button onClick={() => navigate('/logicmonitor/wireless/aps?status=down')} className="text-[11px] text-brand hover:underline cursor-pointer">All down APs</button>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}><th className="py-2 pr-3">Access point</th><th className="py-2 pr-3">Controller</th><th className="py-2 pr-3">Site</th><th className="py-2 pr-3">Status</th></tr></thead>
                  <tbody>
                    {a.downAps.slice(0, 15).map((x) => (
                      <tr key={`${x.controllerId}-${x.apKey}`} className="border-b border-cohesity-border/40 text-[12px] cursor-pointer hover:bg-surface-overlay" onClick={() => setAp(x)}>
                        <td className="py-1.5 pr-3 text-ink">{x.ap}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{x.controller}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{x.siteName || x.siteKey || DASH}</td>
                        <td className="py-1.5 pr-3"><ApStatusBadge status={x.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionPanel>
          )}

          <SectionPanel title="Controllers">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-2 pr-3">Controller</th><th className="py-2 pr-3">Site</th><th className="py-2 pr-3">Platform</th><th className="py-2 pr-3">HA</th>
                  <th className="py-2 pr-3 text-right">APs up / total</th><th className="py-2 pr-3 text-right">Clients</th><th className="py-2 pr-3">Avg channel util</th>
                  <th className="py-2 pr-3 text-right">CPU</th><th className="py-2 pr-3">State</th>
                </tr></thead>
                <tbody>
                  {controllers.map((r) => (
                    <tr key={`${r.sourceId}-${r.deviceId}`} className="border-b border-cohesity-border/40 text-[12px] cursor-pointer hover:bg-surface-overlay" onClick={() => setWlc(r)}>
                      <td className="py-1.5 pr-3 text-ink">{r.deviceName}</td>
                      <td className="py-1.5 pr-3 text-ink-muted">{r.siteName || r.siteKey || DASH}</td>
                      <td className="py-1.5 pr-3 text-ink-muted">{r.platform || DASH}</td>
                      <td className="py-1.5 pr-3">{r.haText ? <Badge tone={r.haDegraded ? 'crit' : 'info'}>{r.haText}</Badge> : <span className="text-ink-faint">{DASH}</span>}</td>
                      <td className={`py-1.5 pr-3 text-right tnum ${r.apsDown ? 'text-status-crit' : 'text-ink-muted'}`}>{r.apsTotal ? `${fmtNum(r.apsUp)} / ${fmtNum(r.apsTotal)}` : DASH}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clients)}</td>
                      <td className="py-1.5 pr-3 min-w-[120px]"><UtilBar pct={r.avgChannelUtilPct} /></td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(r.cpuPct)}</td>
                      <td className="py-1.5 pr-3"><Badge tone={stateTone(r.state)}>{stateLabel(r.state)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionPanel>
        </div>
      )}
      {wlc && <LmWlc360 deviceId={wlc.deviceId} sourceId={wlc.sourceId} onClose={() => setWlc(null)} />}
      {ap && <LmAp360 controllerId={ap.controllerId} sourceId={ap.sourceId} apKey={ap.apKey} onClose={() => setAp(null)} />}
    </div>
  );
}
