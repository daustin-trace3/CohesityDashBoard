/**
 * Renders an IP with its reverse-resolved hostname beneath it.
 * - resolved to a name  -> shows the hostname
 * - resolved but no PTR -> shows a subtle "no DNS record" note (not an error)
 * - not yet resolved    -> shows nothing extra (still looking up)
 *
 * @param {string} ip   the IP address
 * @param {object} dns  map from useDnsResolve ({ ip: hostname|null })
 */
export default function IpWithHost({ ip, dns, muted = false }) {
  if (!ip) return <span className="text-ink-faint">—</span>;
  const resolved = dns && Object.prototype.hasOwnProperty.call(dns, ip);
  const name = resolved ? dns[ip] : undefined;
  return (
    <span className="tnum">
      <span className={muted ? 'text-ink-faint' : 'text-ink'}>{ip}</span>
      {name
        ? <span className="text-ink-faint text-[11px] block">{name}</span>
        : resolved
          ? <span className="text-ink-faint/70 text-[10px] italic block">no DNS record</span>
          : null}
    </span>
  );
}
