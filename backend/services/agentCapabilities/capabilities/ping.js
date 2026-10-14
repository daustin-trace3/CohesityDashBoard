// ICMP echo through the system ping. Raw ICMP sockets need root, so the
// binary is called with fixed arguments and no shell; the target address is
// passed as one argument and comes from ICC inventory, never from the model.
const { execFile } = require('child_process');

const WIN = process.platform === 'win32';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function parse(out) {
  const s = String(out || '');
  let loss = null; let avg = null;
  const l = /\(?(\d+)% (?:packet )?loss/i.exec(s);
  if (l) loss = Number(l[1]);
  const w = /Average = (\d+)ms/i.exec(s);
  const u = /= [\d.]+\/([\d.]+)\/[\d.]+/.exec(s);
  if (w) avg = Number(w[1]); else if (u) avg = Number(u[1]);
  return { loss, avg };
}

module.exports = {
  id: 'ping',
  label: 'Ping',
  description: 'Sends two ICMP echo requests to the host or source address from the ICC server and reports reply and round-trip time. A failure means ICC cannot reach it from where it runs, which is not the same as the target being down.',
  risk: 'network-probe',
  defaultEnabled: false,
  run(target) {
    const addr = String(target.address || '');
    if (!addr || /[^A-Za-z0-9.:_-]/.test(addr)) return { ok: false, summary: 'address not safe to pass to ping' };
    const args = WIN ? ['-n', '2', '-w', '1500', addr] : ['-c', '2', '-W', '2', addr];
    return new Promise((resolve) => {
      execFile('ping', args, { timeout: 3500, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
        const { loss, avg } = parse(`${stdout}\n${stderr}`);
        const reachable = loss != null ? loss < 100 : !err;
        // Windows prints a "Reply from" line for unreachable notices too, so
        // the loss figure is the verdict, the exit code only a fallback.
        resolve({
          ok: reachable,
          summary: reachable ? `replied${avg != null ? `, ${avg} ms average` : ''}${loss ? `, ${loss}% loss` : ''}` : `no reply${err && !loss ? ` (${err.code === 'ENOENT' ? 'ping binary not found' : err.message.split('\n')[0]})` : ''}`,
          data: { address: addr, lossPct: loss, avgMs: avg, isIp: IPV4.test(addr) },
        });
      });
    });
  },
};
