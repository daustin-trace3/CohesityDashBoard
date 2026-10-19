// Periodic WAL checkpoint for the poller process. With two processes and a
// reader nearly always holding a snapshot, SQLite's automatic checkpoint can
// never finish and the -wal file grows without bound (631 MB beside a 965 MB
// database on 2026-10-19). A PASSIVE checkpoint every few minutes drains what
// it can; when the log is still large a TRUNCATE resets it.
const fs = require('fs');
const logger = require('../utils/logger');

function fileBytes(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}
const mb = (n) => Math.round(n / (1024 * 1024));

function checkpointOnce(db, dbPath, opts = {}) {
  const truncateAboveBytes = opts.truncateAboveBytes != null ? opts.truncateAboveBytes : 64 * 1024 * 1024;
  const walPath = `${dbPath || db.name}-wal`;
  const walBytesBefore = fileBytes(walPath);
  let r = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
  let mode = 'passive';
  if (fileBytes(walPath) > truncateAboveBytes) {
    r = db.pragma('wal_checkpoint(TRUNCATE)')[0] || {};
    mode = 'truncate';
  }
  return {
    mode, busy: r.busy || 0, log: r.log == null ? 0 : r.log, checkpointed: r.checkpointed == null ? 0 : r.checkpointed,
    walBytesBefore, walBytesAfter: fileBytes(walPath),
  };
}

let timer = null;

function startWalCheckpoint({ everyMs = 5 * 60000, truncateAboveBytes = 64 * 1024 * 1024 } = {}) {
  if (timer) return;
  const tick = () => {
    try {
      const db = require('../db/database');
      const res = checkpointOnce(db, db.name, { truncateAboveBytes });
      const line = `[db] wal checkpoint ${res.mode} database: wal ${mb(res.walBytesBefore)} MB -> ${mb(res.walBytesAfter)} MB, busy ${res.busy}`;
      if (res.mode === 'truncate' || res.busy) logger.info(line); else logger.debug(line);
    } catch (err) {
      logger.warn(`[db] wal checkpoint failed: ${err.message}`);
    }
  };
  tick();
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
}

function stopWalCheckpoint() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { startWalCheckpoint, stopWalCheckpoint, checkpointOnce };
