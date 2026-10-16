import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Phone, Download, AlertTriangle, Server, Radio, PhoneCall } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, DASH, arr, fmtNum, stateTone, useVisibleInterval, downloadCsv } from './helpers';
import { SectionPanel, chipBtn, inp } from './ui';
import {
  ServiceTable, StateBadge, PctCell, CountBad, RawState, numOf,
} from './servicesShared';
import LmVoice360 from './LmVoice360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };

const siteCol = { k: 'siteName', label: 'Site', render: (r) => r.siteName || r.siteKey || DASH };
const stateCol = { k: 'stateRank', label: 'State', render: (r) => <StateBadge state={r.state} /> };
const deviceCol = { k: 'deviceName', label: 'Device', render: (r) => <span className="text-ink">{r.deviceName}</span> };
const errCls = (v) => (numOf(v) > 1 ? 'text-status-warn' : 'text-ink-muted');

const SBC_COLUMNS = [
  deviceCol, siteCol,
  { k: 'healthBad', label: 'Health', render: (r) => <RawState raw={r.healthRaw} ok={r.healthBad == null ? null : !r.healthBad} label={r.healthBad ? 'Not healthy' : 'Healthy'} /> },
  { k: 'cpuPct', label: 'CPU', align: 'right', render: (r) => <PctCell v={r.cpuPct} /> },
  { k: 'memPct', label: 'Memory', align: 'right', render: (r) => <PctCell v={r.memPct} /> },
  { k: 'fans', label: 'Fans', render: (r) => <CountBad total={r.fans} bad={r.fansBad} /> },
  { k: 'psus', label: 'Power supplies', render: (r) => <CountBad total={r.psus} bad={r.psusBad} /> },
  { k: 'tempMaxC', label: 'Temp max', align: 'right', render: (r) => (numOf(r.tempMaxC) == null ? DASH : `${r.tempMaxC} C`) },
  { k: 'pools', label: 'Steering pools', render: (r) => (r.pools == null ? DASH : `${fmtNum(r.pools)}${r.poolUtilMaxPct != null ? `, max ${Math.round(r.poolUtilMaxPct)}%` : ''}`) },
  { k: 'retransmissions', label: 'Retrans.', align: 'right', render: (r) => fmtNum(r.retransmissions) },
  stateCol,
];

const CUBE_COLUMNS = [
  deviceCol, siteCol,
  { k: 'model', label: 'Model', render: (r) => r.model || DASH },
  { k: 'sipConnections', label: 'SIP connections', align: 'right', render: (r) => fmtNum(r.sipConnections) },
  { k: 'sipServerErrPerSec', label: 'Server err/s', align: 'right', render: (r) => <span className={`tnum ${errCls(r.sipServerErrPerSec)}`}>{r.sipServerErrPerSec == null ? DASH : r.sipServerErrPerSec}</span> },
  { k: 'sipClientErrPerSec', label: 'Client err/s', align: 'right', render: (r) => <span className={`tnum ${errCls(r.sipClientErrPerSec)}`}>{r.sipClientErrPerSec == null ? DASH : r.sipClientErrPerSec}</span> },
  { k: 'sipRetries', label: 'Invite retries', align: 'right', render: (r) => fmtNum(r.sipRetries) },
  { k: 'isdnBusy', label: 'ISDN busy', align: 'right', render: (r) => fmtNum(r.isdnBusy) },
  stateCol,
];

const GANC_COLUMNS = [
  deviceCol, siteCol,
  { k: 'mobilityRaw', label: 'Mobility check', render: (r) => <RawState raw={r.mobilityRaw} ok={r.mobilityRaw == null ? null : Number(r.mobilityRaw) === 0} label={Number(r.mobilityRaw) === 0 ? 'OK' : undefined} /> },
  { k: 'radiusCheckRaw', label: 'ISE RADIUS check', render: (r) => <RawState raw={r.radiusCheckRaw} ok={r.radiusCheckRaw == null ? null : Number(r.radiusCheckRaw) === 0} label={Number(r.radiusCheckRaw) === 0 ? 'OK' : undefined} /> },
  { k: 'ssids', label: 'SSIDs', align: 'right', render: (r) => fmtNum(r.ssids) },
  { k: 'clients', label: 'Clients', align: 'right', render: (r) => fmtNum(r.clients) },
  { k: 'radiusServers', label: 'RADIUS servers', render: (r) => <CountBad total={r.radiusServers} bad={r.radiusServersDown} /> },
  stateCol,
];

export default function LmVoicePage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState(() => searchParams.get('q') || '');
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/voice')
    .then(({ data }) => { setRows(arr(Array.isArray(data) ? data : data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load voice devices' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => rows || [], [rows]);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all.filter((r) => (!stateFilter || stateTone(r.state) === stateFilter)
      && (!term || [r.deviceName, r.siteName, r.model, r.vendor].some((v) => String(v || '').toLowerCase().includes(term))));
  }, [all, q, stateFilter]);
  const by = (kind) => list.filter((r) => r.kind === kind);
  const attention = all.filter((r) => stateTone(r.state) === 'crit' || stateTone(r.state) === 'warn').length;

  const setState = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('state', v); else next.delete('state');
    setSearchParams(next, { replace: true });
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = {};
      if (q.trim()) params.q = q.trim();
      if (stateFilter) params.state = STATE_PARAM[stateFilter];
      await downloadCsv('/logicmonitor/voice.csv', params, 'logicmonitor-voice');
    } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };

  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';
  const empty = (what) => <p className="text-sm text-ink-muted py-4 text-center">{all.length === 0 ? `No ${what} collected yet. The metrics tier runs every 30 minutes by default; check Settings > Scope > Metric families.` : `No ${what} match.`}</p>;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Phone} title="Voice" description="Oracle session border controllers, Cisco CUBE routers and GANC checks, from the DataSource metrics tier">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Phone} label="Voice devices" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={Server} label="Session border controllers" value={fmtNum(all.filter((r) => r.kind === 'sbc').length)} loading={rows == null} />
        <StatCard icon={PhoneCall} label="CUBE routers" value={fmtNum(all.filter((r) => r.kind === 'cube').length)} loading={rows == null} />
        <StatCard icon={AlertTriangle} label="Need attention" value={fmtNum(attention)} tone={attention ? 'warn' : 'ok'} loading={rows == null} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search device, site or model..." className={`${inp} max-w-[280px]`} spellCheck={false} />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(list.length)} device(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>
      </div>

      {rows == null ? <LoadingPanel label="Loading voice devices..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <SectionPanel icon={Server} title="Session border controllers" blurb="Health, fans and power supplies read the SBC state DataSources; a state of 3 or more counts as not healthy (enum unverified).">
            {by('sbc').length ? <ServiceTable rows={by('sbc')} columns={SBC_COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpen} /> : empty('session border controllers')}
          </SectionPanel>
          <SectionPanel icon={PhoneCall} title="CUBE routers" blurb="SIP error rates come from counter history over the last 3 hours; over 1 per second raises voice-sip-errors.">
            {by('cube').length ? <ServiceTable rows={by('cube')} columns={CUBE_COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpen} /> : empty('CUBE routers')}
          </SectionPanel>
          <SectionPanel icon={Radio} title="GANC" blurb="The mobility domain and ISE RADIUS checks follow the NTM convention of 0 = ok (unverified); SSIDs and RADIUS servers come from the WLC DataSources when the GANC carries them.">
            {by('ganc').length ? <ServiceTable rows={by('ganc')} columns={GANC_COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpen} /> : empty('GANC devices')}
          </SectionPanel>
        </div>
      )}
      <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><AlertTriangle size={11} /> Datapoint names and state enums are unverified until the first live poll; raw values show next to every flag.</p>

      {open && <LmVoice360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
