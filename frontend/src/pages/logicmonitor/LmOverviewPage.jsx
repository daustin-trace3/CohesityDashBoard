import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useVisibleInterval, arr } from './helpers';
import HealthBand from './overview/HealthBand';
import SitesBand from './overview/SitesBand';
import BurningLedger from './overview/BurningLedger';
import TrendPanels from './overview/TrendPanels';

const REFRESH_MS = 60000;

// Every section is read through a tolerant accessor so {} and empty arrays render.
function normalize(d) {
  const o = d && typeof d === 'object' ? d : {};
  const map = o.map && typeof o.map === 'object' ? o.map : {};
  return {
    generatedAt: o.generatedAt || null,
    health: o.health && typeof o.health === 'object' ? o.health : {},
    counters: o.counters && typeof o.counters === 'object' ? o.counters : {},
    map: { nodes: arr(map.nodes), edges: arr(map.edges), circuits: arr(map.circuits) },
    burning: arr(o.burning),
    trends: o.trends && typeof o.trends === 'object' ? o.trends : {},
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function LmOverviewPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/overview')
    .then(({ data: d }) => { setData(normalize(d)); setError(null); setLastRefreshed(new Date()); })
    .catch((err) => {
      const status = err && err.response && err.response.status;
      setError(status === 404 ? 'missing' : 'failed');
    }), []);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const header = (
    <PageHeader icon={Gauge} title="LogicMonitor Overview" description="Network health across connected LogicMonitor portals">
      <LastUpdated date={lastRefreshed} prefix="Updated" />
      <RefreshButton onClick={load} />
    </PageHeader>
  );

  if (!data) {
    return (
      <div className="animate-fade-in">
        {header}
        {error ? (
          <div className="panel p-4 border border-status-crit/40">
            <p className="text-sm text-ink">
              {error === 'missing' ? 'Overview needs the round 5 backend. This server does not have GET /api/logicmonitor/overview yet.' : 'Failed to load the LogicMonitor overview.'}
            </p>
            <button onClick={load} className="text-xs text-brand mt-2 cursor-pointer hover:underline">Try again</button>
          </div>
        ) : <LoadingPanel label="Loading overview..." height={240} />}
      </div>
    );
  }

  const c = data.counters;
  const score = data.health.score;
  const hasScore = score != null && Number.isFinite(Number(score));
  const noData = !hasScore && data.map.nodes.length === 0 && num(c.interfaces) === 0 && num(c.collectors) === 0;
  const go = (path) => () => navigate(path);
  const sitePath = (key) => navigate(`/logicmonitor/sites?site=${encodeURIComponent(key)}`);

  return (
    <div className="animate-fade-in">
      {header}

      {error && (
        <div className="panel p-3 mb-4 border border-status-warn/40 text-xs text-ink-muted">
          {error === 'missing' ? 'Overview needs the round 5 backend.' : 'The last refresh failed, showing the previous figures.'}
        </div>
      )}

      {noData && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No LogicMonitor data yet. Add a portal under{' '}
            <button onClick={go('/logicmonitor/settings')} className="text-brand underline cursor-pointer">LogicMonitor Settings</button> to start polling.
          </p>
        </div>
      )}

      <div className="mb-4">
        <HealthBand health={data.health} counters={c} circuits={data.map.circuits} go={go} />
      </div>

      <div className="mb-4">
        <SitesBand nodes={data.map.nodes} onOpenSite={sitePath} />
      </div>

      <div className="mb-4">
        <BurningLedger rows={data.burning} total={c.openIssues} onOpenIssues={go('/logicmonitor/issues')} onOpenSite={sitePath} />
      </div>

      <div className="mb-4">
        <TrendPanels trends={data.trends} />
      </div>

      <p className="pt-3 border-t border-cohesity-border text-[11px] text-ink-faint">
        Derived health = {data.health.formula || '100 minus (0.5 x critical alerts + 2 x dead devices + 0.5 x down ports + 1 x degraded links + 3 x saturated circuits)'}
      </p>
    </div>
  );
}
