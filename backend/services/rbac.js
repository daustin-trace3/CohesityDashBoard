// RBAC permission matcher (contract C8.2).
//
// Permission strings have the form `<namespace>:<section>:<level>`.
// Each segment may be the wildcard `*`. Levels form a small hierarchy:
// `manage` satisfies a `view` requirement, and `*` satisfies both `view`
// and `manage`. Malformed strings (not exactly 3 colon-separated segments)
// never match — deny by default. Matching is case-sensitive (exact
// lowercase match is the expected convention; callers should lowercase
// permission strings before storing/comparing them).

const LEVEL_RANK = { view: 1, manage: 2 };

function splitPermission(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  return parts;
}

function segmentMatches(grantSeg, reqSeg) {
  return grantSeg === '*' || grantSeg === reqSeg;
}

function levelMatches(grantLevel, reqLevel) {
  if (grantLevel === '*') return true;
  if (grantLevel === reqLevel) return true;
  const grantRank = LEVEL_RANK[grantLevel];
  const reqRank = LEVEL_RANK[reqLevel];
  if (grantRank == null || reqRank == null) return false;
  return grantRank >= reqRank;
}

/**
 * Pure function: does `grant` satisfy `required`?
 * @param {string} grant
 * @param {string} required
 * @returns {boolean}
 */
function matches(grant, required) {
  const g = splitPermission(grant);
  const r = splitPermission(required);
  if (!g || !r) return false;

  const [gNs, gSection, gLevel] = g;
  const [rNs, rSection, rLevel] = r;

  if (!segmentMatches(gNs, rNs)) return false;
  if (!segmentMatches(gSection, rSection)) return false;
  return levelMatches(gLevel, rLevel);
}

/**
 * @param {string[]} grantList
 * @param {string} required
 * @returns {boolean}
 */
function hasPermission(grantList, required) {
  if (!Array.isArray(grantList) || grantList.length === 0) return false;
  return grantList.some((grant) => matches(grant, required));
}

/**
 * Union of a user's direct grants and every group grant for the groups the
 * user belongs to. Not cached across requests — callers should call this
 * once per request and reuse the result.
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {string[]}
 */
function resolveGrants(db, userId) {
  const userGrants = db
    .prepare("SELECT permission FROM role_grants WHERE subject_type = 'user' AND subject_id = ?")
    .all(userId)
    .map((r) => r.permission);

  const groupGrants = db
    .prepare(
      `SELECT DISTINCT rg.permission
         FROM role_grants rg
         JOIN user_groups ug ON ug.group_id = rg.subject_id
        WHERE rg.subject_type = 'group' AND ug.user_id = ?`
    )
    .all(userId)
    .map((r) => r.permission);

  return Array.from(new Set([...userGrants, ...groupGrants]));
}

module.exports = { matches, hasPermission, resolveGrants };
