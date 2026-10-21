// TCP connect to the ports the platform profile lists for the target's kind
// (polled source, ESX host, VM guest by OS family, or device). A plain
// connect-then-close, no payload, so it says whether the port answers and
// how fast, nothing about what is behind it.
const net = require('net');

function probe(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: address, port, timeout: timeoutMs });
    const done = (open, error) => { try { sock.destroy(); } catch { /* ignore */ } resolve({ port, open, latencyMs: Date.now() - t0, error: error || null }); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timed out'));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

/** Port entries of a target: { port, label, expect } objects, or bare numbers
 *  (expected). portEntries wins over ports; nothing listed means nothing to probe. */
function entriesOf(target) {
  const raw = Array.isArray(target.portEntries) && target.portEntries.length ? target.portEntries
    : Array.isArray(target.ports) ? target.ports : [];
  return raw.map((e) => (e && typeof e === 'object'
    ? { port: Number(e.port), label: String(e.label || ''), expect: e.expect !== false }
    : { port: Number(e), label: '', expect: true })).filter((e) => Number.isInteger(e.port) && e.port > 0);
}

const named = (r) => `${r.port}${r.label ? ` ${r.label}` : ''}`;
const state = (r, withLatency) => (r.open ? (withLatency ? ` (${r.latencyMs} ms)` : ' open') : ` closed (${r.error})`);

module.exports = {
  id: 'tcp_port',
  label: 'TCP port check',
  description: 'Opens a TCP connection to the ports the platform profile lists for that kind of system (a polled source, an ESX host, a VM guest by operating system, or a device) and closes it at once. Nothing is sent on the connection. Edit the port map under Global Settings > Platform profiles.',
  risk: 'network-probe',
  defaultEnabled: false,
  appliesTo(target) { return entriesOf(target).length > 0; },
  async run(target) {
    const entries = entriesOf(target);
    const ports = entries.length ? entries : [{ port: 443, label: '', expect: true }];
    const probed = await Promise.all(ports.map((e) => probe(target.address, e.port, 3000)));
    const results = probed.map((r, i) => ({ port: r.port, label: ports[i].label, expect: ports[i].expect, open: r.open, latencyMs: r.latencyMs, error: r.error }));
    const expected = results.filter((r) => r.expect);
    const other = results.filter((r) => !r.expect);
    const openCount = results.filter((r) => r.open).length;
    let summary;
    let ok;
    if (expected.length) {
      const expOpen = expected.filter((r) => r.open).length;
      ok = expOpen === expected.length;
      summary = `${expOpen} of ${expected.length} expected open: ${expected.map((r) => `${named(r)}${state(r, true)}`).join(', ')}`;
      if (other.length) summary += `; not expected from ICC: ${other.map((r) => `${named(r)}${state(r, false)}`).join(', ')}`;
    } else {
      ok = openCount > 0;
      summary = `${openCount} of ${results.length} open: ${results.map((r) => `${named(r)}${r.open ? ` open (${r.latencyMs} ms)` : ` closed or filtered (${r.error})`}`).join(', ')}`;
    }
    return { ok, summary, data: { address: target.address, ports: results } };
  },
};
