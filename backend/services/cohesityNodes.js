'use strict';

// Per-node identity for each Cohesity cluster, stored in cohesity_nodes so
// cross-platform matching (hostIdentity, Server 360) does not need a live call.
//
// UNVERIFIED against a live cluster: the hostname key casing on
// /irisservices/api/v1/public/nodes (hostName, hostname and nodeHostName are all
// accepted), and which ip fields exist (ip, ipv6, nodeIp, ips[]).
// Every field is probe-first: absence stores null, it never throws.

const db = require('../db/database');
const logger = require('../utils/logger');

/**
 * Same merge routes/hardware.js does for the live node response: V2 serial and
 * model injected into the V1 node by node id.
 */
function mergeNodes(nodes, nodesV2) {
  const v2ById = {};
  for (const n of nodesV2 || []) {
    const nid = n.id ?? n.nodeId;
    if (nid != null) v2ById[String(nid)] = n;
  }
  return (nodes || []).map((node) => {
    const nid = String(node.id ?? node.nodeId ?? '');
    const v2 = v2ById[nid];
    if (!v2) return node;
    return {
      ...node,
      _v2Serial: v2.serialNumber || v2.serial || null,
      _v2Model: v2.hardwareModel || v2.productModel || v2.model || null,
    };
  });
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,}$/i;

function collectIps(node) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string' && IP_RE.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  };
  for (const k of ['ip', 'ipv6', 'nodeIp', 'ipAddress']) add(node[k]);
  if (Array.isArray(node.ips)) node.ips.forEach(add);
  if (Array.isArray(node.ipAddresses)) node.ipAddresses.forEach(add);
  return out;
}

/** One merged API node -> cohesity_nodes column values (node_id null when the row has no id). */
function nodeRow(node) {
  const ips = collectIps(node);
  const nid = node.id ?? node.nodeId;
  return {
    node_id: nid != null ? String(nid) : null,
    hostname: node.hostName || node.hostname || node.nodeHostName || null,
    ip: node.ip || node.nodeIp || ips[0] || null,
    ips_json: ips.length ? JSON.stringify(ips) : null,
    serial: node.cohesityNodeSerial || node._v2Serial || null,
    chassis_serial: node.chassisInfo?.chassisSerial || null,
    model: node._v2Model || node.productModel || null,
    role: node.role || null,
    status: node.nodeStatus || node.status || null,
    software_version: node.softwareVersion || null,
  };
}

/** Replace the stored node rows of one cluster. Returns the row count. */
function upsertNodes(dbh, clusterId, nodes, capturedAt = new Date().toISOString()) {
  const stmt = dbh.prepare(`
    INSERT INTO cohesity_nodes (cluster_id, node_id, hostname, ip, ips_json, serial, chassis_serial,
      model, role, status, software_version, raw_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id, node_id) DO UPDATE SET hostname = excluded.hostname, ip = excluded.ip,
      ips_json = excluded.ips_json, serial = excluded.serial, chassis_serial = excluded.chassis_serial,
      model = excluded.model, role = excluded.role, status = excluded.status,
      software_version = excluded.software_version, raw_json = excluded.raw_json, captured_at = excluded.captured_at
  `);
  let n = 0;
  dbh.transaction(() => {
    const keep = [];
    for (const node of nodes) {
      const r = nodeRow(node);
      if (r.node_id == null) continue; // the unique key needs an id
      stmt.run(clusterId, r.node_id, r.hostname, r.ip, r.ips_json, r.serial, r.chassis_serial,
        r.model, r.role, r.status, r.software_version, JSON.stringify(node), capturedAt);
      keep.push(r.node_id);
      n += 1;
    }
    // Nodes the cluster no longer lists are dropped; an empty list (failed or
    // empty fetch) leaves the old rows alone.
    if (keep.length) {
      dbh.prepare(`DELETE FROM cohesity_nodes WHERE cluster_id = ? AND node_id NOT IN (${keep.map(() => '?').join(',')})`)
        .run(clusterId, ...keep);
    }
  })();
  return n;
}

/**
 * Poll hook: fetch nodes (V1 + V2) and store them. Never throws.
 * `api` and `dbh` are injectable for tests.
 */
async function syncClusterNodes(cluster, { api, dbh } = {}) {
  try {
    const a = api || require('./cohesityApi');
    const [n1, n2] = await Promise.allSettled([a.fetchNodes(cluster), a.fetchNodesV2(cluster)]);
    const nodes = n1.status === 'fulfilled' && Array.isArray(n1.value) ? n1.value : [];
    const nodesV2 = n2.status === 'fulfilled' && Array.isArray(n2.value) ? n2.value : [];
    // Fall back to the V2 list alone when V1 is unavailable.
    const base = nodes.length ? nodes : nodesV2.map((v) => ({ ...v, cohesityNodeSerial: v.serialNumber || v.serial || null }));
    const merged = mergeNodes(base, nodesV2);
    if (!merged.length) return 0;
    return upsertNodes(dbh || db, cluster.id, merged);
  } catch (err) {
    logger.warn(`[CohesityNodes] node sync failed for cluster ${cluster?.id}: ${err.message}`);
    return 0;
  }
}

module.exports = { mergeNodes, nodeRow, collectIps, upsertNodes, syncClusterNodes };
