// Transaction shim installed on the database handle (db/database.js).
//
// better-sqlite3's db.transaction(fn)() is DEFERRED: it takes the write lock at
// the first write, and if the other process committed since its first read it
// fails at once with SQLITE_BUSY_SNAPSHOT, which busy_timeout never retries
// (skill icc-sqlite-write-transactions). Here the default mode becomes
// IMMEDIATE, so the lock is taken up front and busy_timeout applies.
//
// Also: one warn line for a transaction that ran longer than slowMs, and in the
// poller process a bounded retry of a run that still hit SQLITE_BUSY.
const path = require('path');

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT']);
const RETRY_SLEEPS_MS = [250, 500];
const MODES = ['default', 'deferred', 'immediate', 'exclusive'];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// file:line of the db.transaction(...) call site, once per definition.
function captureOrigin() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  const skip = [`core${path.sep}dbTransactions.js`, 'core/dbTransactions.js', `db${path.sep}database.js`, 'db/database.js'];
  for (const line of lines) {
    if (skip.some((s) => line.includes(s))) continue;
    const m = line.match(/\(?([^()\s]+:\d+):\d+\)?\s*$/);
    if (m) return m[1];
  }
  return 'unknown';
}

function installTransactionShim(db, { logger, role = 'web', slowMs = 2000, busyRetries = 2 } = {}) {
  if (db.__iccTxnShim) return db;
  const original = db.transaction.bind(db);
  const retries = role === 'poller' ? Math.max(0, busyRetries) : 0;

  db.transaction = function transaction(fn) {
    const origin = captureOrigin();
    const txn = original(fn);

    const timed = (mode) => (...args) => {
      // Only the outermost run may retry; a nested run is a savepoint inside
      // someone else's transaction and must fail up to them.
      const outermost = !db.inTransaction;
      let attempt = 0;
      for (;;) {
        const start = Date.now();
        try {
          return txn[mode](...args);
        } catch (err) {
          if (outermost && attempt < retries && err && BUSY_CODES.has(err.code)) {
            attempt += 1;
            logger.warn(`[db] busy, retry ${attempt} of ${retries}: ${origin}`);
            sleepSync(RETRY_SLEEPS_MS[Math.min(attempt - 1, RETRY_SLEEPS_MS.length - 1)]);
            continue;
          }
          throw err;
        } finally {
          const took = Date.now() - start;
          if (took > slowMs) logger.warn(`[db] slow transaction ${took} ms: ${origin}`);
        }
      }
    };

    const run = timed('immediate');
    for (const mode of MODES) run[mode] = mode === 'default' ? timed('default') : timed(mode);
    return run;
  };
  db.__iccTxnShim = true;
  return db;
}

module.exports = { installTransactionShim };
