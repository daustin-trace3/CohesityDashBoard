// Forward and reverse DNS from the ICC server's resolver. A name that does
// not resolve, or an IP whose reverse record names a different host, is a
// common reason a management path "went away" after a change.
const dns = require('dns').promises;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

module.exports = {
  id: 'dns',
  label: 'DNS lookup',
  description: 'Resolves the target name forward and its address in reverse using the resolver the ICC server itself uses, and reports both answers.',
  risk: 'network-probe',
  defaultEnabled: false,
  async run(target) {
    const addr = String(target.address || '');
    const out = { forward: null, reverse: null, forwardError: null, reverseError: null };
    let ip = IPV4.test(addr) ? addr : null;
    if (!ip) {
      try { out.forward = (await dns.lookup(addr, { all: true })).map((r) => r.address); ip = out.forward[0] || null; }
      catch (e) { out.forwardError = e.code || e.message; }
    }
    if (ip) {
      try { out.reverse = await dns.reverse(ip); } catch (e) { out.reverseError = e.code || e.message; }
    }
    const ok = IPV4.test(addr) ? true : !!(out.forward && out.forward.length);
    const parts = [];
    if (!IPV4.test(addr)) parts.push(out.forward ? `${addr} resolves to ${out.forward.join(', ')}` : `${addr} does not resolve (${out.forwardError})`);
    if (ip) parts.push(out.reverse ? `${ip} reverses to ${out.reverse.join(', ')}` : `${ip} has no reverse record${out.reverseError ? ` (${out.reverseError})` : ''}`);
    return { ok, summary: parts.join('; '), data: { address: addr, ...out } };
  },
};
