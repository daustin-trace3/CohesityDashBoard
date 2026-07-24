// Frontend port of backend/services/rbac.js matcher (contract C8.2). Keep
// semantics identical: 3 colon-delimited segments <namespace>:<section>:<level>,
// '*' wildcards per segment, level hierarchy manage ⊃ view, deny by default,
// malformed strings → false.

const LEVELS = { view: 1, manage: 2 };

function parse(permission) {
  if (typeof permission !== 'string') return null;
  const parts = permission.split(':');
  if (parts.length !== 3) return null;
  const [namespace, section, level] = parts;
  if (!namespace || !section || !level) return null;
  return { namespace, section, level };
}

function segmentMatches(grantSeg, reqSeg) {
  return grantSeg === '*' || grantSeg === reqSeg;
}

function levelMatches(grantLevel, reqLevel) {
  if (grantLevel === '*') return true;
  if (grantLevel === reqLevel) return true;
  const grantRank = LEVELS[grantLevel];
  const reqRank = LEVELS[reqLevel];
  if (grantRank == null || reqRank == null) return false;
  return grantRank >= reqRank;
}

export function matches(grant, required) {
  const g = parse(grant);
  const r = parse(required);
  if (!g || !r) return false;
  return (
    segmentMatches(g.namespace, r.namespace) &&
    segmentMatches(g.section, r.section) &&
    levelMatches(g.level, r.level)
  );
}

export function hasPermission(grantList, required) {
  if (!Array.isArray(grantList) || grantList.length === 0) return false;
  if (!parse(required)) return false;
  return grantList.some(grant => matches(grant, required));
}
