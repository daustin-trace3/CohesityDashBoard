// In-memory poller lifecycle and freshness tracker.
// type ∈ 'cohesity' | 'pure' | 'netapp' | 'licensing'
// id   = row id for entity-based types; 0 for licensing.

const states = new Map(); // `${type}:${id}` -> state object

function key(type, id) {
  return `${type}:${id}`;
}

function markStart(type, id) {
  const k = key(type, id);
  const prev = states.get(k) || {};
  states.set(k, {
    lastPollStart: new Date().toISOString(),
    lastPollEnd: prev.lastPollEnd || null,
    lastPollStatus: prev.lastPollStatus || null,
    isSyncing: true,
  });
}

function markEnd(type, id, status) {
  const k = key(type, id);
  const prev = states.get(k) || {};
  states.set(k, {
    lastPollStart: prev.lastPollStart || null,
    lastPollEnd: new Date().toISOString(),
    lastPollStatus: status,
    isSyncing: false,
  });
}

function getState(type, id) {
  return states.get(key(type, id)) || {
    lastPollStart: null,
    lastPollEnd: null,
    lastPollStatus: null,
    isSyncing: false,
  };
}

function getAll() {
  return states;
}

module.exports = { markStart, markEnd, getState, getAll };
