import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cloud, Download, AlertTriangle, PlugZap, Server, MapPin } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import {
  BRAND, DASH, fmtNum, fmtMs, fmtPct, fmtWhen, stateTone, anomalyTone, useVisibleInterval, downloadCsv,
} from './helpers';
import { SectionPanel, Modal, chipBtn, inp } from './ui';
import {
  ServiceTable, StateBadge, PctCell, RawState, numOf,
} from './servicesShared';
import LmDevice360 from './LmDevice360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };

const siteCol = { k: 'siteName', label: 'Site', render: (r) => r.siteName || r.siteKey || DASH };
const stateCol = { k: 'stateRank', label: 'State', render: (r) => <StateBadge state={r.state} /> };
const deviceCol = { k: 'deviceName', label: 'Device', render: (r) => <span className="text-ink">{r.deviceName}</span> };

const CONNECTOR_COLUMNS = [
  deviceCol, siteCol,
  { k: 'connectorDown', label: 'Connector', render: (r) => <RawState raw={r.connectorRaw} ok={r.connectorRaw == null ? null : !r.connectorDown} label={r.connectorDown ? 'Down' : 'Up'} badTone="crit" /> },
  { k: 'portUsedPct', label: 'Ports used', align: 'right', render: (r) => <PctCell v={r.portUsedPct} warn={80} /> },
  { k: 'ntpOffset', label: 'NTP offset', align: 'right', render: (r) => (numOf(r.ntpOffset) == null ? DASH : `${r.ntpOffset} s`) },
  { k: 'hostStatus', label: 'Host', render: (r) => r.hostStatus || DASH },
  stateCol,
];

const NSS_COLUMNS = [
  deviceCol, siteCol,
  { k: 'model', label: 'Model', render: (r) => r.model || DASH },
  { k: 'cpuPct', label: 'CPU', align: 'right', render: (r) => <PctCell v={r.cpuPct} /> },
  { k: 'memPct', label: 'Memory', align: 'right', render: (r) => <PctCell v={r.memPct} /> },
  { k: 'fsUsedMaxPct', label: 'Fullest filesystem', align: 'right', render: (r) => <PctCell v={r.fsUsedMaxPct} /> },
  { k: 'filesystems', label: 'Filesystems', align: 'right', render: (r) => fmtNum(r.filesystems) },
  stateCol,
];

const DC_COLUMNS = [
  { k: 'city', label: 'Data centre', render: (r) => <span className="text-ink">{r.city}</span> },
  { k: 'codes', label: 'Codes', render: (r) => r.codes },
  { k: 'checks', label: 'Checks', align: 'right', render: (r) => fmtNum(r.checks) },
  { k: 'rttAvgMs', label: 'RTT avg', align: 'right', render: (r) => fmtMs(r.rttAvgMs) },
  { k: 'rttMaxMs', label: 'RTT max', align: 'right', render: (r) => fmtMs(r.rttMaxMs) },
  { k: 'lossMaxPct', label: 'Loss max', align: 'right', render: (r) => <span className={`tnum ${r.lossMaxPct ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtPct(r.lossMaxPct, 1)}</span> },
  { k: 'episodeState', label: 'Latest episode', render: (r) => (r.episodeState ? <Badge tone={r.episodeState === 'critical' ? 'crit' : r.episodeState === 'closed' ? 'neutral' : 'warn'}>{r.episodeState}</Badge> : <span className="text-ink-faint">{DASH}</span>) },
  stateCol,
];

function DataCenterModal({ dc, onClose }) {
  return (
    <Modal icon={MapPin} title={`${dc.city} data centre`} subtitle={`${dc.codes} - ${dc.checks} uptime check(s)`} onClose={onClose} width="max-w-3xl">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <th className="py-2 pr-3">Check</th><th className="py-2 pr-3">Target</th><th className="py-2 pr-3 text-right">RTT</th>
            <th className="py-2 pr-3 text-right">Baseline</th><th className="py-2 pr-3 text-right">Loss</th><th className="py-2 pr-3">Episode</th><th className="py-2 pr-3">State</th>
          </tr></thead>
          <tbody>
            {dc.items.map((i) => (
              <tr key={`${i.sourceId}-${i.checkId}`} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink text-[12px]">{i.name}</td>
                <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{i.target || DASH}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtMs(i.rttAvgMs)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-faint text-[12px]">{fmtMs(i.baselineRttMs)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtPct(i.lossMaxPct, 1)}</td>
                <td className="py-1.5 pr-3 text-[12px] text-ink-muted">{i.episodeState ? `${i.episodeState}${i.episodeOpenedAt ? `, ${fmtWhen(i.episodeOpenedAt)}` : ''}` : DASH}</td>
                <td className="py-1.5 pr-3"><Badge tone={anomalyTone(i.anomaly, i.state === 'down' ? 'down' : i.state)}>{i.anomaly || i.state}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-faint mt-3">Open the Site Reachability page to see each check from every collector location.</p>
    </Modal>
  );
}

export default function LmZscalerPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [openDevice, setOpenDevice] = useState(null);
  const [openDc, setOpenDc] = useState(null);
  const [q, setQ] = useState(() => searchParams.get('q') || '');
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/zscaler')
    .then(({ data: d }) => { setData({ connectors: d?.connectors || [], nss: d?.nss || [], dataCenters: d?.dataCenters || [] }); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || { connectors: [], nss: [], dataCenters: [] }); toast({ type: 'error', title: 'Failed to load Zscaler data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const term = q.trim().toLowerCase();
  const view = useMemo(() => {
    const d = data || { connectors: [], nss: [], dataCenters: [] };
    const okState = (r) => !stateFilter || stateTone(r.state) === stateFilter;
    const hit = (r) => !term || [r.deviceName, r.siteName, r.city, r.codes].some((v) => String(v || '').toLowerCase().includes(term));
    return {
      connectors: d.connectors.filter((r) => okState(r) && hit(r)),
      nss: d.nss.filter((r) => okState(r) && hit(r)),
      dataCenters: d.dataCenters.filter((r) => okState(r) && hit(r)),
    };
  }, [data, term, stateFilter]);

  const setState = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('state', v); else next.delete('state');
    setSearchParams(next, { replace: true });
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = {};
      if (stateFilter) params.state = STATE_PARAM[stateFilter];
      await downloadCsv('/logicmonitor/zscaler.csv', params, 'logicmonitor-zscaler');
    } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };

  const loading = data == null;
  const d = data || { connectors: [], nss: [], dataCenters: [] };
  const down = d.connectors.filter((c) => c.connectorDown).length;
  const dcBad = d.dataCenters.filter((x) => stateTone(x.state) !== 'ok').length;
  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';
  const empty = (what) => <p className="text-sm text-ink-muted py-4 text-center">{`No ${what} found. They appear once the metrics tier has read the Zscaler DataSources, or a check named ZSDC_<code>-<city> exists.`}</p>;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cloud} title="Zscaler" description="ZPA app connectors, NSS log appliances and the ZSDC data centre uptime checks">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={PlugZap} label="ZPA connectors" value={fmtNum(d.connectors.length)} loading={loading} />
        <StatCard icon={AlertTriangle} label="Connectors down" value={fmtNum(down)} tone={down ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={Server} label="NSS appliances" value={fmtNum(d.nss.length)} loading={loading} />
        <StatCard icon={MapPin} label="Data centres" value={fmtNum(d.dataCenters.length)} tone={dcBad ? 'warn' : 'ok'} sub={dcBad ? `${fmtNum(dcBad)} need attention` : undefined} loading={loading} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search device, site or city..." className={`${inp} max-w-[280px]`} spellCheck={false} />
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>
      </div>

      {loading ? <LoadingPanel label="Loading Zscaler data..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <SectionPanel icon={PlugZap} title="ZPA app connectors" blurb="Connector state is read against the estate majority because the DataSource enum is unverified; ports used raises zpa-port-exhaustion at the firewall session threshold.">
            {view.connectors.length ? <ServiceTable rows={view.connectors} columns={CONNECTOR_COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpenDevice} /> : empty('ZPA connectors')}
          </SectionPanel>
          <SectionPanel icon={Server} title="NSS appliances" blurb="CPU and memory come from the Net-SNMP health DataSources, filesystems from the server OS family when present.">
            {view.nss.length ? <ServiceTable rows={view.nss} columns={NSS_COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpenDevice} /> : empty('NSS appliances')}
          </SectionPanel>
          <SectionPanel icon={MapPin} title="Zscaler data centres" blurb="Every ZSDC_ uptime check grouped by city. Click a row for the individual checks.">
            {view.dataCenters.length ? <ServiceTable rows={view.dataCenters} columns={DC_COLUMNS} rowKey={(r) => r.city} onOpen={setOpenDc} /> : empty('ZSDC checks')}
          </SectionPanel>
        </div>
      )}

      {openDevice && <LmDevice360 deviceId={openDevice.deviceId} sourceId={openDevice.sourceId} onClose={() => setOpenDevice(null)} />}
      {openDc && <DataCenterModal dc={openDc} onClose={() => setOpenDc(null)} />}
    </div>
  );
}
