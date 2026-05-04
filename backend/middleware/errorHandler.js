module.exports = function errorHandler(err, req, res, next) {
  // Always log the full error server-side
  console.error('[Error]', err);

  // Known safe error types
  if (err.name === 'ValidationError' || err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Bad request.' });
  }

  // All other errors: never leak internals
  res.status(500).json({ error: 'Internal server error.' });
};
