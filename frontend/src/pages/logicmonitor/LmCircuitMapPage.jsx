import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, arr, fmtNum, useVisibleInterval } from './helpers';
import { inp } from './ui';
import CircuitMap from './overview/CircuitMap';
import { issuesLink } from './circuitShared';

const REFRESH_MS = 60000;

const nodeHasProblem = (n) => n.wanState === 'down' || n.wanState === 'degraded'
  || (Number(n.devicesDead) || 0) > 0 || (Number(n.openIssues) || 0) > 0 || arr(n.degradedDevices).length > 0;

export default function LmCircuitMapPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [q, setQ] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);

  const load = useCallback(() => client.get('/logicmonitor/circuit-map')
    .then(({ data: d }) => { setData(d && typeof d === 'object' ? d : {}); setLastRefreshed(new Date()); })
    .catch((e) => {
      setData((cur) => cur || { missing: e?.response?.status === 404 });
      if (e?.response?.status !== 404) toast({ type: 'error', title: 'Failed to load the circuit map' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const nodes = useMemo(() => arr(data?.nodes), [data]);
  const edges = useMemo(() => arr(data?.edges), [data]);

  // Search keeps matching sites plus the sites they link to, so a match still shows its connections.
  // Problems only drops ok links and the sites left with nothing wrong.
  const view = useMemo(() => {
    const term = q.trim().toLowerCase();
    let keepEdges = edges;
    if (problemsOnly) keepEdges = keepEdges.filter((e) => e.state !== 'ok');
    let keep = null;
    if (term) {
      const hit = new Set(nodes.filter((n) => `${n.siteName || ''} ${n.siteKey}`.toLowerCase().includes(term)).map((n) => String(n.siteKey)));
      keep = new Set(hit);
      keepEdges.forEach((e) => {
        if (hit.has(String(e.a))) keep.add(String(e.b));
        if (hit.has(String(e.b))) keep.add(String(e.a));
      });
    }
    let keepNodes = nodes;
    if (problemsOnly) {
      const touched = new Set();
      keepEdges.forEach((e) => { touched.add(String(e.a)); touched.add(String(e.b)); });
      keepNodes = keepNodes.filter((n) => nodeHasProblem(n) || touched.has(String(n.siteKey)));
    }
    if (keep) keepNodes = keepNodes.filter((n) => keep.has(String(n.siteKey)));
    const present = new Set(keepNodes.map((n) => String(n.siteKey)));
    return { nodes: keepNodes, edges: keepEdges.filter((e) => present.has(String(e.a)) && present.has(String(e.b))) };
  }, [nodes, edges, q, problemsOnly]);

  const wanDown = nodes.filter((n) => n.wanState === 'down').length;
  const wanDeg = nodes.filter((n) => n.wanState === 'degraded').length;
  const linksDown = edges.filter((e) => e.state === 'down').length;
  const linksFlap = edges.filter((e) => e.state === 'flapping' || e.state === 'degraded').length;
  const loading = data == null;

  const openSite = (key) => navigate(`/logicmonitor/sites?site=${encodeURIComponent(key)}`);
  const openEdge = (e) => {
    if (e.issueKey) navigate(issuesLink(e.issueKey));
    else openSite(e.a);
  };

  const chk = 'inline-flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Share2} title="Circuit Map" description="Site to site links coloured by state, with each site's WAN state. A site with one WAN circuit down and another up is degraded, not down.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Share2} label="Sites WAN down" value={fmtNum(wanDown)} tone={wanDown ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={Share2} label="Sites WAN degraded" value={fmtNum(wanDeg)} tone={wanDeg ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={Share2} label="Site links down" value={fmtNum(linksDown)} tone={linksDown ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={Share2} label="Links degraded or flapping" value={fmtNum(linksFlap)} tone={linksFlap ? 'warn' : 'ok'} loading={loading} />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sites..." aria-label="Search sites" spellCheck={false} className={`${inp} max-w-xs`} />
        <label className={chk}>
          <input type="checkbox" className="accent-brand" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Problems only
        </label>
        <span className="text-[11px] text-ink-faint tnum ml-auto">{`${fmtNum(view.nodes.length)} of ${fmtNum(nodes.length)} site(s), ${fmtNum(view.edges.length)} link(s)`}</span>
      </div>

      {loading ? (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}><LoadingPanel label="Loading circuit map..." height={240} /></div>
      ) : data.missing ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">The Circuit Map needs the round 13 backend (GET /logicmonitor/circuit-map answered 404).</div>
      ) : (
        <>
          <CircuitMap nodes={view.nodes} edges={view.edges} onOpenSite={openSite} onOpenEdge={openEdge} />
          {nodes.length > 0 && edges.length === 0 && (
            <p className="text-[11px] text-ink-muted mt-2">No site links identified yet. A link is a circuit whose far end is another site: a CG tag of p2p, b2b or dci, a topology neighbour at another site, or a description that names it. Force one under Settings, Rules, Circuits.</p>
          )}
        </>
      )}
    </div>
  );
}
