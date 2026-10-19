import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { MapPin, Sparkles } from 'lucide-react';
import client from '../../api/client';
import AdvisorReportModal from '../../components/AdvisorReportModal';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, arr, fmtNum, fmtPct, fmtMs, fmtWhen, hostStatusTone, hostStatusLabel, severityTone, titleCase,
  stateTone, stateLabel, stateRank, worstState, blameText, useVisibleInterval,
} from './helpers';
import { Modal, Tabs, Fact, headRow, SortThTip } from './ui';
import EndpointsTable from './endpointsTable';
import LmDevice360 from './LmDevice360';

const REFRESH_MS = 60000;

function StateBadge({ state }) {
  return <Badge tone={stateTone(state)}>{stateLabel(state)}</Badge>;
}

function circuitSummary(circuits) {
  const list = arr(circuits);
  if (!list.length) return { state: null, p95: null };
  const worst = worstState(list.map((c) => c.state));
  const p95 = Math.max(...list.map((c) => Math.max(Number(c.p95InPct) || 0, Number(c.p95OutPct) || 0)));
  return { state: worst, p95 };
}

function collectorName(c, siteKey) {
  if (c.id != null && Number(c.id) < 0) return <span className="text-ink-muted">LogicMonitor cloud</span>;
  return (
    <span className={c.isDown ? 'text-status-crit' : 'text-ink-muted'}>
      {c.hostname}
      {c.isDown ? ' (down)' : ''}
      {c.siteKey && c.siteKey !== siteKey ? <span className="text-ink-faint"> (remote)</span> : null}
    </span>
  );
}

function CollectorCell({ site }) {
  const polling = arr(site.pollingCollectors);
  if (polling.length) {
    const shown = polling.slice(0, 2);
    return (
      <div className="flex flex-col">
        {shown.map((c) => <span key={c.id} className="truncate max-w-[200px]" title={c.hostname}>{collectorName(c, site.siteKey)}</span>)}
        {polling.length > shown.length ? <span className="text-[10px] text-ink-faint">{`and ${polling.length - shown.length} more`}</span> : null}
      </div>
    );
  }
  const own = arr(site.collectors);
  if (!own.length) return <span className="text-ink-faint">-</span>;
  return <span className={site.collectorsDown ? 'text-status-crit' : 'text-ink-muted'}>{site.collectorsDown ? `${site.collectorsDown} down` : 'Up'}</span>;
}

function ReachList({ rows, empty }) {
  if (!rows.length) return <p className="text-sm text-ink-muted py-4 text-center">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className={headRow}>
          <th className="py-1.5 pr-3">Check</th><th className="py-1.5 pr-3">From</th><th className="py-1.5 pr-3">State</th>
          <th className="py-1.5 pr-3 text-right">RTT</th><th className="py-1.5 pr-3 text-right">Loss</th><th className="py-1.5 pr-3">Anomaly</th><th className="py-1.5 pr-3">Likely hop</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 text-ink text-[12px]">{r.checkName || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{r.fromLabel || r.label || '-'}</td>
              <td className="py-1.5 pr-3"><StateBadge state={r.state} /></td>
              <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtMs(r.rttAvgMs)}</td>
              <td className={`py-1.5 pr-3 text-right tnum ${r.lossPct ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtPct(r.lossPct, 1)}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{r.anomaly || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{blameText(r.blame) || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SiteModal({ siteKey, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('devices');
  const [device, setDevice] = useState(null);
  const [advisor, setAdvisor] = useState(null); // { enabled } once loaded
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [briefReport, setBriefReport] = useState(null);

  useEffect(() => {
    setAdvisor(null); setShowAdvisor(false); setBriefReport(null);
    client.get(`/logicmonitor/advisor/site-brief/${encodeURIComponent(siteKey)}`)
      .then(({ data: d }) => { setAdvisor({ enabled: d?.enabled !== false }); setBriefReport(d?.report || null); })
      .catch(() => client.get('/logicmonitor/advisor/reports')
        .then(({ data: d }) => setAdvisor({ enabled: d?.enabled !== false }))
        .catch(() => setAdvisor({ enabled: false })));
  }, [siteKey]);

  const [watch, setWatch] = useState(null);
  useEffect(() => {
    setWatch(null);
    client.get('/logicmonitor/watch/summary', { params: { siteKey, days: 7 } }).then(({ data: d }) => setWatch(d || null)).catch(() => setWatch(null));
  }, [siteKey]);

  useEffect(() => {
    setData(null); setError(null); setTab('devices');
    client.get(`/logicmonitor/sites/${encodeURIComponent(siteKey)}`)
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Site not found.' : 'Failed to load the site.'));
  }, [siteKey]);

  const devices = arr(data?.devices);
  const ifDown = arr(data?.interfacesDown);
  const circuits = arr(data?.circuits);
  const reachIn = arr(data?.reachabilityIn);
  const reachOut = arr(data?.reachabilityOut);
  const endpoints = arr(data?.endpoints);
  const issues = arr(data?.openIssues);
  const changes = arr(data?.recentChanges);
  const pick = (r, a, b) => r[a] ?? r[b];

  return (
    <Modal icon={MapPin} title={data?.siteName || siteKey} subtitle={data?.source ? `Site derived from ${data.source}` : 'Site 360'} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading site..." height={200} /> : (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <StateBadge state={data.state} />
            {data.devicesDead ? <Badge tone="crit">{fmtNum(data.devicesDead)} dead</Badge> : null}
            {ifDown.length ? <Badge tone="warn">{fmtNum(ifDown.length)} interface(s) down</Badge> : null}
            <button type="button" disabled={advisor?.enabled !== true} onClick={() => setShowAdvisor(true)}
              title={advisor?.enabled === true ? 'AI brief for this site' : 'AI analysis is not configured. Pick a provider under Global Settings, AI.'}
              className="ml-auto flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              <Sparkles size={13} /> Site brief
            </button>
          </div>
          {data.correlation && typeof data.correlation === 'object' && (
            <p className="text-[11px] text-ink-muted mb-3">
              <Link to="/logicmonitor/correlation" className="text-brand hover:underline">Correlation</Link>
              {`: ${fmtNum(data.correlation.backupLoad || 0)} backup windows, ${fmtNum(data.correlation.replication || 0)} replication, ${fmtNum(data.correlation.changes || 0)} changes, ${fmtNum(data.correlation.blames || 0)} blames`}
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-4">
            <Fact label="Devices">{fmtNum(data.deviceCount)}</Fact>
            <Fact label="Network devices">{fmtNum(data.networkCount)}</Fact>
            <Fact label="Servers">{fmtNum(data.servers)}</Fact>
            <Fact label="Collectors">{arr(data.collectors).map((c) => `${c.hostname}${c.isDown ? ' (down)' : ''}`).join(', ') || '-'}</Fact>
            <Fact label="Polled by">{arr(data.pollingCollectors).map((c) => `${c.hostname}${c.isDown ? ' (down)' : ''} x${fmtNum(c.devices)}`).join(', ') || '-'}</Fact>
            <Fact label="Circuits">{circuits.length ? `${circuits.length}` : '-'}</Fact>
            <Fact label="Site key">{data.siteKey || siteKey}</Fact>
          </div>
          {watch && (
            <p className="text-[11px] text-ink-muted mb-3" data-testid="site-episodes">
              <span className="text-ink-faint uppercase tracking-wide text-[10px] mr-2">Episodes (7 days)</span>
              {`${watch.closed?.oneOff || 0} one-off, ${watch.closed?.sustained || 0} sustained, ${watch.closed?.escalated || 0} escalated; ${watch.repeating || 0} repeating check${watch.repeating === 1 ? '' : 's'}`}
              {(watch.open?.watching || watch.open?.degrading || watch.open?.critical) ? `. Open now: ${watch.open.watching || 0} watching, ${watch.open.degrading || 0} degrading, ${watch.open.critical || 0} critical` : ''}
            </p>
          )}
          <Tabs active={tab} onSelect={setTab} tabs={[
            { key: 'devices', label: 'Devices', count: devices.length },
            { key: 'circuits', label: 'Circuits', count: circuits.length },
            { key: 'reach', label: 'Reachability', count: reachIn.length + reachOut.length },
            { key: 'endpoints', label: 'Endpoints', count: endpoints.length },
            { key: 'issues', label: 'Issues', count: issues.length },
            { key: 'changes', label: 'Changes', count: changes.length },
          ]} />

          {tab === 'devices' && (
            <>
              {devices.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No devices at this site.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className={headRow}>
                      <th className="py-1.5 pr-3">Device</th><th className="py-1.5 pr-3">Role</th><th className="py-1.5 pr-3">Vendor</th>
                      <th className="py-1.5 pr-3">Model</th><th className="py-1.5 pr-3">Status</th><th className="py-1.5 pr-3 text-right">Interfaces up</th>
                    </tr></thead>
                    <tbody>
                      {devices.map((d) => (
                        <tr key={`${d.sourceId}-${d.id}`} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay" onClick={() => d.id && setDevice({ id: d.id, sourceId: d.sourceId })}>
                          <td className="py-1.5 pr-3 text-ink text-[12px]">{d.displayName || d.name}</td>
                          <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{d.role ? titleCase(d.role) : '-'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{d.vendor || '-'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{d.model || '-'}</td>
                          <td className="py-1.5 pr-3"><Badge tone={hostStatusTone(d.hostStatus)}>{hostStatusLabel(d.hostStatus)}</Badge></td>
                          <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{d.ifCount != null ? `${fmtNum(d.ifUp)} / ${fmtNum(d.ifCount)}` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {ifDown.length > 0 && (
                <div className="mt-4">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Interfaces down</p>
                  <table className="w-full text-sm">
                    <thead><tr className={headRow}><th className="py-1.5 pr-3">Device</th><th className="py-1.5 pr-3">Interface</th><th className="py-1.5 pr-3">Description</th></tr></thead>
                    <tbody>
                      {ifDown.map((i, k) => (
                        <tr key={k} className="border-b border-cohesity-border/40">
                          <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{i.deviceName}</td>
                          <td className="py-1.5 pr-3 text-ink text-[12px]">{i.displayName || i.port}</td>
                          <td className="py-1.5 pr-3 text-ink-faint text-[11px]">{i.description || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'circuits' && (circuits.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No WAN circuits at this site.</p> : (
            <table className="w-full text-sm">
              <thead><tr className={headRow}><th className="py-1.5 pr-3">Device</th><th className="py-1.5 pr-3">Port</th><th className="py-1.5 pr-3">State</th><th className="py-1.5 pr-3 text-right">p95 in</th><th className="py-1.5 pr-3 text-right">p95 out</th></tr></thead>
              <tbody>
                {circuits.map((c, i) => (
                  <tr key={i} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink text-[12px]">{c.deviceName}</td>
                    <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{c.port}</td>
                    <td className="py-1.5 pr-3"><StateBadge state={c.state} /></td>
                    <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(c.p95InPct)}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(c.p95OutPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

          {tab === 'reach' && (
            <>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Checks that reach this site</p>
              <ReachList rows={reachIn} empty="No checks target this site." />
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mt-4 mb-1">Checks run from this site</p>
              <ReachList rows={reachOut} empty="No checks run from this site's collector." />
            </>
          )}

          {tab === 'endpoints' && (
            <EndpointsTable rows={endpoints} onDevice={(id, sid) => id && setDevice({ id, sourceId: sid || null })}
              emptyText="No servers or appliances matched to this site's switch ports." />
          )}

          {tab === 'issues' && (issues.length === 0 ? <p className="text-sm text-status-ok py-4 text-center">No open issues at this site.</p> : (
            <div className="flex flex-col gap-2">
              {issues.map((i, k) => (
                <div key={k} className="bg-surface-overlay rounded-lg px-3 py-2">
                  <span className="flex items-center gap-2 mb-0.5">
                    <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                    <span className="text-[11px] text-ink-faint">{titleCase(i.type)}</span>
                    {i.target && <span className="text-xs text-ink truncate ml-auto max-w-[260px]" title={i.target}>{i.target}</span>}
                  </span>
                  <p className="text-xs text-ink-muted leading-snug">{i.message}</p>
                </div>
              ))}
            </div>
          ))}

          {tab === 'changes' && (changes.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No configuration changes in the last 7 days.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}><th className="py-1.5 pr-3">Detected</th><th className="py-1.5 pr-3">Scope</th><th className="py-1.5 pr-3">Item</th><th className="py-1.5 pr-3">Change</th><th className="py-1.5 pr-3">Detail</th></tr></thead>
                <tbody>
                  {changes.map((r, i) => {
                    const oldV = pick(r, 'oldValue', 'old_value');
                    const newV = pick(r, 'newValue', 'new_value');
                    return (
                      <tr key={r.id ?? i} className="border-b border-cohesity-border/40">
                        <td className="py-1.5 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(pick(r, 'detectedAt', 'detected_at'))}</td>
                        <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{r.scope}</td>
                        <td className="py-1.5 pr-3 text-ink text-[12px]">{r.item}</td>
                        <td className="py-1.5 pr-3"><Badge tone="neutral">{pick(r, 'changeType', 'change_type')}</Badge></td>
                        <td className="py-1.5 pr-3"><span className="font-mono text-[10px] break-all line-clamp-2" title={`${oldV || ''}\n->\n${newV || ''}`}>{oldV ? `${oldV} -> ` : ''}{newV || '(removed)'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
      {showAdvisor && createPortal(
        <AdvisorReportModal
          tab={{ slug: encodeURIComponent(siteKey), label: `Site brief: ${data?.siteName || siteKey}`, icon: Sparkles, subject: data?.siteName || siteKey }}
          basePath="/logicmonitor/advisor/site-brief"
          initialReport={briefReport}
          enabled={advisor?.enabled === true}
          autoRun={false}
          onClose={() => setShowAdvisor(false)}
          onUpdated={(r) => setBriefReport(r)}
        />,
        document.body
      )}
      {device && <LmDevice360 deviceId={device.id} sourceId={device.sourceId} onClose={() => setDevice(null)} onSwitchDevice={(id) => setDevice((cur) => ({ id, sourceId: cur?.sourceId || null }))} />}
    </Modal>
  );
}

export default function LmSitesPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const openSite = searchParams.get('site');

  const load = useCallback(() => client.get('/logicmonitor/sites')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load sites' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const list = useMemo(() => (rows || []).map((s) => {
    const cs = circuitSummary(s.circuits);
    const collectors = arr(s.collectors);
    return {
      ...s,
      stateRank: stateRank(s.state),
      circuitState: cs.state,
      circuitRank: stateRank(cs.state),
      circuitP95: cs.p95,
      collectorsDown: (arr(s.pollingCollectors).length ? arr(s.pollingCollectors) : collectors).filter((c) => c.isDown).length,
      collectorLabel: (arr(s.pollingCollectors).length ? arr(s.pollingCollectors) : collectors).map((c) => c.hostname).join(', '),
      polling: arr(s.pollingCollectors),
      reachInState: worstState(arr(s.reachabilityIn).map((r) => r.state)),
      reachOutState: worstState(arr(s.reachabilityOut).map((r) => r.state)),
    };
  }), [rows]);

  const ctl = useTableControls(list, {
    searchKeys: ['siteName', 'siteKey', 'collectorLabel'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
    sortValues: { reachInState: (r) => stateRank(r.reachInState), reachOutState: (r) => stateRank(r.reachOutState) },
  });

  const setSite = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key) next.set('site', key); else next.delete('site');
    setSearchParams(next, { replace: true });
  };

  const loading = rows == null;
  const crit = list.filter((s) => stateTone(s.state) === 'crit').length;
  const warn = list.filter((s) => stateTone(s.state) === 'warn').length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={MapPin} title="Sites" description="Every site derived from device groups, properties and hostnames, with devices, circuits, collectors and reachability rolled up">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={MapPin} label="Sites" value={fmtNum(list.length)} loading={loading} />
        <StatCard icon={MapPin} label="Critical" value={fmtNum(crit)} tone={crit ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={MapPin} label="Warning" value={fmtNum(warn)} tone={warn ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={MapPin} label="Healthy" value={fmtNum(list.length - crit - warn)} tone="ok" loading={loading} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {loading ? <LoadingPanel label="Loading sites..." height={200} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sites derived yet. Sites come from device groups under Network, Sites, Locations or Branch, a site property, or the hostname prefix. Set the rules under Settings, Scope.</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <TableSearch ctl={ctl} placeholder="Search site or collector..." />
              <FilterSelect ctl={ctl} k="source" rows={list} label="sources" />
              <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} site(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="siteName" label="Site" ctl={ctl} />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                  <SortTh k="deviceCount" label="Devices" ctl={ctl} align="right" />
                  <SortTh k="devicesDead" label="Dead" ctl={ctl} align="right" />
                  <SortTh k="interfacesDown" label="Ifaces down" ctl={ctl} align="right" />
                  <SortTh k="circuitRank" label="Circuits" ctl={ctl} />
                  <SortThTip k="collectorsDown" label="Collector" ctl={ctl} tip="The collector that polls this site's devices. Remote means it sits at another site." />
                  <SortThTip k="reachInState" label="Reach in" ctl={ctl} tip="Checks whose target is a device at this site, worst location" />
                  <SortThTip k="reachOutState" label="Reach out" ctl={ctl} tip="Internal checks run from a collector at this site" />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((s) => (
                    <tr key={s.siteKey} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setSite(s.siteKey)}>
                      <td className="py-2 pr-3"><p className="text-ink">{s.siteName || s.siteKey}</p><p className="text-[10px] text-ink-faint">{s.siteKey}{s.source ? ` - ${s.source}` : ''}</p></td>
                      <td className="py-2 pr-3"><StateBadge state={s.state} /></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(s.deviceCount)}<p className="text-[10px] text-ink-faint">{fmtNum(s.networkCount)} network</p></td>
                      <td className={`py-2 pr-3 text-right tnum ${s.devicesDead ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtNum(s.devicesDead)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${s.interfacesDown ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(s.interfacesDown)}</td>
                      <td className="py-2 pr-3">{s.circuitState ? <><StateBadge state={s.circuitState} /><p className="text-[10px] text-ink-faint tnum">p95 {fmtPct(s.circuitP95)}</p></> : <span className="text-[11px] text-ink-faint">-</span>}</td>
                      <td className="py-2 pr-3 text-[12px]"><CollectorCell site={s} /></td>
                      <td className="py-2 pr-3">{s.reachInState ? <StateBadge state={s.reachInState} /> : <span className="text-[11px] text-ink-faint">-</span>}</td>
                      <td className="py-2 pr-3">{s.reachOutState ? <StateBadge state={s.reachOutState} /> : <span className="text-[11px] text-ink-faint">-</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {openSite && <SiteModal siteKey={openSite} onClose={() => setSite(null)} />}
    </div>
  );
}
