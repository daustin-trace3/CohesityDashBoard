import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Gauge, Server, ShieldAlert, AlertTriangle, CheckCircle2, BrickWall, RadioTower, Wifi, Fingerprint,
  Layers, Zap, TrendingUp, Repeat, RotateCcw,
} from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, fmtWhen, DASH, arr } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { IssuesList } from '../logicmonitor/kit360';
import { StateDot, stateWord, stateRankOf } from '../logicmonitor/groupTree';
import LmDevice360 from '../logicmonitor/LmDevice360';
import CiscoFleetSection from './CiscoFleetSection';
import {
  BRAND, API, SOURCE_NOTE, OLDER_VERSION, kindLabel, familyLabel, rowsOf, useCiscoGet,
} from './ciscoShared';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function CiscoOverviewPage() {
  const { data, error, loading, reload, loadedAt } = useCiscoGet(`${API}/overview`, 'the Cisco overview');
  const [open, setOpen] = useState(null);

  const shapeOk = !!data && data.devices && typeof data.devices === 'object';
  const dev = shapeOk ? data.devices : {};
  const fw = data?.firewalls || {};
  const wl = data?.wireless || {};
  const ise = data?.ise || {};
  const sources = arr(data?.sources);
  const tiles = data?.tiles && typeof data.tiles === 'object' ? data.tiles : null;
  // A figure whose feed is missing is null and reads as a dash, never as zero.
  const tileVal = (v) => (v == null ? DASH : fmtNum(n0(v)));
  const total = n0(dev.total);
  const byKind = dev.byKind && typeof dev.byKind === 'object' ? dev.byKind : {};
  const byFamily = dev.byFamily && typeof dev.byFamily === 'object' ? dev.byFamily : {};

  const worst = useMemo(() => (rowsOf(data?.devicesWorstFirst) || []).map((r) => ({
    ...r,
    name: r.displayName || r.name || '',
    stateRank: stateRankOf(r.state),
    kindText: kindLabel(r.vendorKind),
    reasonText: Array.isArray(r.reasons) ? r.reasons.join('; ') : (r.reasons || ''),
  })), [data]);
  const ctl = useTableControls(worst, {
    searchKeys: ['name', 'siteName', 'model', 'kindText', 'reasonText'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true, defaultPageSize: 10, deepLink: false,
  });

  const kindChips = Object.entries(byKind).filter(([, n]) => n0(n) > 0).sort((a, b) => n0(b[1]) - n0(a[1]));
  const familySub = Object.entries(byFamily).filter(([, n]) => n0(n) > 0).map(([k, n]) => `${fmtNum(n0(n))} ${familyLabel(k)}`).join(', ');

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Cisco Overview" description="Cisco and Meraki switches, routers, firewalls, wireless, ISE and voice, read from the LogicMonitor portals that monitor them">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>

      {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
      {!error && !loading && !shapeOk && <p className="text-sm text-status-warn mb-3">{OLDER_VERSION}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard icon={Server} label="Devices" value={fmtNum(total)} sub={familySub || undefined} loading={loading} />
        <StatCard icon={ShieldAlert} label="Failed" value={fmtNum(n0(dev.failed))} tone={n0(dev.failed) ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={AlertTriangle} label="Degraded" value={fmtNum(n0(dev.degraded))} tone={n0(dev.degraded) ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={CheckCircle2} label="Operational" value={fmtNum(n0(dev.ok))} tone="ok" loading={loading} />
        <StatCard icon={BrickWall} label="Firewalls" value={fmtNum(n0(fw.total))} tone={n0(fw.degraded) ? 'warn' : 'ok'} sub={`${fmtNum(n0(fw.degraded))} degraded, ${fmtNum(n0(fw.haDegraded))} HA degraded`} loading={loading} />
        <StatCard icon={RadioTower} label="Controllers" value={fmtNum(n0(wl.controllers))} sub="wireless" loading={loading} />
        <StatCard icon={Wifi} label="Access points" value={fmtNum(n0(wl.aps))} tone={n0(wl.apsDown) ? 'crit' : 'ok'} sub={`${fmtNum(n0(wl.apsDown))} down, ${fmtNum(n0(wl.clients))} clients`} loading={loading} />
        <StatCard icon={Fingerprint} label="ISE nodes" value={fmtNum(n0(ise.nodes))} tone={n0(ise.degraded) ? 'warn' : 'ok'} sub={`${fmtNum(n0(ise.degraded))} degraded`} loading={loading} />
      </div>

      {tiles && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
          <StatCard icon={Layers} label="Redundancy lost" value={tileVal(tiles.redundancyLost)} tone={n0(tiles.redundancyLost) ? 'warn' : 'ok'} sub="PSU, supervisor, stack" loading={loading} />
          <StatCard icon={Zap} label="Optics at risk" value={tileVal(tiles.opticsAtRisk)} tone={n0(tiles.opticsAtRisk) ? 'warn' : 'ok'} sub="thin margin or falling" loading={loading} />
          <StatCard icon={TrendingUp} label="Links to 80% in 30 d" value={tileVal(tiles.ifForecast30d)} tone={n0(tiles.ifForecast30d) ? 'warn' : 'ok'} sub="estimate from daily peaks" loading={loading} />
          <StatCard icon={Repeat} label="Peers flapping" value={tileVal(tiles.peersFlapping)} tone={n0(tiles.peersFlapping) ? 'warn' : 'ok'} sub="3+ resets in 7 d" loading={loading} />
          <StatCard icon={RotateCcw} label="Reboots (7 d)" value={tileVal(tiles.reboots7d)} sub="uptime resets" loading={loading} />
        </div>
      )}

      {kindChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-[11px] text-ink-faint mr-1">By kind</span>
          {kindChips.map(([k, n]) => <Badge key={k} tone="neutral">{`${kindLabel(k)} ${fmtNum(n0(n))}`}</Badge>)}
        </div>
      )}

      {loading ? <LoadingPanel label="Loading Cisco devices..." height={200} /> : shapeOk && total === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>
          No devices are classified as Cisco or Meraki yet. They appear after the LogicMonitor inventory tick (every 5 minutes by default) reads a device
          with a Cisco or Meraki enterprise number or matching DataSources. Check the Vendors section on the LogicMonitor Governance page.
        </div>
      ) : shapeOk && (
        <div className="grid xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2">
            <SectionPanel title="Devices, worst first" blurb="Failed devices first, then degraded. A row opens the LogicMonitor device view.">
              {worst.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">The service returned no device rows for this view.</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <TableSearch ctl={ctl} placeholder="Search device, site or reason..." />
                    <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} device(s)</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className={headRow}>
                        <SortTh k="name" label="Device" ctl={ctl} />
                        <SortTh k="kindText" label="Kind" ctl={ctl} />
                        <SortTh k="stateRank" label="State" ctl={ctl} />
                        <SortTh k="reasonText" label="Why" ctl={ctl} />
                        <SortTh k="siteName" label="Site" ctl={ctl} />
                        <SortTh k="openAlerts" label="Open alerts" ctl={ctl} align="right" />
                      </tr></thead>
                      <tbody>
                        {ctl.pageRows.map((r) => (
                          <tr key={`${r.sourceId}-${r.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                            <td className="py-2 pr-3 text-ink text-[12px]">{r.name}</td>
                            <td className="py-2 pr-3"><Badge tone="neutral">{r.kindText}</Badge></td>
                            <td className="py-2 pr-3 text-[12px]">
                              <span className="inline-flex items-center gap-2"><StateDot state={r.state} />{stateWord(r.state)}</span>
                            </td>
                            <td className="py-2 pr-3 text-ink-muted text-[12px] max-w-[320px] truncate" title={r.reasonText}>{r.reasonText || DASH}</td>
                            <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.siteName || r.siteKey || DASH}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.openAlerts)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <TablePager ctl={ctl} />
                </>
              )}
            </SectionPanel>
          </div>
          <div className="flex flex-col gap-4">
            <SectionPanel title="Top open issues" right={(
              <span className="flex items-center gap-1.5">
                {n0(data?.issues?.critical) ? <Badge tone="crit">{`${fmtNum(data.issues.critical)} critical`}</Badge> : null}
                {n0(data?.issues?.warning) ? <Badge tone="warn">{`${fmtNum(data.issues.warning)} warning`}</Badge> : null}
              </span>
            )}>
              <IssuesList issues={data?.topIssues} />
              <Link to="/cisco/issues" className="text-[11px] text-brand hover:underline mt-3 inline-block">All Cisco issues</Link>
            </SectionPanel>
            <SectionPanel title="Open alerts">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={n0(data?.alerts?.critical) ? 'crit' : 'ok'}>{`${fmtNum(n0(data?.alerts?.critical))} critical`}</Badge>
                <Badge tone={n0(data?.alerts?.warning) ? 'warn' : 'ok'}>{`${fmtNum(n0(data?.alerts?.warning))} warning`}</Badge>
                <Link to="/cisco/alerts" className="text-[11px] text-brand hover:underline ml-auto">All Cisco alerts</Link>
              </div>
            </SectionPanel>
          </div>
        </div>
      )}

      {shapeOk && total > 0 && <CiscoFleetSection />}

      {shapeOk && (
        <p className="text-[11px] text-ink-faint mt-4">
          {sources.length
            ? `${SOURCE_NOTE} portal${sources.length === 1 ? '' : 's'} ${sources.map((s) => `${s.name || s.company || s.id}${s.lastPollAt ? ` (last poll ${fmtWhen(s.lastPollAt)})` : ''}`).join(', ')}.`
            : `${SOURCE_NOTE}. No portal rows were returned.`}
          {data?.generatedAt ? ` Generated ${fmtWhen(data.generatedAt)}.` : ''}
        </p>
      )}

      {open && (
        <LmDevice360 deviceId={open.id} sourceId={open.sourceId} onClose={() => setOpen(null)}
          onSwitchDevice={(id) => setOpen((cur) => ({ ...cur, id }))} />
      )}
    </div>
  );
}
