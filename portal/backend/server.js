const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

require('./db');
const { authenticate } = require('./middleware/authenticate');
const { initRollup } = require('./services/rollup');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ ok: true, app: 'icc-portal' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', authenticate);
app.use('/api/tenants', require('./routes/tenants'));
app.use('/api/users', require('./routes/users'));

// Static frontend: hashed assets cache forever, index.html never.
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use('/assets', express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(distDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[portal]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ICC Portal listening on port ${PORT}`);
  initRollup();
});
