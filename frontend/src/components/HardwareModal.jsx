import { useEffect, useState } from 'react';
import client from '../api/client';

function statusColor(raw) {
  if (!raw) return 'text-gray-500';
  const s = raw.toLowerCase();
  if (s === 'knormal' || s === 'normal' || s === 'healthy') return 'text-cohesity-green';
  if (s === 'koffline' || s === 'offline' || s === 'dead') return 'text-red-400';
  return 'text-amber-400';
}

function statusDot(raw) {
  if (!raw) return 'bg-gray-600';
  const s = raw.toLowerCase();
  if (s === 'knormal' || s === 'normal' || s === 'healthy') return 'bg-cohesity-green';
  if (s === 'koffline' || s === 'offline' || s === 'dead') return 'bg-red-500';
  return 'bg-amber-400';
}

function friendlyStatus(raw) {
  if (!raw) return '—';
  return raw.replace(/^k/, '');
}

function getNodeSerial(node) {
  return (
    node?.cohesityNodeSerial ||
    node?._v2Serial ||
    node?.cohesityNodeInfo?.nodeHardwareInfo?.serialNumber ||
    node?.cohesityNodeInfo?.nodeHardwareInfo?.productSerial ||
    node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.serialNumber ||
    node?.serialNumber ||
    node?.productSerial ||
    node?.nodeHardwareInfo?.serialNumber ||
    '—'
  );
}

function getNodeModel(node) {
  return (
    node?._v2Model ||
    node?.cohesityNodeInfo?.nodeHardwareInfo?.productModel ||
    node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.chassisModel ||
    node?.productModel ||
    node?.model ||
    '—'
  );
}

function getNodeStatus(node) {
  return (
    node?.cohesityNodeInfo?.status ||
    node?.status ||
    null
  );
}

function getNodeChassisId(node) {
  return (
    node?.chassisInfo?.chassisId ??
    node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.chassisId ??
    node?.chassisId ??
    null
  );
}

export default function HardwareModal({ cluster, onClose }) {
  const [nodes, setNodes] = useState([]);
  const [chassis, setChassis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [collapsedChassis, setCollapsedChassis] = useState(new Set());

  useEffect(() => {
    client
      .get(`/hardware/${cluster.id}`)
      .then(({ data }) => {
        const nodeList = Array.isArray(data) ? data : (data.nodes || []);
        const chassisList = Array.isArray(data) ? [] : (data.chassis || []);
        setNodes(nodeList);
        setChassis(chassisList);
      })
      .catch((err) => setError(err.response?.data?.message || err.message))
      .finally(() => setLoading(false));
  }, [cluster.id]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const ids = new Set();
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid != null) ids.add(cid);
    }
    if (chassis.length === 0) {
      for (const node of nodes) {
        const cid =
          node?.cohesityNodeInfo?.nodeHardwareInfo?.chassisInfo?.chassisId ??
          node?.chassisId ??
          null;
        if (cid != null) ids.add(cid);
      }
    }
    if (ids.size === 0) {
      ids.add('__all__');
    }
    setCollapsedChassis(ids);
  }, [nodes, chassis]);

  const toggleChassis = (id) => setCollapsedChassis(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Build chassis groups
  // Each chassis can reference its nodes via nodeIds, or nodes can reference chassisId
  const chassisGroups = (() => {
    if (nodes.length === 0) return [];

    // Build a map: chassisId -> chassis info
    const chassisById = {};
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid != null) chassisById[cid] = c;
    }

    // Build map: chassisId -> nodes[]
    const nodesByChassis = {};
    const unassigned = [];

    // First try: chassis has nodeIds array
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid == null) continue;
      const nodeIds = c.nodeIds || c.nodes?.map(n => n.id ?? n.nodeId) || [];
      if (nodeIds.length > 0) {
        for (const nid of nodeIds) {
          const node = nodes.find(n => (n.id ?? n.nodeId) === nid || String(n.id ?? n.nodeId) === String(nid));
          if (node) {
            if (!nodesByChassis[cid]) nodesByChassis[cid] = [];
            nodesByChassis[cid].push(node);
          }
        }
      }
    }

    // Second try: nodes reference their chassisId
    const assignedNodeIds = new Set(Object.values(nodesByChassis).flat().map(n => n.id ?? n.nodeId));
    for (const node of nodes) {
      const nid = node.id ?? node.nodeId;
      if (assignedNodeIds.has(nid)) continue;
      const cid = getNodeChassisId(node);
      if (cid != null) {
        if (!nodesByChassis[cid]) nodesByChassis[cid] = [];
        nodesByChassis[cid].push(node);
      } else {
        unassigned.push(node);
      }
    }

    // Build ordered groups: chassis from API first, then any extra chassisIds found in nodes
    const groups = [];
    const seen = new Set();

    // Chassis from API
    for (const c of chassis) {
      const cid = c.id ?? c.chassisId;
      if (cid == null || seen.has(cid)) continue;
      seen.add(cid);
      if (nodesByChassis[cid]?.length > 0) {
        groups.push({ id: cid, info: c, nodes: nodesByChassis[cid] });
      }
    }

    // Extra chassis IDs found only in node data
    for (const [cid, cNodes] of Object.entries(nodesByChassis)) {
      if (seen.has(cid) || seen.has(Number(cid))) continue;
      seen.add(cid);
      groups.push({ id: cid, info: chassisById[cid] || null, nodes: cNodes });
    }

    // Unassigned nodes as a fallback group
    if (unassigned.length > 0) {
      groups.push({ id: '__unassigned__', info: null, nodes: unassigned });
    }

    // If nothing grouped, show all nodes in one group
    if (groups.length === 0) {
      groups.push({ id: '__all__', info: null, nodes });
    }

    return groups;
  })();

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cohesity-border flex-shrink-0">
          <div>
            <h2 className="text-cohesity-text font-semibold">{cluster.name}</h2>
            <p className="text-xs text-gray-400 mt-0.5">Hardware Information — {nodes.length} node(s) · {chassis.length} chassis</p>
          </div>
          <div className="flex items-center gap-2">
            {!loading && chassisGroups.length > 0 && (
              <>
                <button
                  onClick={() => setCollapsedChassis(new Set())}
                  className="text-xs px-2 py-1 border border-cohesity-border rounded text-gray-400 hover:border-cohesity-green hover:text-cohesity-green transition-colors"
                >
                  Expand All
                </button>
                <button
                  onClick={() => setCollapsedChassis(new Set(chassisGroups.map(g => g.id)))}
                  className="text-xs px-2 py-1 border border-cohesity-border rounded text-gray-400 hover:border-cohesity-green hover:text-cohesity-green transition-colors"
                >
                  Collapse All
                </button>
              </>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-cohesity-text transition-colors text-xl leading-none ml-1">×</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {loading && <p className="text-gray-400 text-sm">Loading hardware info...</p>}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {!loading && !error && nodes.length === 0 && (
            <p className="text-gray-400 text-sm">No node data available.</p>
          )}

          {!loading && nodes.length > 0 && (
            <div className="space-y-4">
              {chassisGroups.map((group) => {
                const cid = group.id;
                const info = group.info;
                const isCollapsed = collapsedChassis.has(cid);

                const chassisSerial = info?.serialNumber || group.nodes[0]?.chassisInfo?.chassisSerial || null;
                const chassisLabel = cid === '__unassigned__' ? 'Unassigned Nodes'
                  : cid === '__all__' ? 'All Nodes'
                  : info?.name || chassisSerial
                    ? `${info?.name || chassisSerial || ''} ${chassisSerial && chassisSerial !== info?.name ? `(S/N: ${chassisSerial})` : ''}`.trim()
                  : `Chassis ${cid}`;

                const chassisModel = info?.hardwareModel || info?.model || group.nodes[0]?.productModel || '—';
                const chassisSerialDisplay = chassisSerial || '—';

                return (
                  <div key={String(cid)} className="border border-cohesity-border rounded-lg overflow-hidden">
                    {/* Chassis header */}
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 bg-cohesity-black hover:bg-white hover:bg-opacity-[0.03] transition-colors"
                      onClick={() => toggleChassis(cid)}
                    >
                      <span className={`text-gray-500 text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`} style={{ display: 'inline-block' }}>▶</span>
                      <div className="flex-1 text-left">
                        <span className="text-sm font-semibold text-cohesity-text">{chassisLabel}</span>
                        {cid !== '__unassigned__' && cid !== '__all__' && (
                          <span className="ml-3 text-xs text-gray-500">
                            Model: <span className="text-gray-300">{chassisModel}</span>
                            {chassisSerialDisplay !== '—' && <> · S/N: <span className="text-gray-300 font-mono">{chassisSerialDisplay}</span></>}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-500">{group.nodes.length} node(s)</span>
                    </button>

                    {/* Nodes */}
                    {!isCollapsed && (
                      <div className="divide-y divide-cohesity-border">
                        {group.nodes.map((node, i) => {
                          const nid = node.id ?? node.nodeId ?? i;
                          const nodeStatus = getNodeStatus(node);
                          const nodeModel = getNodeModel(node);
                          const nodeSerial = getNodeSerial(node);
                          const nodeIp = node.ip || node.ipAddress || '—';
                          const swVersion = node.softwareVersion || node.cohesityNodeInfo?.softwareVersion || '—';

                          return (
                            <div key={nid} className="px-4 py-3 bg-cohesity-gray">
                              <div className="flex items-center gap-2 mb-2">
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(nodeStatus)}`} />
                                <span className="text-sm font-medium text-cohesity-text">Node {nid}</span>
                                <span className={`text-xs ${statusColor(nodeStatus)}`}>{friendlyStatus(nodeStatus)}</span>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2 text-xs pl-4">
                                <div>
                                  <p className="text-gray-500 uppercase tracking-wide text-[9px] mb-0.5">IP Address</p>
                                  <p className="text-cohesity-text font-mono">{nodeIp}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 uppercase tracking-wide text-[9px] mb-0.5">Model</p>
                                  <p className="text-cohesity-text">{nodeModel}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 uppercase tracking-wide text-[9px] mb-0.5">Serial Number</p>
                                  <p className="text-cohesity-text font-mono">{nodeSerial}</p>
                                </div>
                                {swVersion !== '—' && (
                                  <div>
                                    <p className="text-gray-500 uppercase tracking-wide text-[9px] mb-0.5">SW Version</p>
                                    <p className="text-cohesity-text">{swVersion}</p>
                                  </div>
                                )}
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
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-cohesity-border flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-cohesity-black border border-cohesity-border rounded text-sm hover:border-cohesity-green hover:text-cohesity-green transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
