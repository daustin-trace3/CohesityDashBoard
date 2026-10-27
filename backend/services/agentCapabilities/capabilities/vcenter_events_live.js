// Deep pass: vCenter events for the host or VM in the incident, read live
// from the vCenter that manages it. One SOAP event query (fetchEvents); the
// stored vcenter row goes to the API module, which handles the credentials.
const L = require('./lib');

const marks = (a) => a.map(() => '?').join(',');
const SHORT = "lower(substr(name, 1, instr(name || '.', '.') - 1))";

/** { vc, entity } or null. entity = lower-case name to filter events on, null = all (a vCenter source). */
function resolve(target) {
  const src = target.source;
  if (src && src.platform === 'vcenter') {
    const vc = src.row || L.sq('SELECT * FROM vcenter_vcenters WHERE id = ?', Number(src.id));
    return vc ? { vc, entity: null } : null;
  }
  const forms = L.nameForms(target);
  if (!forms.length) return null;
  const h = L.sq(`SELECT vcenter_id, name FROM vcenter_hosts WHERE lower(name) IN (${marks(forms)}) OR ${SHORT} IN (${marks(forms)}) LIMIT 1`, ...forms, ...forms);
  const v = h ? null : L.sq(`SELECT vcenter_id, name FROM vcenter_vms WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
  const row = h || v;
  if (!row) return null;
  const vc = L.sq('SELECT * FROM vcenter_vcenters WHERE id = ?', row.vcenter_id);
  return vc ? { vc, entity: String(row.name).toLowerCase() } : null;
}

module.exports = {
  id: 'vcenter_events_live',
  label: 'vCenter events (live)',
  description: 'Queries the vCenter that manages the host or VM for events in the hour before the incident began and shows the ones for that host or VM. One read-only SOAP query.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target) { return !!resolve(target); },
  async run(target, ctx) {
    const r = resolve(target);
    if (!r) return { ok: false, summary: 'no vCenter record for this target', data: { lines: [] } };
    const since = L.isoAt(L.onsetMs(ctx) - L.HOUR);
    const all = await L.api('vcenterApi').fetchEvents(r.vc, since);
    const short = r.entity ? r.entity.split('.')[0] : null;
    const mine = (Array.isArray(all) ? all : []).filter((e) => {
      if (!r.entity) return e.severity === 'error' || e.severity === 'warning';
      const n = String(e.entityName || '').toLowerCase();
      return n === r.entity || n.split('.')[0] === short;
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const lines = L.boundLines(mine.map((e) => `${e.createdAt} ${e.eventType || e.severity} ${e.message || ''}`));
    return {
      ok: true,
      summary: `${mine.length} event(s) for ${r.entity || r.vc.name} since ${since}, newest ${Math.min(lines.length, mine.length)} shown`,
      data: { lines, total: mine.length },
    };
  },
};
