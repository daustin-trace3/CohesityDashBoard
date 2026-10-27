// Deep pass: the iDRAC hardware log of the Dell server in the incident, read
// live through OpenManage Enterprise. dellOmeApi.fetchHardwareLogs takes the
// stored OME row and handles the credentials; one page is enough for the
// last day of a server's log.
const L = require('./lib');

const marks = (a) => a.map(() => '?').join(',');

/** { ome, device } or null. */
function resolve(target) {
  const forms = L.nameForms(target);
  if (!forms.length) return null;
  const device = L.sq(
    `SELECT ome_id, device_id, name, service_tag FROM dell_devices
      WHERE lower(name) IN (${marks(forms)}) OR lower(COALESCE(service_tag,'')) IN (${marks(forms)}) OR lower(COALESCE(os_hostname,'')) IN (${marks(forms)}) LIMIT 1`,
    ...forms, ...forms, ...forms,
  );
  if (!device) return null;
  const ome = L.sq('SELECT * FROM dell_ome_instances WHERE id = ?', device.ome_id);
  return ome ? { ome, device } : null;
}

module.exports = {
  id: 'dell_hardware_log',
  label: 'Dell iDRAC hardware log (live)',
  description: 'Reads the hardware log (SEL and Lifecycle entries) of the Dell server through OpenManage Enterprise for the 24 hours before the incident began: time, severity, message id and text. One read-only call.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target) { return !!resolve(target); },
  async run(target, ctx) {
    const r = resolve(target);
    if (!r) return { ok: false, summary: 'no Dell device record for this target', data: { lines: [] } };
    const sinceMs = L.onsetMs(ctx) - 24 * L.HOUR;
    // Facts-sheet note: fetchHardwareLogsSince takes a sequence number, not a time, and a null
    // sequence walks up to 40 pages. fetchHardwareLogs with one page is bounded and the window
    // filter below does the time cut.
    const rows = await L.api('dellOmeApi').fetchHardwareLogs(r.ome, r.device.device_id, 1);
    const recent = (Array.isArray(rows) ? rows : [])
      .filter((x) => { const t = L.toMs(x.createdAt); return !Number.isFinite(t) || t >= sinceMs; })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const lines = L.boundLines(recent.map((x) => `${x.createdAt || 'unknown time'} ${x.severity} ${x.messageId || 'no id'}: ${x.message || ''}`));
    const bad = recent.filter((x) => x.severity !== 'info').length;
    return {
      ok: true,
      summary: `${recent.length} hardware log entr${recent.length === 1 ? 'y' : 'ies'} for ${r.device.name || r.device.service_tag} in the 24 hours before onset, ${bad} above info`,
      data: { lines, total: recent.length },
    };
  },
};
