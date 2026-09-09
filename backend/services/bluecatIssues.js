// Computed BlueCat issues (shared by routes and the poller) plus their
// lifecycle history — unifiIssues.js model exactly. Issue identity is
// `type|source|target`.
const db = require('../db/database');
const { getSetting } = require('./settings');

function clampedInt(key, def, min, max) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
}

const lowFreeWarn = () => clampedInt('bluecat_low_free_warn', 20, 1, 10000);
const lowFreePct = () => clampedInt('bluecat_low_free_pct', 10, 1, 90);

function computeIssues() {
  const issues = [];
  const sources = db.prepare('SELECT * FROM bluecat_sources').all();
  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // source-unreachable
  for (const src of sources) {
    if (src.last_poll_status === 'error') {
      issues.push({
        severity: 'critical', type: 'source-unreachable', source: src.name, target: src.name,
        message: `BlueCat source ${src.name} is unreachable: ${src.last_poll_error || 'poll failed'}`,
      });
    }
  }

  // server-disconnected / server-deploy-failed
  for (const s of db.prepare('SELECT s.*, src.name AS source_name FROM bluecat_servers s JOIN bluecat_sources src ON src.id = s.source_id').all()) {
    const target = s.name || `server ${s.server_id}`;
    if (s.connected === 0) {
      issues.push({ severity: 'critical', type: 'server-disconnected', source: s.source_name, target,
        message: `BlueCat server ${target} is disconnected` });
    }
    if (s.last_deploy_status && /FAIL|INVALID/i.test(s.last_deploy_status)) {
      issues.push({ severity: 'warning', type: 'server-deploy-failed', source: s.source_name, target,
        message: `Last deployment to ${target} ${s.last_deploy_status}` });
    }
  }

  // network-* / gateway-unknown
  const overridesByNetwork = new Map(
    db.prepare('SELECT * FROM bluecat_network_overrides').all().map((o) => [`${o.source_id}|${o.network_id}`, o])
  );
  const warnCount = lowFreeWarn();
  const warnPct = lowFreePct();
  for (const n of db.prepare('SELECT nw.*, src.name AS source_name FROM bluecat_networks nw JOIN bluecat_sources src ON src.id = nw.source_id').all()) {
    const override = overridesByNetwork.get(`${n.source_id}|${n.network_id}`);
    const excluded = override && override.exclude_low_space === 1;
    const target = `${n.range || ''}${n.name ? ` (${n.name})` : ''}`;

    const skip = n.ip_version === 6 || n.prefix > 30 || n.counts_source == null;
    if (!skip && !excluded) {
      if (n.free_static === 0) {
        issues.push({ severity: 'critical', type: 'network-full', source: n.source_name, target,
          message: `Network ${target} has no free static addresses` });
      } else if (n.free_static != null && n.free_static > 0 && n.free_static < warnCount) {
        issues.push({ severity: 'warning', type: 'network-low-space', source: n.source_name, target,
          message: `Network ${target} has ${n.free_static} free static address(es) remaining` });
      }
      if (n.free_pct != null && n.free_pct < warnPct && n.prefix <= 24 && n.free_static != null && n.free_static >= warnCount) {
        issues.push({ severity: 'warning', type: 'network-low-pct', source: n.source_name, target,
          message: `Network ${target} is at ${n.free_pct.toFixed(1)}% free` });
      }
    }

    if (n.ip_version === 4 && n.gateway == null && n.prefix <= 30) {
      issues.push({ severity: 'info', type: 'gateway-unknown', source: n.source_name, target,
        message: `Network ${target} has no known gateway` });
    }
  }

  // dhcp-range-full / dhcp-range-low-space
  for (const r of db.prepare(`
    SELECT rg.*, nw.range AS network_range, nw.name AS network_name, nw.ip_version, nw.prefix,
           nw.source_id, nw.network_id AS nw_network_id, src.name AS source_name
    FROM bluecat_ranges rg
    JOIN bluecat_networks nw ON nw.source_id = rg.source_id AND nw.network_id = rg.network_id
    JOIN bluecat_sources src ON src.id = rg.source_id
  `).all()) {
    const override = overridesByNetwork.get(`${r.source_id}|${r.nw_network_id}`);
    if (override && override.exclude_low_space === 1) continue;
    if (r.ip_version === 6 || r.prefix > 30) continue;
    const target = `${r.start_ip || ''}-${r.end_ip || ''} in ${r.network_range || ''}`;
    if (r.free_dhcp === 0) {
      issues.push({ severity: 'critical', type: 'dhcp-range-full', source: r.source_name, target,
        message: `DHCP range ${target} is full` });
    } else if (r.free_dhcp != null && r.free_dhcp > 0 && r.free_dhcp < warnCount) {
      issues.push({ severity: 'warning', type: 'dhcp-range-low-space', source: r.source_name, target,
        message: `DHCP range ${target} has ${r.free_dhcp} free address(es) remaining` });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

const reconcileIssueHistoryTxn = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM bluecat_issue_history WHERE status = 'open'").all();

  const touch = db.prepare(`
    UPDATE bluecat_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
  `);
  const resolve = db.prepare(`
    UPDATE bluecat_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO bluecat_issue_history (issue_key, source, severity, type, target, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const openKeys = new Set();
  for (const row of open) {
    const cur = current.get(row.issue_key);
    if (cur) {
      openKeys.add(row.issue_key);
      touch.run(cur.message, cur.severity, row.id);
    } else {
      resolve.run(row.id);
    }
  }
  for (const [key, i] of current) {
    if (!openKeys.has(key)) insert.run(key, i.source, i.severity, i.type, i.target, i.message);
  }
  db.prepare("DELETE FROM bluecat_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
});

// BEGIN IMMEDIATE, same rationale as unifiIssues.js.
const reconcileIssueHistory = () => reconcileIssueHistoryTxn.immediate();

module.exports = {
  lowFreeWarn, lowFreePct,
  computeIssues, reconcileIssueHistory,
};
