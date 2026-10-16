import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wifi, WifiOff, Download, Users, Cable } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, arr, fmtNum, downloadCsv, useVisibleInterval } from './helpers';
import { chipBtn } from './ui';
import LmAp360 from './LmAp360';
import { ApTable, WL_EMPTY } from './wirelessShared';

const REFRESH_MS = 120000;
const DOWN = ['down', 'silent', 'missing'];
const FILTERS = [['', 'All'], ['down', 'Down'], ['up', 'Up'], ['radio', 'Radio down'], ['errors', 'Uplink errors'], ['disabled', 'Disabled']];

export default function LmWirelessApsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const filter = searchParams.get('status') || '';

  const load = useCallback(() => client.get('/logicmonitor/wireless/aps')
    .then(({ data }) => { setRows(arr(data)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load access points' }); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = rows || [];
  const list = useMemo(() => all.filter((a) => {
    if (!filter) return true;
    if (filter === 'down') return DOWN.includes(a.status);
    if (filter === 'up') return a.status === 'up';
    if (filter === 'radio') return a.radiosDown > 0;
    if (filter === 'errors') return Number(a.uplinkErrors) > 1;
    return a.status === filter;
  }), [all, filter]);
  const tiles = useMemo(() => {
    const managed = all.filter((a) => a.status !== 'disabled');
    return {
      managed: managed.length,
      down: managed.filter((a) => DOWN.includes(a.status)).length,
      clients: all.some((a) => a.clients != null) ? all.reduce((n, a) => n + (a.clients || 0), 0) : null,
      errors: all.filter((a) => Number(a.uplinkErrors) > 1).length,
    };
  }, [all]);

  const setFilter = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('status', v); else next.delete('status');
    setSearchParams(next, { replace: true });
  };
  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/wireless/aps.csv', {}, 'logicmonitor-wireless-aps'); } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };
  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50 ml-auto';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wifi} title="Access Points" description="Every AP joined to a monitored controller, with radio state, clients, channel utilization and uplink health">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Wifi} label="Access points" value={fmtNum(tiles.managed)} loading={rows == null} />
        <StatCard icon={WifiOff} label="Down or missing" value={fmtNum(tiles.down)} tone={tiles.down ? 'crit' : 'ok'} loading={rows == null} onClick={() => setFilter('down')} />
        <StatCard icon={Users} label="Clients" value={fmtNum(tiles.clients)} loading={rows == null} />
        <StatCard icon={Cable} label="Uplinks with errors" value={fmtNum(tiles.errors)} tone={tiles.errors ? 'warn' : 'ok'} loading={rows == null} onClick={() => setFilter('errors')} />
      </div>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {FILTERS.map(([v, l]) => <button key={v || 'all'} onClick={() => setFilter(v)} className={chipBtn(filter === v)}>{l}</button>)}
        </div>
        {rows == null ? <LoadingPanel label="Loading access points..." height={200} /> : (
          <ApTable rows={list} deepLink onOpen={(a) => setOpen(a)} empty={all.length ? 'No access points match.' : WL_EMPTY}
            toolbar={<button onClick={exportCsv} disabled={exporting} className={btn}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>} />
        )}
      </div>
      <p className="text-[11px] text-ink-faint mt-2">Missing = the AP left its controller's AP table in the last 24 hours. Not reporting = its samples are more than 3 hours older than the rest of the controller's APs.</p>
      {open && <LmAp360 controllerId={open.controllerId} sourceId={open.sourceId} apKey={open.apKey} onClose={() => setOpen(null)} />}
    </div>
  );
}
