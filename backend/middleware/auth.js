const crypto = require('crypto');

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  const expected = process.env.DASHBOARD_API_KEY;
  if (!expected) {
    return res.status(500).json({ error: 'Server API key not configured.' });
  }
  const valid =
    key &&
    key.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}
module.exports = requireApiKey;
