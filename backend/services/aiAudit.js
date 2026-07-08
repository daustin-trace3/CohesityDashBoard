// In-memory audit trail of recent AI exchanges, so the UI can prove exactly
// what left the box (the anonymized payload) versus what stayed local (the
// token → real-name mapping). Holds the last 20 exchanges; cleared on restart.

const MAX_ENTRIES = 20;
const entries = [];
let nextId = 1;

/**
 * Record an outbound AI request at the moment it is sent.
 * `messages` must be the exact (already anonymized) chat messages;
 * `mappings` is the local token → real-name table (never sent).
 */
function recordExchange({ feature, label, model, messages, mappings }) {
  const entry = {
    id: nextId++,
    feature,
    label,
    model,
    sentAt: new Date().toISOString(),
    messages,
    mappings: mappings || [],
    response: null,
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.pop();
  return entry.id;
}

/** Attach the raw (still-tokenized) model response, as received. */
function attachResponse(id, response) {
  const entry = entries.find((e) => e.id === id);
  if (entry) entry.response = response || null;
}

function listExchanges() {
  return entries.map(({ id, feature, label, model, sentAt, mappings, response }) => ({
    id, feature, label, model, sentAt,
    mappedCount: mappings.length,
    hasResponse: response != null,
  }));
}

function getExchange(id) {
  return entries.find((e) => e.id === Number(id)) || null;
}

module.exports = { recordExchange, attachResponse, listExchanges, getExchange };
