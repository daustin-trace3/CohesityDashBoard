// Demo history for the Ops > Service Status page (LogicMonitor service groups).
//
// seedServiceGroupsHistory(db, { now }) reads the picked services the demo
// already has (lm_service_groups) with their live rollup, and writes 30 days
// of state changes per service into service_group_status_timeline. Mostly ok;
// Firewalls has a two day degraded stretch about six days ago, Core one failed
// hour three days ago, Branch is degraded for part of yesterday. The last row
// always carries the live state so today's dot matches the service rollup.
// Idempotent: each service's rows are deleted before they are written.
const H = 3600000;
const D = 24 * H;

// label keyword -> [{ from, to (ms ago), state }]
const STORIES = [
  { match: /firewall/i, spans: [{ from: 7 * D, to: 5 * D, state: 'degraded' }] },
  { match: /core/i, spans: [{ from: 3 * D + H, to: 3 * D, state: 'failed' }] },
  { match: /branch/i, spans: [{ from: 30 * H, to: 18 * H, state: 'degraded' }] },
];

function reasonFor(state, svc) {
  const c = svc.counts || { crit: 0, warn: 0, ok: 0, total: 0 };
  if (state === 'ok') return 'All devices healthy';
  if (state === 'failed') return `${Math.max(1, c.crit || 0)} failed, ${c.warn || 0} degraded of ${c.total || 0} devices`;
  return `${Math.max(1, c.warn || 0)} degraded of ${c.total || 0} devices`;
}

function seedServiceGroupsHistory(db, { now = Date.now() } = {}) {
  let list = [];
  try {
    list = require('../../services/logicmonitorGroups').services(db);
  } catch (err) {
    return { services: 0, rows: 0 };
  }
  if (!list.length) return { services: 0, rows: 0 };

  const del = db.prepare('DELETE FROM service_group_status_timeline WHERE service_id = ?');
  const ins = db.prepare('INSERT INTO service_group_status_timeline (service_id, label, state, at, reason, counts_json) VALUES (?, ?, ?, ?, ?, ?)');
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  let rows = 0;

  db.transaction(() => {
    for (const svc of list) {
      del.run(svc.serviceId);
      const story = STORIES.find((s) => s.match.test(svc.label || ''));
      const points = [{ msAgo: 30 * D - H, state: 'ok' }];
      if (story) {
        for (const span of story.spans) {
          points.push({ msAgo: span.from, state: span.state });
          points.push({ msAgo: span.to, state: 'ok' });
        }
      }
      points.sort((a, b) => b.msAgo - a.msAgo);
      // The newest row is the live state, a few minutes old.
      points.push({ msAgo: 5 * 60000, state: svc.state });

      let last = null;
      for (const p of points) {
        if (p.state === last) continue;
        last = p.state;
        ins.run(svc.serviceId, svc.label || null, p.state, at(p.msAgo), reasonFor(p.state, svc), JSON.stringify(svc.counts || {}));
        rows += 1;
      }
    }
  })();
  return { services: list.length, rows };
}

module.exports = { seedServiceGroupsHistory };
