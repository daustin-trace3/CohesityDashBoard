// Transaction shim installed on every database handle (db/adminSplit.js).
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

// Counters for the System Health page (since this process started).
const counters = { slowTransactions: 0, busyRetries: 0, slowMs: 2000 };
function stats() { return { ...counters }; }

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// file:line of the db.transaction(...) call site, once per definition.
function captureOrigin() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  const skip = [`core${path.sep}dbTransactions.js`, 'core/dbTransactions.js', `db${path.sep}database.js`, 'db/database.js', `db${path.sep}adminDb.js`, 'db/adminDb.js', `db${path.sep}adminSplit.js`, 'db/adminSplit.js'];
  for (const line of lines) {
    if (skip.some((s) => line.includes(s))) continue;
    const m = line.match(/\(?([^()\s]+:\d+):\d+\)?\s*$/);
    if (m) return m[1];
  }
  return 'unknown';
}

function installTransactionShim(db, { logger, role = 'web', slowMs = 2000, busyRetries = 2, anchor = false } = {}) {
  if (db.__iccTxnShim) return db;
  counters.slowMs = slowMs;
  const original = db.transaction.bind(db);
  const retries = role === 'poller' ? Math.max(0, busyRetries) : 0;

  // Anchor mode (a data connection with the admin file attached, db/adminSplit.js).
  // BEGIN IMMEDIATE on a connection with an attached database takes the write
  // lock on EVERY attached file, so a poller transaction would block admin
  // writes. In anchor mode the default and immediate modes run as a DEFERRED
  // transaction whose body first writes one row of main.icc_txn_anchor. That
  // takes the write lock on main up front (busy_timeout applies, no
  // SQLITE_BUSY_SNAPSHOT) and leaves the attached file unlocked unless the body
  // itself writes it.
  let anchorStmt = null;
  let anchorDue = false;
  const bumpAnchor = () => {
    if (!anchorDue) return;
    anchorDue = false;
    if (!anchorStmt) anchorStmt = db.prepare('UPDATE main.icc_txn_anchor SET n = n + 1');
    anchorStmt.run();
  };

  db.transaction = function transaction(fn) {
    const origin = captureOrigin();
    const anchored = anchor ? original((...args) => { bumpAnchor(); return fn(...args); }) : null;
    let plain = anchored ? null : original(fn);
    const plainTxn = () => (plain || (plain = original(fn)));

    // The function that runs a mode. In anchor mode only the outermost run
    // anchors; a nested run is a savepoint inside someone else's transaction.
    const call = (mode, args) => {
      if (anchored && (mode === 'default' || mode === 'immediate')) {
        anchorDue = !db.inTransaction;
        try { return anchored.deferred(...args); } finally { anchorDue = false; }
      }
      return plainTxn()[mode](...args);
    };

    const timed = (mode) => (...args) => {
      // Only the outermost run may retry; a nested run is a savepoint inside
      // someone else's transaction and must fail up to them.
      const outermost = !db.inTransaction;
      let attempt = 0;
      for (;;) {
        const start = Date.now();
        try {
          return call(mode, args);
        } catch (err) {
          if (outermost && attempt < retries && err && BUSY_CODES.has(err.code)) {
            attempt += 1;
            counters.busyRetries += 1;
            logger.warn(`[db] busy, retry ${attempt} of ${retries}: ${origin}`);
            sleepSync(RETRY_SLEEPS_MS[Math.min(attempt - 1, RETRY_SLEEPS_MS.length - 1)]);
            continue;
          }
          throw err;
        } finally {
          const took = Date.now() - start;
          if (took > slowMs) counters.slowTransactions += 1;
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

module.exports = { installTransactionShim, stats };
