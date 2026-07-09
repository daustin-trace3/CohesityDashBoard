'use strict';

// Contract C11.1 — deterministic Cohesity hardware fixtures for demo mode.
// Shaped identically to the merged { nodes, chassis } response routes/hardware.js
// returns from the live path (fetchNodes + fetchNodesV2 merged, plus fetchChassis).

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(name) {
  return mulberry32(hashSeed(name));
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

const MODELS = ['C6055', 'C4110', 'C5220'];
const SW_VERSION = '7.1.2_release-20250101_abcdef';

const _byClusterId = new Map();

function buildForCluster(clusterId, clusterName) {
  const rng = rngFor(`cluster-hw-${clusterId}-${clusterName || ''}`);
  const nodeCount = Math.round(randRange(rng, 4, 8));
  const model = MODELS[Math.floor(rng() * MODELS.length)];
  const nodesPerChassis = 4;
  const chassisCount = Math.max(1, Math.ceil(nodeCount / nodesPerChassis));

  const chassis = [];
  for (let c = 0; c < chassisCount; c++) {
    chassis.push({
      id: `demo-chassis-${clusterId}-${c}`,
      serial: `CHS${hashSeed(`${clusterId}-chassis-${c}`).toString(36).toUpperCase().slice(0, 8)}`,
      model,
      status: rng() < 0.9 ? 'kHealthy' : 'kDegraded',
    });
  }

  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const chassisIdx = Math.floor(i / nodesPerChassis);
    const chassisSerial = chassis[chassisIdx].serial;
    const roll = rng();
    const upgradeInProgress = roll > 0.93;
    const isMarkedForRemoval = !upgradeInProgress && roll > 0.88;
    nodes.push({
      id: 1000 + i,
      nodeId: 1000 + i,
      ip: `10.${(hashSeed(`${clusterId}`) % 200) + 10}.${chassisIdx}.${20 + i}`,
      productModel: model,
      cohesityNodeSerial: `CNS${hashSeed(`${clusterId}-node-${i}`).toString(36).toUpperCase().slice(0, 10)}`,
      nodeSoftwareVersion: SW_VERSION,
      slotNumber: (i % nodesPerChassis) + 1,
      diskCountByTier: [
        { storageTier: 'SATA-SSD', diskCount: Math.round(randRange(rng, 6, 12)) },
        { storageTier: 'SATA-HDD', diskCount: Math.round(randRange(rng, 0, 4)) },
      ],
      chassisInfo: { chassisSerial },
      upgradeInProgress,
      isMarkedForRemoval,
      removalState: isMarkedForRemoval ? 'kRemovalInProgress' : 'kDontRemove',
    });
  }

  return { nodes, chassis };
}

function getHardwareForCluster(clusterId, clusterName) {
  const key = String(clusterId);
  if (!_byClusterId.has(key)) _byClusterId.set(key, buildForCluster(clusterId, clusterName));
  return _byClusterId.get(key);
}

module.exports = { getHardwareForCluster };
