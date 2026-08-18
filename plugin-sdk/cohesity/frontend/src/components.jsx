// Shared components used by more than one page — ported from
// frontend/src/components/{ClusterCard,HardwareModal,ClusterAIModal,
// AlertReviewModal,InsightsPanel}.jsx. Kept in one file (dell/unifi
// convention: pages/* stay thin, shared widgets live beside ui.jsx).
import { apiFetch, parseUtcMs, timeAgo, Badge, Spinner, LoadingPanel, Modal, Markdown } from './ui.jsx';
import {
  Sparkles, RefreshCw, Lightbulb, AlertOctagon, Info, CheckCircle2, ChevronDown, ChevronUp, ChevronRight,
  Database, WifiOff, Bell, ShieldAlert, ArrowLeftRight, Gauge, ClipboardCheck, X,
} from './icons.jsx';

/* ────────────────────────────────────────────────────────────────────────
 * useAiEnabled — the host's AI nav/feature gate moved to core
 * GET /api/settings/ai-config (WP0, relocated off /cohesity/insights/ai/config
 * so every platform shares one gate). Polled once per page since the plugin
 * has no shared app-level context to cache it in.
 * ────────────────────────────────────────────────────────────────────── */
export function useAiEnabled() {
  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    apiFetch('/settings/ai-config').then((d) => { if (!cancelled) setEnabled(!!d?.enabled); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

/* ────────────────────────────────────────────────────────────────────────
 * ClusterAIModal — per-cluster AI system/alerts analysis
 * ────────────────────────────────────────────────────────────────────── */
export function ClusterAIModal({ cluster, onClose, mode = 'system' }) {
  const [enabled, setEnabled] = React.useState(true);
  const [analysis, setAnalysis] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);

  const title = mode === 'alerts' ? 'Alert Analysis' : 'System Analysis';
  const scope = mode === 'alerts' ? "this cluster's active alerts" : "this cluster's capacity, sources, and backup-job health";

  React.useEffect(() => {
    apiFetch(`/cohesity/insights/ai/${cluster.id}?mode=${mode}`)
      .then((data) => { setEnabled(data.enabled); setAnalysis(data.analysis || null); })
      .catch(() => setError('Could not load saved analysis.'))
      .finally(() => setLoading(false));
  }, [cluster.id, mode]);

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await apiFetch(`/cohesity/insights/ai/${cluster.id}?mode=${mode}`, { method: 'POST' });
      setAnalysis(data);
      setEnabled(true);
    } catch (e) {
      if (e.status === 503) { setEnabled(false); setError(e.payload?.error || 'AI analysis is not configured.'); }
      else setError(e.payload?.error || 'Analysis failed. Check the server logs and try again.');
    } finally {
      setRunning(false);
    }
  }, [cluster.id, mode]);

  const fmtTime = (ts) => { if (!ts) return ''; try { return new Date(ts).toLocaleString(); } catch { return ts; } };

  return (
    <Modal
      title={`${title} — ${cluster.name}`}
      icon={Sparkles}
      onClose={onClose}
      maxWidth="min(720px,92vw)"
      subtitle={analysis?.generatedAt ? `${analysis.model ? `${analysis.model} · ` : ''}Generated ${fmtTime(analysis.generatedAt)}` : undefined}
      footer={enabled && !loading ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={run} disabled={running} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}>
            <Sparkles size={13} /> {analysis?.analysis ? 'Re-run analysis' : 'Analyze with AI'}
          </button>
        </div>
      ) : undefined}
    >
      {loading ? (
        <LoadingPanel label="Loading analysis…" height={160} />
      ) : !enabled ? (
        <div style={{ fontSize: 12, color: 'var(--co-ink-muted)', lineHeight: 1.6 }}>
          <p>AI analysis is not configured on the server.</p>
          {error && <p style={{ color: 'var(--co-crit)', marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <>
          {error && <p style={{ color: 'var(--co-crit)', fontSize: 12, marginBottom: 8 }}>{error}</p>}
          {running ? (
            <LoadingPanel label={`Analyzing ${cluster.name} with AI…`} height={160} />
          ) : analysis?.analysis ? (
            <>
              {analysis.stale && (
                <p style={{ marginBottom: 12, fontSize: 11, color: 'var(--co-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '6px 10px' }}>
                  This analysis is over {analysis.ttlHours || 24}h old and may not reflect current alerts. Re-run for an up-to-date review.
                </p>
              )}
              <Markdown text={analysis.analysis} />
            </>
          ) : (
            <p style={{ color: 'var(--co-ink-muted)', fontSize: 12, padding: '24px 0', textAlign: 'center' }}>
              No analysis yet. Run one to have the LLM review {scope}.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * AlertReviewModal — AI review of a single alert
 * ────────────────────────────────────────────────────────────────────── */
const CONFIDENCE_TONE = { high: 'ok', medium: 'warn', low: 'neutral' };

export function AlertReviewModal({ alert, onClose }) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [review, setReview] = React.useState(null);

  const run = React.useCallback(async (force) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/cohesity/alerts/${alert.id}/review${force ? '?force=1' : ''}`, { method: 'POST' });
      setReview(data);
    } catch (err) {
      setError(err.payload?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [alert.id]);

  React.useEffect(() => { run(false); }, [run]);

  return (
    <Modal
      title="AI Alert Review"
      subtitle={`${alert.cluster_name} · ${alert.alert_type || 'Alert'}`}
      icon={Sparkles}
      onClose={onClose}
      maxWidth="min(720px,92vw)"
    >
      <div style={{ marginBottom: 16, borderRadius: 8, border: '1px solid var(--co-border)', background: 'rgba(11,16,21,0.4)', padding: '10px 14px' }}>
        <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: '0 0 4px' }}>Alert description</p>
        <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', lineHeight: 1.6, margin: 0 }}>{alert.description || '—'}</p>
      </div>

      <div style={{ marginBottom: 12 }}>
        <button onClick={() => run(true)} disabled={loading} className="co-btn-ghost">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Regenerate
        </button>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', justifyContent: 'center' }}>
          <Spinner size={16} /> Generating review…
        </div>
      )}

      {error && !loading && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--co-crit)', borderRadius: 8, padding: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!loading && !error && review && (
        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {review.confidence && <Badge tone={CONFIDENCE_TONE[review.confidence] || 'neutral'}>{review.confidence} confidence</Badge>}
            {review.model && <span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{review.model}</span>}
          </div>

          {review.summary && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink-muted)', margin: '0 0 4px' }}>Summary</p>
              <p style={{ fontSize: 13, color: 'var(--co-ink)', lineHeight: 1.6, margin: 0 }}>{review.summary}</p>
            </div>
          )}

          {review.rootCause && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink-muted)', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertOctagon size={13} style={{ color: 'var(--co-warn)' }} /> Likely root cause
              </p>
              <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', lineHeight: 1.6, margin: 0 }}>{review.rootCause}</p>
            </div>
          )}

          {review.actions?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink-muted)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lightbulb size={13} style={{ color: 'var(--co-brand)' }} /> Recommended actions
              </p>
              <ol style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' }}>
                {review.actions.map((a, i) => (
                  <li key={i} style={{ fontSize: 13, color: 'var(--co-ink-muted)', lineHeight: 1.6, display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--co-brand)', fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', paddingTop: 4, borderTop: '1px solid var(--co-border)', margin: 0 }}>
            AI-generated guidance — verify against your environment before acting.
          </p>
        </div>
      )}
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * HardwareModal — chassis/node breakdown for one cluster
 * ────────────────────────────────────────────────────────────────────── */
function statusColor(raw) {
  if (!raw) return 'var(--co-ink-faint)';
  const s = raw.toLowerCase();
  if (s === 'knormal' || s === 'normal' || s === 'healthy') return 'var(--co-brand)';
  if (s === 'koffline' || s === 'offline' || s === 'dead') return 'var(--co-crit)';
  return 'var(--co-warn)';
}
function friendlyStatus(raw) { return raw ? raw.replace(/^k/, '') : '—'; }
function getNodeSerial(node) {
  return node?.cohesityNodeSerial || node?._v2Serial || node?.cohesityNodeInfo?.nodeHardwareInfo?.serialNumber
    || node?.cohesityNodeInfo?.nodeHardwareInfo?.productSerial || node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.serialNumber
    || node?.serialNumber || node?.productSerial || node?.nodeHardwareInfo?.serialNumber || '—';
}
function getNodeModel(node) {
  return node?._v2Model || node?.cohesityNodeInfo?.nodeHardwareInfo?.productModel || node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.chassisModel
    || node?.productModel || node?.model || '—';
}
function getNodeStatus(node) { return node?.cohesityNodeInfo?.status || node?.status || null; }
function getNodeChassisId(node) {
  return node?.chassisInfo?.chassisId ?? node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.chassisId ?? node?.chassisId ?? null;
}

export function HardwareModal({ cluster, onClose }) {
  const [nodes, setNodes] = React.useState([]);
  const [chassis, setChassis] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [collapsedChassis, setCollapsedChassis] = React.useState(new Set());

  React.useEffect(() => {
    apiFetch(`/cohesity/hardware/${cluster.id}`)
      .then((data) => {
        setNodes(Array.isArray(data) ? data : (data.nodes || []));
        setChassis(Array.isArray(data) ? [] : (data.chassis || []));
      })
      .catch((err) => setError(err.payload?.message || err.message))
      .finally(() => setLoading(false));
  }, [cluster.id]);

  React.useEffect(() => {
    if (nodes.length === 0) return;
    const ids = new Set();
    for (const c of chassis) { const cid = c.id ?? c.chassisId; if (cid != null) ids.add(cid); }
    if (chassis.length === 0) {
      for (const node of nodes) { const cid = getNodeChassisId(node); if (cid != null) ids.add(cid); }
    }
    if (ids.size === 0) ids.add('__all__');
    setCollapsedChassis(ids);
  }, [nodes, chassis]);

  const toggleChassis = (id) => setCollapsedChassis((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const chassisGroups = React.useMemo(() => {
    if (nodes.length === 0) return [];
    const chassisById = {};
    for (const c of chassis) { const cid = c.id ?? c.chassisId; if (cid != null) chassisById[cid] = c; }
    const nodesByChassis = {};
    const unassigned = [];
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid == null) continue;
      const nodeIds = c.nodeIds || c.nodes?.map((n) => n.id ?? n.nodeId) || [];
      if (nodeIds.length > 0) {
        for (const nid of nodeIds) {
          const node = nodes.find((n) => (n.id ?? n.nodeId) === nid || String(n.id ?? n.nodeId) === String(nid));
          if (node) { (nodesByChassis[cid] ||= []).push(node); }
        }
      }
    }
    const assignedNodeIds = new Set(Object.values(nodesByChassis).flat().map((n) => n.id ?? n.nodeId));
    for (const node of nodes) {
      const nid = node.id ?? node.nodeId;
      if (assignedNodeIds.has(nid)) continue;
      const cid = getNodeChassisId(node);
      if (cid != null) (nodesByChassis[cid] ||= []).push(node);
      else unassigned.push(node);
    }
    const groups = [];
    const seen = new Set();
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid == null || seen.has(cid)) continue;
      seen.add(cid);
      if (nodesByChassis[cid]?.length > 0) groups.push({ id: cid, info: c, nodes: nodesByChassis[cid] });
    }
    for (const [cid, cNodes] of Object.entries(nodesByChassis)) {
      if (seen.has(cid) || seen.has(Number(cid))) continue;
      seen.add(cid);
      groups.push({ id: cid, info: chassisById[cid] || null, nodes: cNodes });
    }
    if (unassigned.length > 0) groups.push({ id: '__unassigned__', info: null, nodes: unassigned });
    if (groups.length === 0) groups.push({ id: '__all__', info: null, nodes });
    return groups;
  }, [nodes, chassis]);

  return (
    <Modal
      title={cluster.name}
      subtitle={`Hardware Information — ${nodes.length} node(s) · ${chassis.length} chassis`}
      onClose={onClose}
      maxWidth="min(860px,92vw)"
      footer={
        !loading && chassisGroups.length > 0 ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setCollapsedChassis(new Set())} className="co-btn-ghost">Expand All</button>
            <button onClick={() => setCollapsedChassis(new Set(chassisGroups.map((g) => g.id)))} className="co-btn-ghost">Collapse All</button>
          </div>
        ) : undefined
      }
    >
      {loading && <p style={{ fontSize: 13, color: 'var(--co-ink-muted)' }}>Loading hardware info...</p>}
      {error && <p style={{ fontSize: 13, color: 'var(--co-crit)' }}>{error}</p>}
      {!loading && !error && nodes.length === 0 && <p style={{ fontSize: 13, color: 'var(--co-ink-muted)' }}>No node data available.</p>}

      {!loading && nodes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {chassisGroups.map((group) => {
            const cid = group.id;
            const info = group.info;
            const isCollapsed = collapsedChassis.has(cid);
            const chassisSerial = info?.serialNumber || group.nodes[0]?.chassisInfo?.chassisSerial || null;
            const chassisLabel = cid === '__unassigned__' ? 'Unassigned Nodes'
              : cid === '__all__' ? 'All Nodes'
              : (info?.name || chassisSerial)
                ? `${info?.name || chassisSerial || ''} ${chassisSerial && chassisSerial !== info?.name ? `(S/N: ${chassisSerial})` : ''}`.trim()
                : `Chassis ${cid}`;
            const chassisModel = info?.hardwareModel || info?.model || group.nodes[0]?.productModel || '—';
            const chassisSerialDisplay = chassisSerial || '—';
            return (
              <div key={String(cid)} style={{ border: '1px solid var(--co-border)', borderRadius: 8, overflow: 'hidden' }}>
                <button
                  onClick={() => toggleChassis(cid)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--co-surface-base)', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                >
                  <ChevronRight size={13} style={{ color: 'var(--co-ink-faint)', transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 150ms' }} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)' }}>{chassisLabel}</span>
                    {cid !== '__unassigned__' && cid !== '__all__' && (
                      <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--co-ink-faint)' }}>
                        Model: <span style={{ color: 'var(--co-ink-muted)' }}>{chassisModel}</span>
                        {chassisSerialDisplay !== '—' && <> · S/N: <span style={{ color: 'var(--co-ink-muted)', fontFamily: 'monospace' }}>{chassisSerialDisplay}</span></>}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{group.nodes.length} node(s)</span>
                </button>
                {!isCollapsed && (
                  <div>
                    {group.nodes.map((node, i) => {
                      const nid = node.id ?? node.nodeId ?? i;
                      const nodeStatus = getNodeStatus(node);
                      const nodeModel = getNodeModel(node);
                      const nodeSerial = getNodeSerial(node);
                      const nodeIp = node.ip || node.ipAddress || '—';
                      const swVersion = node.softwareVersion || node.cohesityNodeInfo?.softwareVersion || '—';
                      return (
                        <div key={nid} style={{ padding: '10px 14px', borderTop: '1px solid var(--co-border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(nodeStatus), flexShrink: 0 }} />
                            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--co-ink)' }}>Node {nid}</span>
                            <span style={{ fontSize: 11, color: statusColor(nodeStatus) }}>{friendlyStatus(nodeStatus)}</span>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, paddingLeft: 16, fontSize: 11 }}>
                            <div><p style={{ color: 'var(--co-ink-faint)', textTransform: 'uppercase', fontSize: 9, margin: '0 0 2px' }}>Node IP</p><p style={{ color: 'var(--co-ink)', fontFamily: 'monospace', margin: 0 }}>{nodeIp}</p></div>
                            <div><p style={{ color: 'var(--co-ink-faint)', textTransform: 'uppercase', fontSize: 9, margin: '0 0 2px' }}>Model</p><p style={{ color: 'var(--co-ink)', margin: 0 }}>{nodeModel}</p></div>
                            <div><p style={{ color: 'var(--co-ink-faint)', textTransform: 'uppercase', fontSize: 9, margin: '0 0 2px' }}>Serial Number</p><p style={{ color: 'var(--co-ink)', fontFamily: 'monospace', margin: 0 }}>{nodeSerial}</p></div>
                            {swVersion !== '—' && <div><p style={{ color: 'var(--co-ink-faint)', textTransform: 'uppercase', fontSize: 9, margin: '0 0 2px' }}>SW Version</p><p style={{ color: 'var(--co-ink)', margin: 0 }}>{swVersion}</p></div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ClusterCard — used on the Dashboard's cluster grid
 * ────────────────────────────────────────────────────────────────────── */
function formatTB(bytes) {
  if (bytes == null || bytes === 0) return '—';
  const tb = bytes / 1e12;
  if (tb >= 0.01) return `${tb.toFixed(2)} TB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function SparkLine({ rows, color }) {
  if (!rows || rows.length < 2) return null;
  const vals = rows.map((r) => r.used_bytes || 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const W = 100, H = 24;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 24 }} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ClusterCard({ cluster, onTagClick, selected = false, onSelect, historyRows, alertSummary: alertSummaryProp }) {
  const [metrics, setMetrics] = React.useState(null);
  const [sparkRows, setSparkRows] = React.useState([]);
  const [alertSummary, setAlertSummary] = React.useState(alertSummaryProp || { count: 0, level: 'none' });
  const [hardwareOpen, setHardwareOpen] = React.useState(false);
  const [aiOpen, setAiOpen] = React.useState(false);
  const [metricsError, setMetricsError] = React.useState(false);
  const aiEnabled = useAiEnabled();

  React.useEffect(() => { if (alertSummaryProp) setAlertSummary(alertSummaryProp); }, [alertSummaryProp]);

  React.useEffect(() => {
    if (historyRows !== undefined) {
      if (historyRows.length > 0) { setMetrics(historyRows[historyRows.length - 1]); setSparkRows(historyRows); }
      if (!alertSummaryProp) {
        apiFetch(`/cohesity/alerts?clusterId=${cluster.id}&resolved=0`)
          .then((a) => setAlertSummary({
            count: a.length,
            level: a.some((x) => x.severity === 'critical') ? 'critical' : a.some((x) => x.severity === 'warning') ? 'warning' : a.length > 0 ? 'info' : 'none',
          }))
          .catch(() => {});
      }
      return;
    }
    (async () => {
      const [metricsResp, alertsResp] = await Promise.allSettled([
        apiFetch(`/cohesity/metrics/${cluster.id}/history?days=7`),
        apiFetch(`/cohesity/alerts?clusterId=${cluster.id}&resolved=0`),
      ]);
      if (metricsResp.status === 'fulfilled' && metricsResp.value.length > 0) {
        const rows = metricsResp.value;
        setMetrics(rows[rows.length - 1]);
        setSparkRows(rows);
      } else if (metricsResp.status === 'rejected') setMetricsError(true);
      if (alertsResp.status === 'fulfilled') {
        const a = alertsResp.value;
        setAlertSummary({
          count: a.length,
          level: a.some((x) => x.severity === 'critical') ? 'critical' : a.some((x) => x.severity === 'warning') ? 'warning' : a.length > 0 ? 'info' : 'none',
        });
      }
    })();
  }, [cluster.id, historyRows]);

  const used = metrics?.used_bytes ?? 0;
  const total = metrics?.total_capacity_bytes ?? 0;
  const available = total - used;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const pctDisplay = total > 0 ? `${pct.toFixed(2)}%` : '—';
  const pctColor = pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#6CB33F';
  const isPulsing = pct >= 90;
  const drRatio = metrics?.data_reduction_ratio;
  const savings = (drRatio != null && drRatio > 0) ? drRatio
    : (metrics?.logical_bytes > 0 && metrics?.used_bytes > 0 ? parseFloat((metrics.logical_bytes / metrics.used_bytes).toFixed(2)) : null);
  const tags = (cluster.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  const m = historyRows?.[historyRows.length - 1];
  const st = (() => {
    if (!m || !m.captured_at) return 'red';
    const intervalMs = (cluster.polling_interval_minutes || 15) * 2 * 60 * 1000;
    const age = Date.now() - parseUtcMs(m.captured_at);
    return age <= intervalMs ? 'green' : 'yellow';
  })();
  const orbColor = { green: '#34D399', yellow: '#FBBF24', red: '#F87171' }[st] || '#5F7081';
  const orbLabel = st === 'green' ? 'Online' : st === 'yellow' ? 'Stale' : 'Offline';
  const lastSeen = m?.captured_at ? timeAgo(m.captured_at) : 'Never';

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`Cluster ${cluster.name}, ${pctDisplay} used${alertSummary.count > 0 ? `, ${alertSummary.count} alert(s)` : ''}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect && onSelect(cluster.id); } }}
        onClick={() => onSelect && onSelect(cluster.id)}
        className="shadow-panel"
        style={{
          border: `1px solid ${selected ? 'var(--co-brand)' : isPulsing ? 'var(--co-crit)' : 'var(--co-border)'}`,
          background: selected ? 'rgba(108,179,63,0.1)' : 'var(--co-surface)',
          borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer', transition: 'all 200ms',
          animation: isPulsing ? 'pulse-critical 1.8s ease-in-out infinite' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span title={`${orbLabel} · Last seen: ${lastSeen}`} style={{ display: 'inline-block', flexShrink: 0, width: 8, height: 8, borderRadius: '50%', backgroundColor: orbColor, boxShadow: `0 0 4px ${orbColor}99`, animation: st === 'green' ? 'orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
              <p className="truncate" style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: 0, lineHeight: 1.2 }}>{cluster.name}</p>
            </div>
            {tags.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                {tags.map((tag) => (
                  <button key={tag} type="button" onClick={(e) => { e.stopPropagation(); onTagClick && onTagClick(tag); }}
                    style={{ fontSize: 11, color: 'var(--co-brand)', background: 'rgba(108,179,63,0.05)', border: '1px solid rgba(108,179,63,0.2)', padding: '1px 6px', borderRadius: 999, cursor: 'pointer' }}>
                    {tag}
                  </button>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: 0 }}>{cluster.connection_type === 'helios' ? 'Helios' : cluster.vip || 'Direct'}</p>
            )}
          </div>
          {alertSummary.count > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 12, fontWeight: 600, color: alertSummary.level === 'critical' ? 'var(--co-crit)' : alertSummary.level === 'warning' ? 'var(--co-warn)' : 'var(--co-ink-muted)' }}>
              <AlertOctagon size={11} /> {alertSummary.count}
            </span>
          )}
        </div>

        {metricsError ? (
          <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', fontStyle: 'italic', margin: '4px 0 0' }}>Data unavailable</p>
        ) : (
          <>
            <div className="tnum" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: pctColor }} aria-hidden="true">{pctDisplay}</div>
            <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, background: 'var(--co-surface-base)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 999, width: `${pct}%`, background: pctColor, transition: 'width 500ms' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', marginTop: 2 }}>
              <div><p style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: 0 }}>Used</p><p style={{ fontSize: 12, color: 'var(--co-ink)', fontWeight: 500, margin: 0 }}>{formatTB(used)}</p></div>
              <div><p style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: 0 }}>Capacity</p><p style={{ fontSize: 12, color: 'var(--co-ink)', fontWeight: 500, margin: 0 }}>{formatTB(total)}</p></div>
              <div><p style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: 0 }}>Available</p><p style={{ fontSize: 12, color: 'var(--co-ink)', fontWeight: 500, margin: 0 }}>{formatTB(available > 0 ? available : null)}</p></div>
              <div><p style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: 0 }}>Savings</p><p style={{ fontSize: 12, color: 'var(--co-ink)', fontWeight: 500, margin: 0 }}>{savings != null && savings > 0 ? `${savings.toFixed(2)}x` : '—'}</p></div>
            </div>
            {sparkRows.length >= 2 && <div style={{ marginTop: 4, opacity: 0.6 }} aria-hidden="true"><SparkLine rows={sparkRows} color={pctColor} /></div>}
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          {metrics?.software_version ? <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: 0 }}>v{metrics.software_version}</p> : <span />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {aiEnabled && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setAiOpen(true); }}
                style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--co-brand)', border: '1px solid rgba(108,179,63,0.3)', background: 'rgba(108,179,63,0.05)', borderRadius: 6, padding: '2px 6px', cursor: 'pointer' }}>
                ✨ AI
              </button>
            )}
            <button type="button" onClick={(e) => { e.stopPropagation(); setHardwareOpen(true); }}
              style={{ fontSize: 11, color: 'var(--co-ink-faint)', border: '1px solid var(--co-border)', borderRadius: 6, padding: '2px 6px', background: 'transparent', cursor: 'pointer' }}>
              HW Info
            </button>
          </div>
        </div>
      </div>

      {hardwareOpen && <HardwareModal cluster={cluster} onClose={() => setHardwareOpen(false)} />}
      {aiOpen && <ClusterAIModal cluster={cluster} mode="system" onClose={() => setAiOpen(false)} />}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * InsightsPanel — cross-cluster intelligent insights feed
 * ────────────────────────────────────────────────────────────────────── */
const SEVERITY = {
  critical: { icon: AlertOctagon, color: 'var(--co-crit)', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  warning: { icon: X, color: 'var(--co-warn)', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.3)' },
  info: { icon: Info, color: 'var(--co-info)', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.3)' },
  ok: { icon: CheckCircle2, color: 'var(--co-ok)', bg: 'rgba(52,211,153,0.1)', border: 'rgba(52,211,153,0.3)' },
};

const CATEGORY_ICON = {
  capacity: Database, availability: WifiOff, alerts: Bell, protection: ShieldAlert,
  replication: ArrowLeftRight, efficiency: Gauge, governance: ClipboardCheck, health: CheckCircle2,
};

function insightRoute(insight) {
  switch (insight.category) {
    case 'alerts': return insight.clusterId != null ? `/cohesity/alerts?clusterId=${insight.clusterId}` : '/cohesity/alerts';
    case 'capacity': case 'availability': case 'efficiency': return '/cohesity/clusters';
    default: return null; // protection/replication/governance live on WP-D pages — no deep link here yet
  }
}

function InsightRow({ insight, onAskAi }) {
  const sev = SEVERITY[insight.severity] || SEVERITY.info;
  const SevIcon = sev.icon;
  const CatIcon = CATEGORY_ICON[insight.category] || Info;
  const navigate = window.ReactRouterDOM.useNavigate();
  const route = insightRoute(insight);
  return (
    <div
      onClick={route ? () => navigate(route) : undefined}
      role={route ? 'button' : undefined}
      tabIndex={route ? 0 : undefined}
      onKeyDown={route ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(route); } } : undefined}
      className="animate-fade-in"
      style={{ borderRadius: 8, border: `1px solid ${sev.border}`, background: sev.bg, padding: '10px 14px', display: 'flex', gap: 10, textAlign: 'left', width: '100%', cursor: route ? 'pointer' : 'default', boxSizing: 'border-box' }}
    >
      <SevIcon size={16} style={{ color: sev.color, flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: 0, lineHeight: 1.375 }}>{insight.title}</p>
          <Badge tone="neutral"><CatIcon size={10} />{insight.category}</Badge>
          {insight.clusterId != null && onAskAi && (
            <button onClick={(e) => { e.stopPropagation(); onAskAi(insight); }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--co-brand)', border: '1px solid rgba(108,179,63,0.3)', background: 'rgba(108,179,63,0.05)', borderRadius: 6, padding: '1px 6px', cursor: 'pointer' }}>
              <Sparkles size={11} /> Ask AI
            </button>
          )}
        </div>
        {insight.detail && <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', marginTop: 4, lineHeight: 1.6 }}>{insight.detail}</p>}
        {insight.recommendation && (
          <p style={{ fontSize: 12, marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6 }}>
            <Lightbulb size={13} style={{ color: 'var(--co-brand)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ color: 'var(--co-ink)' }}><span style={{ fontWeight: 600, color: 'var(--co-brand)' }}>Recommended:</span> {insight.recommendation}</span>
          </p>
        )}
      </div>
      {route && <ChevronRight size={16} style={{ color: 'var(--co-ink-faint)', alignSelf: 'center', flexShrink: 0 }} />}
    </div>
  );
}

const COLLAPSED_COUNT = 4;

export function InsightsPanel({ initialData = null }) {
  const [data, setData] = React.useState(initialData);
  const [loading, setLoading] = React.useState(!initialData);
  const [error, setError] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [aiCluster, setAiCluster] = React.useState(null);
  const aiEnabled = useAiEnabled();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try { setData(await apiFetch('/cohesity/insights')); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { if (initialData) { setData(initialData); setLoading(false); } }, [initialData]);
  React.useEffect(() => {
    if (!initialData) load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const insights = data?.insights || [];
  const visible = expanded ? insights : insights.slice(0, COLLAPSED_COUNT);
  const summary = data?.summary;

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}>
            <Sparkles size={14} style={{ color: 'var(--co-brand)' }} />
          </div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Intelligent Insights</p>
          {summary && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              {summary.critical > 0 && <Badge tone="crit">{summary.critical} critical</Badge>}
              {summary.warning > 0 && <Badge tone="warn">{summary.warning} warning</Badge>}
              {summary.info > 0 && <Badge tone="info">{summary.info} info</Badge>}
              {summary.critical === 0 && summary.warning === 0 && summary.info === 0 && <Badge tone="ok">All clear</Badge>}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.generatedAt && <span style={{ fontSize: 10, color: 'var(--co-ink-faint)' }}>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>}
          <button onClick={load} disabled={loading} aria-label="Refresh insights"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: '1px solid var(--co-border)', color: 'var(--co-ink-muted)', background: 'transparent', cursor: 'pointer' }}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0', justifyContent: 'center', color: 'var(--co-ink-muted)', fontSize: 12 }} role="status">
          <Spinner size={16} /> Analyzing estate for risks and recommendations&hellip;
        </div>
      ) : error ? (
        <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', padding: '16px 0', textAlign: 'center' }}>
          Could not load insights. <button onClick={load} style={{ color: 'var(--co-brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map((ins, i) => (
              <InsightRow key={`${ins.category}-${ins.clusterId ?? 'g'}-${i}`} insight={ins} onAskAi={aiEnabled ? (x) => setAiCluster({ id: x.clusterId, name: x.clusterName }) : undefined} />
            ))}
          </div>
          {insights.length > COLLAPSED_COUNT && (
            <button onClick={() => setExpanded((e) => !e)} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, color: 'var(--co-brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
              {expanded ? <><ChevronUp size={14} /> Show fewer</> : <><ChevronDown size={14} /> Show all {insights.length} insights</>}
            </button>
          )}
        </>
      )}

      {aiCluster && <ClusterAIModal cluster={aiCluster} mode="alerts" onClose={() => setAiCluster(null)} />}
    </div>
  );
}
