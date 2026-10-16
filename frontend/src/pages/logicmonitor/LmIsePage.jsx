import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Fingerprint, Download, AlertTriangle, Server, Users, CalendarClock } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, DASH, arr, fmtNum, stateTone, useVisibleInterval, downloadCsv } from './helpers';
import { SectionPanel, chipBtn, inp } from './ui';
import {
  ServiceTable, StateBadge, PctCell, RawState, numOf,
} from './servicesShared';
import LmIse360 from './LmIse360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };
const CERT_WARN_DAYS = 30; // display tint only; the issue threshold is lm_cert_warn_days

const COLUMNS = [
  { k: 'deviceName', label: 'Node', render: (r) => <span className="text-ink">{r.deviceName}</span> },
  { k: 'siteName', label: 'Site', render: (r) => r.siteName || r.siteKey || DASH },
  { k: 'sessions', label: 'Sessions', align: 'right', render: (r) => fmtNum(r.sessions) },
  { k: 'cpuPct', label: 'CPU', align: 'right', render: (r) => <PctCell v={r.cpuPct} /> },
  { k: 'memPct', label: 'Memory', align: 'right', render: (r) => <PctCell v={r.memPct} warn={90} /> },
  { k: 'diskUsedMaxPct', label: 'Fullest disk', align: 'right', render: (r) => <PctCell v={r.diskUsedMaxPct} /> },
  { k: 'appStateRaw', label: 'Application', render: (r) => <RawState raw={r.appStateRaw} ok={r.appStateRaw == null ? null : !r.appDown} label={r.appDown ? 'Down' : 'Running'} badTone="crit" /> },
  {
    k: 'certDaysMin', label: 'Certificate days left', align: 'right',
    render: (r) => (numOf(r.certDaysMin) == null ? DASH : <span className={`tnum ${r.certDaysMin < CERT_WARN_DAYS ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(r.certDaysMin)}</span>),
  },
  { k: 'nodes', label: 'Deployment', render: (r) => (r.nodes ? <RawState raw={r.nodeStateRaw} ok={!r.nodesDown} label={r.nodesDown ? `${fmtNum(r.nodesDown)} down` : 'In sync'} badTone="crit" /> : DASH) },
  { k: 'stateRank', label: 'State', render: (r) => <StateBadge state={r.state} /> },
];

export default function LmIsePage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState(() => searchParams.get('q') || '');
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/ise')
    .then(({ data }) => { setRows(arr(Array.isArray(data) ? data : data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load ISE nodes' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => rows || [], [rows]);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all.filter((r) => (!stateFilter || stateTone(r.state) === stateFilter)
      && (!term || [r.deviceName, r.siteName, r.model].some((v) => String(v || '').toLowerCase().includes(term))));
  }, [all, q, stateFilter]);
  const sessions = all.reduce((n, r) => n + (numOf(r.sessions) || 0), 0);
  const certs = all.filter((r) => numOf(r.certDaysMin) != null && r.certDaysMin < CERT_WARN_DAYS).length;
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
      await downloadCsv('/logicmonitor/ise.csv', params, 'logicmonitor-ise');
    } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };
  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Fingerprint} title="Identity Services" description="Cisco ISE nodes with sessions, resources, application and certificate health, from the DataSource metrics tier">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Server} label="ISE nodes" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={Users} label="Active sessions" value={fmtNum(sessions)} loading={rows == null} />
        <StatCard icon={CalendarClock} label="Certificates under 30 days" value={fmtNum(certs)} tone={certs ? 'warn' : 'ok'} loading={rows == null} />
        <StatCard icon={AlertTriangle} label="Need attention" value={fmtNum(attention)} tone={attention ? 'warn' : 'ok'} loading={rows == null} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search node or site..." className={`${inp} max-w-[260px]`} spellCheck={false} />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(list.length)} node(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>
      </div>

      {rows == null ? <LoadingPanel label="Loading ISE nodes..." height={200} /> : (
        <SectionPanel icon={Fingerprint} title="ISE nodes" blurb="Application and deployment state are read against the estate majority because the ntm_ DataSource enums are unverified; the raw value shows in each badge tooltip.">
          {list.length ? <ServiceTable rows={list} columns={COLUMNS} rowKey={(r) => `${r.sourceId}-${r.deviceId}`} onOpen={setOpen} />
            : <p className="text-sm text-ink-muted py-4 text-center">{all.length === 0 ? 'No ISE nodes collected yet. They appear once the metrics tier has read the Cisco_ISE_ and ntm_ise_ DataSources.' : 'No ISE nodes match.'}</p>}
        </SectionPanel>
      )}

      {open && <LmIse360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
