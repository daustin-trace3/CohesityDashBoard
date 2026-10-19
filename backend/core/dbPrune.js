'use strict';

// Bounded retention deletes. One autocommit statement per batch so the write lock
// is released between batches and the other process (web / poller) can get in.
// Must be called OUTSIDE an explicit transaction, otherwise batching cannot release the lock.

const TABLE_RE = /^[a-z0-9_]+$/;

function pruneInBatches(db, table, whereSql, params = [], { batch = 5000, maxBatches = 200 } = {}) {
  if (typeof table !== 'string' || !TABLE_RE.test(table)) {
    throw new Error('pruneInBatches: invalid table name ' + String(table));
  }
  const stmt = db.prepare(
    'DELETE FROM ' + table + ' WHERE rowid IN (SELECT rowid FROM ' + table + ' WHERE ' + whereSql + ' LIMIT ?)'
  );
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const changes = stmt.run(...params, batch).changes;
    batches += 1;
    deleted += changes;
    if (changes < batch) break;
  }
  return { deleted, batches };
}

module.exports = { pruneInBatches };
