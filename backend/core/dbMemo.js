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
  return `${dv}|${tc}`;
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

module.exports = { memoByDbState };
