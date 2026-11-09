import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Gauge, Server, ShieldAlert, AlertTriangle, CheckCircle2, Layers, CalendarClock, Repeat, Cpu, TrendingUp, Split, RotateCcw,
} from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, fmtWhen, DASH, arr } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { IssuesList } from '../logicmonitor/kit360';
import { StateDot, stateBadgeTone, stateWord, stateRankOf } from '../logicmonitor/groupTree';
import LmDevice360 from '../logicmonitor/LmDevice360';
import { BRAND, SOURCE_NOTE, OLDER_VERSION, kindLabel, rowsOf, useF5Get } from './f5Shared';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function F5OverviewPage() {
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/overview', 'the F5 overview');
  const navigate = useNavigate();
  const [open, setOpen] = useState(null);

  const shapeOk = !!data && data.devices && typeof data.devices === 'object';
  const dev = shapeOk ? data.devices : {};
  const pools = data?.pools || {};
  const certs = data?.certs || {};
  const failover = data?.failover || {};
  const daemons = data?.daemons || {};
  const tiles = data?.tiles || {};
  const sources = arr(data?.sources);
  const total = n0(dev.total);

  const worst = useMemo(() => (rowsOf(data?.devicesWorstFirst) || []).map((r) => ({
    ...r,
    name: r.displayName || r.name || '',
    stateRank: stateRankOf(r.state),
    reasonText: Array.isArray(r.reasons) ? r.reasons.join('; ') : (r.reasons || ''),
  })), [data]);
  const ctl = useTableControls(worst, {
    searchKeys: ['name', 'siteName', 'model', 'vendorKind', 'reasonText'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true, defaultPageSize: 10, deepLink: false,
  });

  const kinds = [
    dev.bigip ? `${fmtNum(dev.bigip)} BIG-IP` : null,
    dev.gtm ? `${fmtNum(dev.gtm)} GTM` : null,
    dev.f5os ? `${fmtNum(dev.f5os)} F5OS` : null,
  ].filter(Boolean).join(', ');

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="F5 Overview" description="BIG-IP, GTM and F5OS devices, read from the LogicMonitor portals that monitor them">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>

      {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
      {!error && !loading && !shapeOk && <p className="text-sm text-status-warn mb-3">{OLDER_VERSION}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Server} label="Devices" value={fmtNum(total)} sub={kinds || undefined} loading={loading} />
        <StatCard icon={ShieldAlert} label="Failed" value={fmtNum(n0(dev.failed))} tone={n0(dev.failed) ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={AlertTriangle} label="Degraded" value={fmtNum(n0(dev.degraded))} tone={n0(dev.degraded) ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={CheckCircle2} label="Operational" value={fmtNum(n0(dev.ok))} tone="ok" loading={loading} />
        <StatCard icon={Layers} label="Pools degraded" value={fmtNum(n0(pools.degraded))} tone={n0(pools.degraded) ? 'warn' : 'ok'} sub={`${fmtNum(n0(pools.total))} pools`} loading={loading} />
        <StatCard icon={CalendarClock} label="Certs expiring" value={fmtNum(n0(certs.expiring30))} tone={n0(certs.expiring30) ? 'warn' : 'ok'} sub={`within 30 days, ${fmtNum(n0(certs.expiring90))} within 90`} loading={loading} />
        <StatCard icon={Repeat} label="Failover" value={`${fmtNum(n0(failover.active))} active`} tone={n0(failover.degraded) ? 'warn' : 'ok'} sub={`${fmtNum(n0(failover.standby))} standby, ${fmtNum(n0(failover.degraded))} degraded`} loading={loading} />
        <StatCard icon={Cpu} label="Daemons down" value={fmtNum(n0(daemons.down))} tone={n0(daemons.down) ? 'crit' : 'ok'} loading={loading} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Repeat} label="HA pairs at risk" value={tiles.haPairsAtRisk == null ? '-' : fmtNum(tiles.haPairsAtRisk)} tone={tiles.haPairsAtRisk ? 'crit' : 'ok'} sub="both or neither active, no headroom" loading={loading} onClick={() => navigate('/f5/ha')} />
        <StatCard icon={CalendarClock} label="Certs under 30 d" value={tiles.certs30dDeduped == null ? '-' : fmtNum(tiles.certs30dDeduped)} tone={tiles.certs30dDeduped ? 'warn' : 'ok'} sub="counted once per certificate" loading={loading} onClick={() => navigate('/f5/certificates')} />
        <StatCard icon={TrendingUp} label="CPU to 80% in 30 d" value={tiles.cpuForecast30d == null ? '-' : fmtNum(tiles.cpuForecast30d)} tone={tiles.cpuForecast30d ? 'warn' : 'ok'} sub="linear-fit estimate" loading={loading} onClick={() => navigate('/f5/trends')} />
        <StatCard icon={Split} label="Pools, single point of failure" value={tiles.poolsSpof == null ? '-' : fmtNum(tiles.poolsSpof)} tone={tiles.poolsSpof ? 'warn' : 'ok'} loading={loading} onClick={() => navigate('/f5/pools')} />
        <StatCard icon={RotateCcw} label="Daemon flaps, 7 d" value={tiles.daemonFlaps7d == null ? '-' : fmtNum(tiles.daemonFlaps7d)} tone={tiles.daemonFlaps7d ? 'warn' : 'ok'} loading={loading} onClick={() => navigate('/f5/stability')} />
      </div>

      {loading ? <LoadingPanel label="Loading F5 devices..." height={200} /> : shapeOk && total === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>
          No devices are classified as F5 yet. They appear after the LogicMonitor inventory tick (every 5 minutes by default) reads a device
          with an F5 enterprise number or F5 DataSources. Check the Vendors section on the LogicMonitor Governance page.
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
                        <SortTh k="vendorKind" label="Kind" ctl={ctl} />
                        <SortTh k="stateRank" label="State" ctl={ctl} />
                        <SortTh k="reasonText" label="Why" ctl={ctl} />
                        <SortTh k="siteName" label="Site" ctl={ctl} />
                        <SortTh k="openAlerts" label="Open alerts" ctl={ctl} align="right" />
                      </tr></thead>
                      <tbody>
                        {ctl.pageRows.map((r) => (
                          <tr key={`${r.sourceId}-${r.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                            <td className="py-2 pr-3 text-ink text-[12px]">{r.name}</td>
                            <td className="py-2 pr-3"><Badge tone="neutral">{kindLabel(r.vendorKind)}</Badge></td>
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
              <Link to="/f5/issues" className="text-[11px] text-brand hover:underline mt-3 inline-block">All F5 issues</Link>
            </SectionPanel>
            <SectionPanel title="Open alerts">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={n0(data?.alerts?.critical) ? 'crit' : 'ok'}>{`${fmtNum(n0(data?.alerts?.critical))} critical`}</Badge>
                <Badge tone={n0(data?.alerts?.warning) ? 'warn' : 'ok'}>{`${fmtNum(n0(data?.alerts?.warning))} warning`}</Badge>
                <Link to="/f5/alerts" className="text-[11px] text-brand hover:underline ml-auto">All F5 alerts</Link>
              </div>
            </SectionPanel>
          </div>
        </div>
      )}

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
