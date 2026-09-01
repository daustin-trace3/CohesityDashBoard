import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Waypoints, Search, Loader2, Server, Building2, Cable, Network, Target, HardDrive,
  Database, FolderTree, ShieldCheck, Boxes, ArrowLeftRight, FileText, HelpCircle,
} from 'lucide-react';
import client from '../../api/client';
import { PageHeader } from '../../components/ui/primitives';

const TIERS = ['backup', 'compute', 'san', 'storage'];
const TIER_LABEL = { backup: 'Backup', compute: 'Compute', san: 'SAN', storage: 'Storage' };

const NODE_W = 180;
const NODE_H = 54;
const COL_GAP = 220;
const ROW_GAP = 20;
const PAD_X = 40;
const PAD_Y = 60;

const TYPE_ICON = {
  vm: Server, host: Server, vcenter: Building2, hba: Cable, switch: Waypoints, fabric: Network,
  targetPort: Target, array: HardDrive, volume: Database, datastore: FolderTree,
  protection: ShieldCheck, cluster: Boxes, vpg: ArrowLeftRight, policy: FileText,
};

const PLATFORM_COLOR = {
  cohesity: '#6CB33F', netapp: '#0067C5', zerto: '#EE3124', vcenter: '#0091DA',
  aria: '#00A2C7', ariaops: '#78BE20', dell: '#007DB8', pure: '#FF6B00',
  aws: '#FF9900', unifi: '#006FFF', brocade: '#CC092F',
};
const OPS_GRAY = '#8FA3B0';

const GREEN_EDGE_KINDS = new Set(['protected-by', 'replicated-by', 'backed-up-by']);

function statusRingClass(status) {
  if (status === 'crit') return 'ring-2 ring-status-crit';
  if (status === 'warn') return 'ring-2 ring-status-warn';
  return '';
}

/** Deterministic left→right tiered layout — no physics lib. Orders each
 * column by the barycenter of its already-placed left-neighbors so edges
 * don't cross more than necessary, falling back to input order. */
function layout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byTier = new Map(TIERS.map((t) => [t, []]));
  nodes.forEach((n) => {
    if (byTier.has(n.tier)) byTier.get(n.tier).push(n);
  });

  const positions = new Map();
  TIERS.forEach((tier, colIdx) => {
    const colNodes = byTier.get(tier) || [];
    if (colIdx > 0) {
      const scored = colNodes.map((n, i) => {
        const neighborYs = edges
          .filter((e) => e.to === n.id || e.from === n.id)
          .map((e) => positions.get(e.to === n.id ? e.from : e.to))
          .filter((p) => p != null)
          .map((p) => p.y);
        const bary = neighborYs.length ? neighborYs.reduce((a, b) => a + b, 0) / neighborYs.length : i * 1e6;
        return { n, bary, i };
      });
      scored.sort((a, b) => a.bary - b.bary || a.i - b.i);
      colNodes.splice(0, colNodes.length, ...scored.map((s) => s.n));
    }
    colNodes.forEach((n, rowIdx) => {
      positions.set(n.id, {
        x: PAD_X + colIdx * COL_GAP,
        y: PAD_Y + rowIdx * (NODE_H + ROW_GAP),
      });
    });
  });

  const width = PAD_X * 2 + (TIERS.length - 1) * COL_GAP + NODE_W;
  const maxRows = Math.max(1, ...TIERS.map((t) => (byTier.get(t) || []).length));
  const height = PAD_Y * 2 + maxRows * (NODE_H + ROW_GAP);

  return { positions, byId, width, height, byTier };
}

function edgePath(from, to) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function Tooltip({ node, x, y }) {
  if (!node) return null;
  const color = PLATFORM_COLOR[node.platform] || OPS_GRAY;
  return createPortal(
    <div
      className="fixed z-[999] pointer-events-none bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl px-3 py-2 max-w-xs"
      style={{ left: x + 14, top: y + 14 }}
    >
      <p className="text-sm font-medium text-ink truncate">{node.label}</p>
      {node.sublabel && <p className="text-[11px] text-ink-faint truncate">{node.sublabel}</p>}
      <p className="text-[10px] uppercase tracking-wide mt-1" style={{ color }}>
        {node.platform || node.type}
      </p>
    </div>,
    document.body
  );
}

export default function TopologyPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('name') || '');
  const [suggestions, setSuggestions] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hoverId, setHoverId] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const seqRef = useRef(0);

  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef(null);
  const svgWrapRef = useRef(null);

  const load = useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    setView({ x: 0, y: 0, scale: 1 });
    client.get('/topology', { params: { name } })
      .then(({ data }) => setData(data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    setParams({ name }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    const name = params.get('name');
    if (name) load(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || q === params.get('name')) { setSuggestions([]); return undefined; }
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      client.get('/server360/suggest', { params: { q } })
        .then(({ data }) => { if (seqRef.current === id) setSuggestions(data.names || []); })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = data?.nodes || [];
  const edges = data?.edges || [];
  const { positions, byId, width, height, byTier } = useMemo(() => layout(nodes, edges), [nodes, edges]);

  const neighborIds = useMemo(() => {
    if (!hoverId) return null;
    const set = new Set([hoverId]);
    edges.forEach((e) => {
      if (e.from === hoverId) set.add(e.to);
      if (e.to === hoverId) set.add(e.from);
    });
    return set;
  }, [hoverId, edges]);

  const onWheel = (e) => {
    e.preventDefault();
    const rect = svgWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const nextScale = Math.min(2.5, Math.max(0.4, v.scale * factor));
      const scaleRatio = nextScale / v.scale;
      return {
        scale: nextScale,
        x: mx - (mx - v.x) * scaleRatio,
        y: my - (my - v.y) * scaleRatio,
      };
    });
  };

  const onPointerDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (dragRef.current) {
      const { startX, startY, origX, origY } = dragRef.current;
      setView((v) => ({ ...v, x: origX + (e.clientX - startX), y: origY + (e.clientY - startY) }));
    }
    setTooltipPos({ x: e.clientX, y: e.clientY });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const nothingFound = data && nodes.length === 0;

  return (
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Waypoints} title="Topology"
        description="Anchor on a device and trace everything it touches — backup, compute, SAN, and storage — in one graph" />

      {/* Picker */}
      <div className="panel p-4">
        <div className="relative max-w-lg">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(suggestions[0] && input !== params.get('name') ? suggestions[0] : input.trim()); }}
            placeholder="Server name or hostname…"
            className="w-full bg-surface border border-cohesity-border text-sm text-ink rounded-lg pl-9 pr-3 py-2 placeholder-ink-faint focus:border-brand/60 transition-colors"
          />
          {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint animate-spin" />}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl overflow-hidden">
              {suggestions.map((n) => (
                <button key={n} onClick={() => { setInput(n); load(n); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-brand/10 transition-colors cursor-pointer">{n}</button>
              ))}
            </div>
          )}
        </div>
        {data?.identity && (
          <p className="text-[11px] text-ink-faint mt-2 tnum">
            Pivoting on {data.identity.names.join(', ')}{data.identity.ips.length ? ` · IPs ${data.identity.ips.join(', ')}` : ' · no known IPs'}
          </p>
        )}
      </div>

      {!data && (
        <div className="panel p-10 text-sm text-ink-muted text-center flex flex-col items-center gap-2">
          <Waypoints size={28} className="text-ink-faint" />
          Search for a device above to build its topology graph.
        </div>
      )}

      {nothingFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No linked data found for &ldquo;{data.query}&rdquo;.
        </div>
      )}

      {data && nodes.length > 0 && (
        <div className="panel p-0 overflow-hidden">
          {/* Tier headers + legend */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-cohesity-border/60">
            <div className="flex items-center gap-6">
              {TIERS.map((t) => (
                <span key={t} className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
                  {TIER_LABEL[t]} {(byTier.get(t) || []).length ? `(${byTier.get(t).length})` : ''}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-4 text-[10px] text-ink-faint">
              <span className="flex items-center gap-1"><span className="inline-block w-4 h-0 border-t border-dashed" style={{ borderColor: '#22d3ee' }} /> zoned</span>
              <span className="flex items-center gap-1"><span className="inline-block w-4 h-0 border-t" style={{ borderColor: '#22c55e' }} /> protected / replicated</span>
              <span className="flex items-center gap-1"><span className="inline-block w-4 h-0 border-t" style={{ borderColor: '#4A5568' }} /> other</span>
            </div>
          </div>

          <div
            ref={svgWrapRef}
            className="relative overflow-hidden bg-surface-base/40"
            style={{ height: '560px', cursor: dragRef.current ? 'grabbing' : 'grab' }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <svg width="100%" height="100%">
              <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                <svg width={width} height={height} overflow="visible">
                  {edges.map((e, i) => {
                    const from = positions.get(e.from);
                    const to = positions.get(e.to);
                    if (!from || !to) return null;
                    const dimmed = neighborIds && !(neighborIds.has(e.from) && neighborIds.has(e.to));
                    const color = e.kind === 'zoned' ? '#22d3ee' : GREEN_EDGE_KINDS.has(e.kind) ? '#22c55e' : '#4A5568';
                    const midX = (from.x + NODE_W + to.x) / 2;
                    const midY = (from.y + to.y) / 2 + NODE_H / 2;
                    return (
                      <g key={`${e.from}|${e.to}|${i}`} opacity={dimmed ? 0.35 : 1}>
                        <path d={edgePath(from, to)} fill="none" stroke={color}
                          strokeWidth={1.5} strokeDasharray={e.kind === 'zoned' ? '4 3' : undefined} />
                        {e.label && (
                          <text x={midX} y={midY - 4} textAnchor="middle" fontSize="10" fill="#8FA3B0">{e.label}</text>
                        )}
                      </g>
                    );
                  })}
                  {nodes.map((n) => {
                    const pos = positions.get(n.id);
                    if (!pos) return null;
                    const Icon = TYPE_ICON[n.type] || HelpCircle;
                    const color = PLATFORM_COLOR[n.platform] || OPS_GRAY;
                    const dimmed = neighborIds && !neighborIds.has(n.id);
                    return (
                      <foreignObject key={n.id} x={pos.x} y={pos.y} width={NODE_W} height={NODE_H}
                        style={{ overflow: 'visible' }}>
                        <div
                          className={`flex items-center gap-2 h-full rounded-lg border border-cohesity-border bg-cohesity-gray pl-2 pr-2.5 cursor-pointer transition-opacity ${statusRingClass(n.status)}`}
                          style={{ borderLeftColor: color, borderLeftWidth: 3, opacity: dimmed ? 0.35 : 1 }}
                          onMouseEnter={(e) => { setHoverId(n.id); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                          onMouseLeave={() => setHoverId(null)}
                          onClick={() => { if (n.route) navigate(n.route); }}
                        >
                          <Icon size={15} className="flex-shrink-0" style={{ color }} />
                          <div className="min-w-0 leading-tight">
                            <p className="text-[12px] font-medium text-ink truncate">{n.label}</p>
                            {n.sublabel && <p className="text-[10px] text-ink-faint truncate">{n.sublabel}</p>}
                          </div>
                        </div>
                      </foreignObject>
                    );
                  })}
                </svg>
              </g>
            </svg>
          </div>
        </div>
      )}

      {hoverId && <Tooltip node={byId.get(hoverId)} x={tooltipPos.x} y={tooltipPos.y} />}
    </div>
  );
}
