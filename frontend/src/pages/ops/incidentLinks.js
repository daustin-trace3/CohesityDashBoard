// Router paths (no tenant prefix; the router basename adds it) for the things an
// incident names. Returns null when nothing sensible exists, so callers print plain text.
//
// kind: 'server' | 'host' | 'vm' open Server 360 for any platform;
//       'array' | 'cluster' | 'vpg' | 'device' | 'switch' open the platform page that lists them.
const q = (name) => encodeURIComponent(String(name));

export function subjectLink(platform, kind, name) {
  if (!name || name === '-') return null;
  const p = String(platform || '').toLowerCase();
  const k = String(kind || '').toLowerCase();
  if (k === 'server' || k === 'vm') return `/ops/server360?name=${q(name)}`;
  if (k === 'host') return p === 'vcenter' ? `/vcenter/hosts?q=${q(name)}` : `/ops/server360?name=${q(name)}`;
  if (k === 'array') {
    if (p === 'pure') return `/pure/estate?q=${q(name)}`;
    if (p === 'netapp') return `/netapp/capacity?q=${q(name)}`;
    return null;
  }
  if (k === 'cluster') return p === 'cohesity' ? '/cohesity/clusters' : null;
  if (k === 'vpg') return p === 'zerto' ? `/zerto/vpgs?q=${q(name)}` : null;
  if (k === 'device') return p === 'dell' ? `/dell/devices?q=${q(name)}` : null;
  if (k === 'switch') return p === 'brocade' ? `/brocade/switches?q=${q(name)}` : null;
  return null;
}

// The kind a host record of a platform most likely is, for linking its name.
const RECORD_KIND = { vcenter: 'host', pure: 'array', netapp: 'array', cohesity: 'cluster', zerto: 'vpg', dell: 'device', brocade: 'switch' };
export const recordKind = (platform) => RECORD_KIND[String(platform || '').toLowerCase()] || 'server';
