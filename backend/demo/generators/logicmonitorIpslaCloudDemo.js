// Demo scenarios for round 9 WP7, called from generators/logicmonitor.js:
//   cloudDevices()          device plan entries (appended last, so no earlier id moves)
//   cloudProps(d)           bandwidth and region properties for a cloud device row
//   seedIpslaCloud(...)     lm_ds_* rows inside seedDsMetrics (reseed-safe: that
//                           function clears the source's lm_ds_* tables first)
//   seedIpslaWatch(...)     metric baselines, then the real IP SLA watch engine
//                           replayed over the stored history (after seedWatchRows,
//                           which clears every episode for the source)
//
// Scenarios:
//   ipsla-spike      slc-rtr-01 probe "ICMP echo to dal-wan-rtr-01": RTT runs about
//                    1.9x its baseline for the last 4 samples (2 hours), so the
//                    replay leaves an open degrading episode (latency-degrading).
//                    den-rtr-01 probe "ICMP echo to phx-wan-rtr-01" stays clean.
//   cloud-down       dx-dal-prod-1 (Direct Connect) reads connection state 0
//                    (cloud-circuit-down)
//   cloud-saturated  dx-phx-prod-2 (1 Gbps) runs at 87% (cloud-circuit-saturated)
//   cloud-ok         dx-phx-prod-1 (10 Gbps), er-phx-azure-east, er-dal-azure-south
// The datapoints behind these metrics are UNVERIFIED against a live portal.
const CLOUD_PLAN = {
  // Round 10: the AWS rows carry the system.aws.* properties seen on the first live portal. The two
  // phx connections belong to the demo AWS account (893373391538, see generators/aws.js); dx-dal-prod-1
  // belongs to another account so the AWS overview panel shows the filter working.
  'dx-phx-prod-1': { kind: 'aws-dx', site: 'aws', bandwidth: '10 Gbps', bwProp: '10Gbps', region: 'us-east-1', awsDevice: 'EqDC2-g2845xqir5zz', owner: '893373391538', costCenter: '524121', state: 1, util: 38 },
  'dx-phx-prod-2': { kind: 'aws-dx', site: 'aws', bandwidth: '1 Gbps', bwProp: '1Gbps', region: 'us-east-1', awsDevice: 'EqDC2-g2845xqir5zz', owner: '893373391538', costCenter: '524121', state: 1, util: 87 },
  'dx-dal-prod-1': { kind: 'aws-dx', site: 'aws', bandwidth: '10 Gbps', bwProp: '10Gbps', region: 'us-west-2', awsDevice: 'CSOR1-2k3j4h5g6f7d', owner: '417788990011', costCenter: '610442', state: 0, util: 0 },
  'er-phx-azure-east': { kind: 'azure-er', site: 'phx', bandwidth: '1 Gbps', region: 'eastus', subscription: '3f1c9a52-0d4e-4b7a-9c61-2a8e5b7d1f04', state: 1, util: 22 },
  'er-dal-azure-south': { kind: 'azure-er', site: 'dal', bandwidth: '500 Mbps', region: 'southcentralus', subscription: '3f1c9a52-0d4e-4b7a-9c61-2a8e5b7d1f04', state: 1, util: 31 },
};
const BW_BPS = { '10 Gbps': 1e10, '1 Gbps': 1e9, '500 Mbps': 5e8 };

const PROBES = [
  { device: 'den-rtr-01', key: '101', name: 'ICMP echo to phx-wan-rtr-01', base: 41, spike: false },
  { device: 'slc-rtr-01', key: '102', name: 'ICMP echo to dal-wan-rtr-01', base: 36, spike: true },
];
const SPIKE_SAMPLES = 4;
const SPIKE_FACTOR = 1.9;

function cloudDevices() {
  return Object.entries(CLOUD_PLAN).map(([name, c]) => ({ name, site: c.site, kind: c.kind }));
}

function cloudProps(d) {
  const c = CLOUD_PLAN[d.name];
  if (!c) return null;
  if (c.kind === 'aws-dx') {
    return {
      custom: [{ name: 'bandwidth', value: c.bandwidth }],
      system: [
        { name: 'system.aws.region', value: c.region }, { name: 'system.aws.awsDevice', value: c.awsDevice },
        { name: 'system.aws.bandwidth', value: c.bwProp }, { name: 'system.aws.ownerAccount', value: c.owner },
        { name: 'system.aws.tag.cost-center', value: c.costCenter },
      ],
    };
  }
  return {
    custom: [{ name: 'bandwidth', value: c.bandwidth }],
    system: [{ name: 'system.azure.location', value: c.region }, { name: 'system.azure.subscriptionId', value: c.subscription }],
  };
}

function seedIpslaCloud(devices, { put, rng, series }) {
  const byName = new Map(devices.map((d) => [d.name, d]));
  // IP SLA probes on two branch routers.
  for (const p of PROBES) {
    const dev = byName.get(p.device);
    if (!dev || dev.hostStatus !== 'normal') continue;
    const rtt = series(p.base, { amp: 0.06, jitter: 0.03, lo: 1, hi: 500 });
    if (p.spike) {
      for (let i = rtt.length - SPIKE_SAMPLES; i < rtt.length; i += 1) rtt[i] = Math.round(rtt[i] * SPIKE_FACTOR * 10) / 10;
    }
    const loss = rtt.map(() => (rng() < 0.05 ? 0.1 : 0));
    put(dev, 'CiscoSLA_ICMPEcho-', 'Cisco IP SLA ICMP Echo', 'ipsla', p.key,
      { rtt_ms: rtt[rtt.length - 1], loss_pct: 0, sla_state: 1 }, { rtt_ms: rtt, loss_pct: loss }, p.name);
  }
  // Cloud circuits.
  for (const [name, c] of Object.entries(CLOUD_PLAN)) {
    const dev = byName.get(name);
    if (!dev) continue;
    const bw = BW_BPS[c.bandwidth];
    const inBps = Math.round((bw * c.util) / 100);
    const outBps = Math.round(inBps * 0.62);
    const inHist = c.util ? series(inBps, { amp: 0.3, jitter: 0.05, lo: 0, hi: 1e12 }).map(Math.round) : null;
    const outHist = c.util ? series(outBps, { amp: 0.3, jitter: 0.05, lo: 0, hi: 1e12 }).map(Math.round) : null;
    if (c.kind === 'aws-dx') {
      put(dev, 'AWS_DirectConnect_Connection', 'AWS Direct Connect', 'cloud', name,
        { dx_state: c.state, dx_bps_in: inBps, dx_bps_out: outBps, dx_light_in: c.state ? -3.2 : null, dx_light_out: c.state ? -2.6 : null, dx_errors: 0 },
        inHist ? { dx_bps_in: inHist, dx_bps_out: outHist } : null, name);
    } else {
      put(dev, 'Azure_ExpressRoute_Circuit', 'Azure ExpressRoute', 'cloud', name,
        { er_bps_in: inBps, er_bps_out: outBps, er_bgp: 100, er_arp: 100 },
        { er_bps_in: inHist, er_bps_out: outHist }, name);
    }
  }
}

/** Metric baselines, then the IP SLA engine replayed hourly-ish over the last 3 days (after seedWatchRows). */
function seedIpslaWatch(db, { sourceId, nowMs }) {
  const out = { baselines: 0, reference: 0, opened: 0, promoted: 0, closed: 0 };
  const has = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  if (!has('lm_ds_metric_baseline') || !has('lm_ds_metrics_history')) return out;
  const t = require('../../services/logicmonitorIssues').getThresholds();
  const base = require('../../services/logicmonitorMetricBaselines').computeMetricBaselines(db, sourceId, t, { nowMs });
  out.baselines = base.written;
  out.reference = base.reference;
  const watch = require('../../services/logicmonitorWatchIpsla');
  const source = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sourceId);
  db.prepare("DELETE FROM lm_latency_episodes WHERE (source_id = ? OR source_id NOT IN (SELECT id FROM lm_sources)) AND subject_kind = 'ipsla'").run(sourceId);
  const nowS = Math.floor(nowMs / 1000);
  const step = 1800;
  const epochs = [];
  for (let e = nowS - 3 * 86400; e < nowS; e += step) epochs.push(e);
  epochs.push(nowS);
  for (const e of epochs) {
    const r = watch.evaluateIpsla(db, source, t, e);
    out.opened += r.opened; out.promoted += r.promoted; out.closed += r.closed;
  }
  return out;
}

module.exports = { cloudDevices, cloudProps, seedIpslaCloud, seedIpslaWatch, CLOUD_PLAN, PROBES };
