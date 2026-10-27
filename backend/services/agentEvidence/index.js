// Ops Agent platform evidence: one provider per platform reads what ICC itself
// has recorded about the systems in an incident (state, components, the
// platform's own alerts, events, history, protection) and returns a block of
// plain sentences for the triage prompt, the email and the modal. Providers
// run over the tables the pollers fill, so they work for built-in and
// pack-served platforms alike. The list is static because the compiled build
// cannot readdir.
const logger = require('../../utils/logger');
const registry = require('../../core/registry');
const { getSetting } = require('../settings');
const { clip, LINE_CHARS } = require('./util');

const PROVIDERS = [
  require('./cohesity'), require('./vcenter'), require('./pure'), require('./netapp'),
  require('./zerto'), require('./dell'), require('./brocade'),
];
const PLATFORM_EVIDENCE_CHAR_CAP = 6000;
const DEFAULT_PLATFORM_LINES = 12;
const MIN_LINES = 2;

/** Cohesity is compiled in without a manifest; every other platform is a registry entry. */
function platformOn(id) {
  if (id === 'cohesity') return getSetting('platform_cohesity_enabled') !== '0';
  try { const p = registry.getPlugin(id); return !!(p && p.enabled && p.status !== 'error'); } catch { return false; }
}

const blockChars = (b) => b.title.length + b.lines.reduce((n, l) => n + l.length, 0);

/**
 * gather(db, ctx) -> { blocks, chars }
 * ctx = { platforms, hosts: [{ host, platform }], subject, alerts, anchorMs, parentPlatform, budgets }
 */
function gather(db, ctx) {
  const c = ctx || {};
  const order = [...(c.platforms || [])];
  if (c.parentPlatform && !order.includes(c.parentPlatform)) order.push(c.parentPlatform);
  const budgets = c.budgets || {};
  const blocks = [];
  for (const id of [...new Set(order)]) {
    const provider = PROVIDERS.find((p) => p.platform === id);
    if (!provider || !platformOn(id)) continue;
    try {
      const block = provider.run(db, c);
      if (!block || !block.lines || !block.lines.length) continue;
      const limit = Math.max(MIN_LINES, Number(budgets[id] && budgets[id].platformLines) || DEFAULT_PLATFORM_LINES);
      block.lines = block.lines.slice(0, limit).map((l) => clip(l, LINE_CHARS));
      blocks.push(block);
    } catch (err) {
      logger.warn(`[OpsAgent] platform evidence ${id} skipped: ${err.message}`);
    }
  }
  // Total cap: trim the last block first, then work backwards, never below two lines each.
  let chars = blocks.reduce((n, b) => n + blockChars(b), 0);
  for (let i = blocks.length - 1; i >= 0 && chars > PLATFORM_EVIDENCE_CHAR_CAP; i -= 1) {
    const b = blocks[i];
    while (chars > PLATFORM_EVIDENCE_CHAR_CAP && b.lines.length > MIN_LINES) {
      chars -= b.lines.pop().length;
    }
  }
  return { blocks, chars };
}

module.exports = { gather, PROVIDERS, platformOn, PLATFORM_EVIDENCE_CHAR_CAP };
