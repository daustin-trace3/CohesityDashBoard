// Change-aware memo for per-request evaluators. A cached value is returned only
// while the database has not changed: data_version moves when ANOTHER connection
// commits, total_changes() moves when THIS connection writes, so together they
// detect every change and a hit is never stale. A 30 s wall-clock expiry is a
// belt. Cache is per db instance and per db file (the tenant db proxy is one
// object for every tenant, so the file name is part of the cache identity).
const MAX_ENTRIES = 64;
const TTL_MS = 30000;
const caches = new WeakMap();

function stateToken(db) {
  let dv;
  if (typeof db.pragma === 'function') dv = db.pragma('data_version', { simple: true });
  else {
    const row = db.prepare('PRAGMA data_version').get();
    dv = row ? Object.values(row)[0] : '';
  }
  const tc = db.prepare('SELECT total_changes() AS n').get().n;
  // The admin file (db/adminSplit.js) is attached as "admin": settings and
  // other admin rows change through another connection, which moves only the
  // attached file's data_version.
  let av = '';
  if (typeof db.pragma === 'function') {
    try { av = db.pragma('admin.data_version', { simple: true }); } catch { /* no admin file attached */ }
  }
  return `${dv}|${tc}|${av}`;
}

function memoByDbState(db, key, fn) {
  let token;
  let bucket;
  try {
    token = stateToken(db);
    let perFile = caches.get(db);
    if (!perFile) { perFile = new Map(); caches.set(db, perFile); }
    const fileId = typeof db.name === 'string' ? db.name : '';
    bucket = perFile.get(fileId);
    if (!bucket) { bucket = new Map(); perFile.set(fileId, bucket); }
  } catch {
    return fn(); // handle cannot report its state: never cache
  }
  const hit = bucket.get(key);
  if (hit && hit.token === token && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = fn();
  // Re-read the token: fn() may itself write (it should not), so store the state it ended in.
  let endToken = token;
  try { endToken = stateToken(db); } catch { /* keep start token */ }
  bucket.delete(key);
  bucket.set(key, { token: endToken, at: Date.now(), value });
  while (bucket.size > MAX_ENTRIES) bucket.delete(bucket.keys().next().value);
  return value;
}


// Time-based memo for read models whose source tables change on a poll cadence
// (minutes) while the database as a whole changes every few seconds (poller
// heartbeat, other platforms): a data_version memo would miss almost every time.
// A hit may be up to ttlMs stale, which the caller accepts (overview pages
// refresh every 60 s). Same cache identity rules as memoByDbState.
const ttlCaches = new WeakMap();
// tokenFn (optional) returns a cheap change token for the source tables (row
// count, max rowid); a hit also needs the same token, so an insert or delete
// invalidates at once and only in-place refreshes ride out the TTL.
function memoByTtl(db, key, ttlMs, fn, tokenFn) {
  let bucket;
  try {
    let perFile = ttlCaches.get(db);
    if (!perFile) { perFile = new Map(); ttlCaches.set(db, perFile); }
    const fileId = typeof db.name === 'string' ? db.name : '';
    bucket = perFile.get(fileId);
    if (!bucket) { bucket = new Map(); perFile.set(fileId, bucket); }
  } catch { return fn(); }
  let token = '';
  if (typeof tokenFn === 'function') { try { token = String(tokenFn()); } catch { token = String(Date.now()); } }
  const hit = bucket.get(key);
  if (hit && hit.token === token && Date.now() - hit.at < ttlMs) return hit.value;
  const value = fn();
  bucket.set(key, { at: Date.now(), value, token });
  if (bucket.size > MAX_ENTRIES) bucket.delete(bucket.keys().next().value);
  return value;
}

module.exports = { memoByDbState, memoByTtl };
