// Hand-rolled request validation helpers (dell/unifi/nutanix router.js
// pattern) — a bundled plugin cannot require the host's express-validator,
// so createRouter must return a BARE (req, res, next) function and
// validation is re-implemented here, preserving the same 400 status code +
// `{ error, details }` shape.
function badRequest(res, details) {
  res.status(400).json({ error: 'Invalid parameters', details });
}

function fail(path, msg = 'Invalid value') {
  return { msg, path };
}

const INT_RE = /^-?\d+$/;

function parseIntStrict(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string' || !INT_RE.test(v.trim())) return NaN;
  return parseInt(v, 10);
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && (maxLen == null || v.length <= maxLen);
}

function isBooleanish(v) {
  return typeof v === 'boolean' || v === 'true' || v === 'false' || v === 0 || v === 1 || v === '0' || v === '1';
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function requireIdParam(req, res, name = 'id') {
  const id = parseIntStrict(req.params[name]);
  if (!Number.isInteger(id)) {
    badRequest(res, [fail(name)]);
    return null;
  }
  return id;
}

function parseQueryInt(v, min, max) {
  if (v === undefined) return { ok: true, value: undefined };
  const n = parseIntStrict(v);
  if (!Number.isInteger(n) || (min != null && n < min) || (max != null && n > max)) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

module.exports = {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
};
