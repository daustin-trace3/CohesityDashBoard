// TCP connect to the fixed management ports for the target's kind. A plain
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

module.exports = {
  id: 'tcp_port',
  label: 'TCP port check',
  description: 'Opens a TCP connection to the management ports ICC knows for that kind of system (443 for every platform source, plus 902 for ESX hosts, 22 for switches and appliances, 9669 for Zerto) and closes it at once. Nothing is sent on the connection.',
  risk: 'network-probe',
  defaultEnabled: false,
  async run(target) {
    const ports = Array.isArray(target.ports) && target.ports.length ? target.ports : [443];
    const results = await Promise.all(ports.map((p) => probe(target.address, p, 3000)));
    const open = results.filter((r) => r.open);
    return {
      ok: open.length > 0,
      summary: results.map((r) => `${r.port} ${r.open ? `open (${r.latencyMs} ms)` : `closed or filtered (${r.error})`}`).join(', '),
      data: { address: target.address, ports: results },
    };
  },
};
