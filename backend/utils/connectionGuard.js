// Rules that stop a saved platform credential from being sent anywhere except
// the address it was saved for. Two request shapes used to allow that:
//
//   1. "Test connection" with the id of a saved source, no password in the
//      body, and a DIFFERENT host in the body. The handler decrypted the saved
//      password and logged in to the caller's host with it.
//   2. PUT that changes only the host and leaves the password blank ("keep
//      existing"). The next poll delivered the saved password to the new host.
//
// Anyone holding <platform>:<section>:manage could do either, which made every
// platform's manage grant equal to "read that platform's service account
// password". The rule now: a saved secret only ever travels to the saved
// target. Changing the target means typing the secret again.
const { isBlockedHost } = require('./hostGuard');

const norm = (v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/\/+$/, '');

/**
 * Which of `fields` differ between the stored row and the incoming body.
 * A field that is absent (undefined) in `incoming` is "not being changed".
 * `fields` maps incoming key -> stored key, or is an array when they match.
 */
function changedTargetFields(stored, incoming, fields) {
  const pairs = Array.isArray(fields) ? fields.map((f) => [f, f]) : Object.entries(fields);
  const out = [];
  for (const [inKey, storedKey] of pairs) {
    if (!incoming || incoming[inKey] === undefined) continue;
    if (norm(incoming[inKey]) !== norm(stored ? stored[storedKey] : '')) out.push(inKey);
  }
  return out;
}

const TARGET_CHANGE_MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';

/**
 * PUT guard. Throws { status: 400 } when a connection target changes and no
 * new secret came with the request.
 */
function assertSecretOnTargetChange({ stored, incoming, fields, secretSupplied }) {
  const changed = changedTargetFields(stored, incoming, fields);
  if (changed.length && !secretSupplied) {
    throw Object.assign(new Error(TARGET_CHANGE_MESSAGE), { status: 400, code: 'SECRET_REQUIRED', fields: changed });
  }
  return changed;
}

/**
 * Test-route helper. Given the stored row (or null for a brand new source),
 * the request body and the target fields, returns the target values the test
 * must dial: the STORED ones when the saved secret is going to be used, the
 * body's when the caller typed a secret for this test.
 */
function testTarget({ stored, incoming, fields, secretSupplied }) {
  const pairs = Array.isArray(fields) ? fields.map((f) => [f, f]) : Object.entries(fields);
  const out = {};
  for (const [inKey, storedKey] of pairs) {
    const typed = incoming ? incoming[inKey] : undefined;
    out[inKey] = (stored && !secretSupplied) ? stored[storedKey] : (typed !== undefined ? typed : (stored ? stored[storedKey] : undefined));
  }
  return out;
}

/** express-validator custom(): refuses loopback, link-local and metadata targets. */
function notBlockedHost(value) {
  if (value === undefined || value === null || value === '') return true;
  if (isBlockedHost(value)) throw new Error('that address is not allowed');
  return true;
}

module.exports = { changedTargetFields, assertSecretOnTargetChange, testTarget, notBlockedHost, TARGET_CHANGE_MESSAGE };
