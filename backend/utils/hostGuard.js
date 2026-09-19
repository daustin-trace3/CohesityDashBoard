// Outbound request guard. ICC monitors internal infrastructure, so RFC1918
// targets are allowed on purpose. What is never a legitimate target: this
// host itself (loopback), link-local space (which holds the cloud metadata
// services), the unspecified address, and multicast. Checks run against the
// RESOLVED addresses, not the typed name, so a DNS name that points at
// 127.0.0.1 or an IPv4-mapped IPv6 literal does not slip through.
const dns = require('dns');
const net = require('net');

const BLOCKED_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) >>> 0) + Number(part), 0) >>> 0;
}

function inV4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

function isBlockedV4(ip) {
  return inV4Range(ip, '127.0.0.0', 8) // loopback
    || inV4Range(ip, '0.0.0.0', 8) // "this network", 0.0.0.0 reaches localhost on Linux
    || inV4Range(ip, '169.254.0.0', 16) // link-local incl. 169.254.169.254 metadata
    || inV4Range(ip, '224.0.0.0', 4) // multicast
    || ip === '255.255.255.255'
    || ip === '100.100.100.200'; // Alibaba Cloud metadata
}

/** True when `address` (an IP literal) must never be dialled. */
function isBlockedAddress(address) {
  const raw = String(address || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(raw);
  if (family === 4) return isBlockedV4(raw);
  if (family !== 6) return true; // not an IP literal at all
  const ip = raw.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) and NAT64 well-known prefix.
  const mapped = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (/^ff/.test(ip)) return true; // multicast
  if (ip === 'fd00:ec2::254') return true; // AWS IMDS over IPv6
  return false;
}

/** Bare host out of "host", "host:port", "[v6]:port" or a full URL. */
function hostOf(value) {
  let h = String(value || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) {
    try { return new URL(h).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
  }
  h = h.replace(/\/.*$/, '');
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
  if (net.isIP(h)) return h;
  return h.split(':')[0];
}

/** Synchronous check on the typed value only (names and IP literals). Use in
 *  express-validator chains; pair with assertSafeHost before dialling. */
function isBlockedHost(value) {
  // Userinfo ("name@127.0.0.1" dials 127.0.0.1), whitespace, backslashes and
  // URL punctuation have no place in a host field; "x@loopback" used to pass
  // because the text before the @ made it look like a DNS name.
  const rawValue = String(value || '').trim();
  const bare = rawValue.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  if (/[@\s\\]/.test(bare)) return true;
  const h = hostOf(value).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_NAMES.has(h) || h.endsWith('.localhost')) return true;
  if (net.isIP(h)) return isBlockedAddress(h);
  // Decimal / hex / octal IPv4 shorthand ("2130706433", "0x7f.0.0.1", "127.1")
  // is parsed by the OS resolver as an address. Canonical dotted quads were
  // handled above, so any other all-numeric host is refused.
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(h)) return true;
  return false;
}

/** Resolves `value` and rejects when ANY resolved address is blocked.
 *  Throws an Error with .status = 400 and a message safe to show a caller. */
async function assertSafeHost(value) {
  const h = hostOf(value);
  const fail = (msg) => Object.assign(new Error(msg), { status: 400, code: 'HOST_NOT_ALLOWED' });
  if (isBlockedHost(h)) throw fail('host is not allowed');
  if (net.isIP(h)) return [h];
  let addrs;
  try {
    addrs = await dns.promises.lookup(h, { all: true, verbatim: true });
  } catch {
    return []; // unresolvable: let the real request fail with its own error
  }
  if (addrs.some((a) => isBlockedAddress(a.address))) throw fail('host is not allowed');
  return addrs.map((a) => a.address);
}

module.exports = { isBlockedAddress, isBlockedHost, assertSafeHost, hostOf };
