const logger = require('../utils/logger');

module.exports = function errorHandler(err, req, res, next) {
  // Log server-side through the logger, which strips request errors down to
  // message, code, method, URL and status. Printing the raw object put
  // Authorization headers, API keys and login bodies into the log.
  logger.error('[Error]', `${req.method} ${req.originalUrl ? req.originalUrl.split('?')[0] : ''}`, err);

  // Known safe error types
  if (err.name === 'ValidationError' || err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  // An upstream platform call that failed is a gateway problem, never the
  // caller's own status: axios copies the upstream HTTP status onto err.status,
  // so an upstream 401 used to reach the browser as a 401 and look like an
  // expired ICC session.
  if (err.isAxiosError || (err.config && err.request)) {
    return res.status(502).json({ error: 'The platform did not answer as expected.' });
  }

  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Bad request.' });
  }

  // All other errors: never leak internals
  res.status(500).json({ error: 'Internal server error.' });
};
