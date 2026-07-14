// Poller lifecycle and freshness tracker, persisted to SQLite so the API
// process and the poller process (backend/pollerProcess.js) share one view.
// type ∈ 'cohesity' | 'pure' | 'netapp' | 'licensing' | 'views' | plugin ids
// id   = row id for entity-based types; 0 for global types.
const db = require('../db/database');

// Self-creating on require — both processes touch this module before any
// mark/get call, and both branches share this file (no migration needed).
db.exec(`
  CREATE TABLE IF NOT EXISTS poller_status (
    type             TEXT NOT NULL,
    entity_id        INTEGER NOT NULL DEFAULT 0,
    last_poll_start  TEXT,
    last_poll_end    TEXT,
    last_poll_status TEXT,
    is_syncing       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (type, entity_id)
  )
`);

// A poll that "started" this long ago without ending is assumed dead (the
// poller process crashed or was restarted mid-run) — don't report Syncing
// forever.
const STALE_SYNC_MS = 30 * 60 * 1000;

const upsertStart = db.prepare(`
  INSERT INTO poller_status (type, entity_id, last_poll_start, is_syncing)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(type, entity_id) DO UPDATE SET
    last_poll_start = excluded.last_poll_start,
    is_syncing = 1
`);

const upsertEnd = db.prepare(`
  INSERT INTO poller_status (type, entity_id, last_poll_end, last_poll_status, is_syncing)
  VALUES (?, ?, ?, ?, 0)
  ON CONFLICT(type, entity_id) DO UPDATE SET
    last_poll_end = excluded.last_poll_end,
    last_poll_status = excluded.last_poll_status,
    is_syncing = 0
`);

const selectOne = db.prepare(`
  SELECT last_poll_start AS lastPollStart, last_poll_end AS lastPollEnd,
         last_poll_status AS lastPollStatus, is_syncing AS isSyncing
  FROM poller_status WHERE type = ? AND entity_id = ?
`);

const selectAll = db.prepare(`
  SELECT type, entity_id AS entityId,
         last_poll_start AS lastPollStart, last_poll_end AS lastPollEnd,
         last_poll_status AS lastPollStatus, is_syncing AS isSyncing
  FROM poller_status
`);

function shape(row) {
  if (!row) {
    return { lastPollStart: null, lastPollEnd: null, lastPollStatus: null, isSyncing: false };
  }
  let syncing = !!row.isSyncing;
  if (syncing && row.lastPollStart && Date.now() - Date.parse(row.lastPollStart) > STALE_SYNC_MS) {
    syncing = false;
  }
  return {
    lastPollStart: row.lastPollStart,
    lastPollEnd: row.lastPollEnd,
    lastPollStatus: row.lastPollStatus,
    isSyncing: syncing,
  };
}

function markStart(type, id) {
  upsertStart.run(type, id, new Date().toISOString());
}

function markEnd(type, id, status) {
  upsertEnd.run(type, id, new Date().toISOString(), status);
}

function getState(type, id) {
  return shape(selectOne.get(type, id));
}

function getAll() {
  const map = new Map();
  for (const row of selectAll.all()) {
    map.set(`${row.type}:${row.entityId}`, shape(row));
  }
  return map;
}

module.exports = { markStart, markEnd, getState, getAll };
