// Deep pass: Zerto events for the last hour before onset, read live from the
// Zerto Analytics API and filtered to the VPG, VM or site in the incident.
// Zerto's configuration is global (no source row), so the API module reads
// its own stored credentials; this file never touches them.
const L = require('./lib');

function zertoConfigured() {
  try { return !!L.api('zertoApi').zertoConfigured(); } catch { return false; }
}

function hasZertoAlert(ctx) {
  return ((ctx && ctx.alerts) || []).some((a) => a.platform === 'zerto' && !a.cleared_at);
}

module.exports = {
  id: 'zerto_events_live',
  label: 'Zerto events (live)',
  description: 'Queries Zerto for events in the hour before the incident began and keeps the ones that mention the VPG, VM or site in the incident: time, type and description. One read-only call.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target, ctx) {
    if (!zertoConfigured()) return false;
    if (L.targetPlatforms(target).has('zerto') || hasZertoAlert(ctx)) return true;
    return false;
  },
  async run(target, ctx) {
    const forms = L.nameForms(target).filter((f) => f.length >= 3);
    const alertText = ((ctx && ctx.alerts) || []).filter((a) => a.platform === 'zerto').map((a) => String(a.host || '').toLowerCase()).filter((f) => f.length >= 3);
    const needles = [...new Set([...forms, ...alertText])];
    const startMs = L.onsetMs(ctx) - L.HOUR;
    const res = await L.api('zertoApi').fetchEvents({ startDate: L.isoAt(startMs), endDate: L.isoAt(Date.now()) });
    const events = Array.isArray(res) ? res : (res && res.events) || [];
    const mine = events.filter((e) => {
      const hay = `${e.description || ''} ${e.site_name || (e.site && e.site.name) || ''}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    }).sort((a, b) => String(b.occurredOn || b.occurred_on).localeCompare(String(a.occurredOn || a.occurred_on)));
    const lines = L.boundLines(mine.map((e) => `${e.occurredOn || e.occurred_on} ${e.eventType || e.event_type || e.type || 'event'} ${e.description || ''}`));
    return {
      ok: true,
      summary: `${mine.length} of ${events.length} Zerto event(s) in the hour before onset mention ${needles.slice(0, 3).join(', ') || 'this target'}`,
      data: { lines, total: mine.length },
    };
  },
};
