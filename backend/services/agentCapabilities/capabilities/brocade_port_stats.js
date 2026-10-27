// Deep pass: live FC port counters (CRC errors, invalid words, throughput
// frames) for the switch ports a host is logged in on, or the worst ports of
// a Brocade switch that is itself the target. brocadeApi.fetchPortStats goes
// through the SANnav FOS proxy with the stored source row; the API module
// handles the credentials. One call per switch involved, at most two.
const L = require('./lib');

const marks = (a) => a.map(() => '?').join(',');
const MAX_SWITCHES = 2;

function portKey(slot, port) { return `${slot == null ? 0 : slot}/${port}`; }

/** { mode: 'host'|'switch', groups: [{ sourceId, switch, ports: Set }] } or null. */
function resolve(target) {
  const forms = L.nameForms(target);
  if (!forms.length) return null;
  const sw = L.sq(`SELECT * FROM brocade_switches WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
  if (sw) return { mode: 'switch', groups: [{ sourceId: sw.source_id, switch: sw, ports: null }] };
  const rows = L.sqAll(
    `SELECT source_id, switch_wwn, switch_name, slot_number, port_number FROM brocade_device_ports
      WHERE port_number IS NOT NULL AND (lower(COALESCE(fdmi_host_name,'')) IN (${marks(forms)}) OR lower(COALESCE(enclosure_name,'')) IN (${marks(forms)})
        OR lower(COALESCE(device_symbolic_name,'')) IN (${marks(forms)})) LIMIT 64`,
    ...forms, ...forms, ...forms,
  );
  if (!rows.length) return null;
  const bySwitch = new Map();
  for (const r of rows) {
    const key = `${r.source_id}|${r.switch_wwn || r.switch_name}`;
    if (!bySwitch.has(key)) {
      const switchRow = L.sq('SELECT * FROM brocade_switches WHERE source_id = ? AND (wwn = ? OR lower(name) = lower(?)) LIMIT 1', r.source_id, r.switch_wwn || '', r.switch_name || '');
      if (!switchRow) continue;
      bySwitch.set(key, { sourceId: r.source_id, switch: switchRow, ports: new Set(), label: r.switch_name || switchRow.name });
    }
    bySwitch.get(key).ports.add(portKey(r.slot_number, r.port_number));
  }
  const groups = [...bySwitch.values()];
  return groups.length ? { mode: 'host', groups } : null;
}

module.exports = {
  id: 'brocade_port_stats',
  label: 'Brocade port counters (live)',
  description: 'Reads the current Fibre Channel error and frame counters (CRC errors, invalid transmission words) of the switch ports the host is logged in on, through SANnav. For a switch target it lists the ports with errors. One read-only call per switch.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target) { return !!resolve(target); },
  async run(target) {
    const r = resolve(target);
    if (!r) return { ok: false, summary: 'no switch ports on record for this target', data: { lines: [] } };
    const api = L.api('brocadeApi');
    const out = [];
    let calls = 0;
    for (const g of r.groups.slice(0, MAX_SWITCHES)) {
      const source = L.sq('SELECT * FROM brocade_sources WHERE id = ?', g.sourceId);
      if (!source || !g.switch.ip_address) continue;
      const vf = g.switch.virtual_fabric_id;
      const stats = await api.fetchPortStats(source, { switchIp: g.switch.ip_address, vfId: vf != null && vf >= 0 ? vf : -1 });
      calls += 1;
      const swName = g.switch.name || g.label;
      for (const s of Array.isArray(stats) ? stats : []) {
        if (g.ports && !g.ports.has(String(s.name))) continue;
        if (!g.ports && !(s.crcErrors > 0 || s.invalidWords > 0)) continue;
        out.push({ swName, name: s.name, crc: s.crcErrors, words: s.invalidWords, inF: s.inFrames, outF: s.outFrames });
      }
    }
    out.sort((a, b) => ((b.crc || 0) + (b.words || 0)) - ((a.crc || 0) + (a.words || 0)));
    const lines = L.boundLines(out.map((p) => `${p.swName} ${p.name}: crc ${p.crc ?? 'n/a'}, invalid words ${p.words ?? 'n/a'}, in frames ${p.inF ?? 'n/a'}, out frames ${p.outF ?? 'n/a'}`));
    const withErrors = out.filter((p) => p.crc > 0 || p.words > 0).length;
    return {
      ok: calls > 0,
      summary: calls ? `${out.length} port(s) read on ${calls} switch(es), ${withErrors} with CRC or invalid-word errors` : 'no switch could be queried (no source or address on record)',
      data: { lines, total: out.length },
    };
  },
};
