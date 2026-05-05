require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const clustersRouter = require('./routes/clusters');
const metricsRouter = require('./routes/metrics');
const alertsRouter = require('./routes/alerts');
const hardwareRouter = require('./routes/hardware');
const pollerRouter = require('./routes/poller');
const heliosRouter = require('./routes/helios');
const importRouter = require('./routes/import');
const analyticsRouter = require('./routes/analytics');
const replicationRouter = require('./routes/replication');
const requireApiKey = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const { initPoller } = require('./services/poller');

const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());

// CORS — restrict to localhost origins only
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

// Rate limiting: 500 requests per minute per IP (dashboard loads many per-cluster requests)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

app.use(express.json({ limit: '1mb' }));

// API key authentication for all /api/ routes
app.use('/api', requireApiKey);

// Routes
app.use('/api/clusters', clustersRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/hardware', hardwareRouter);
app.use('/api/poller', pollerRouter);
app.use('/api/helios', heliosRouter);
app.use('/api/import', importRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/replication', replicationRouter);

// Health check — verifies DB connectivity
app.get('/health', (req, res) => {
  try {
    const db = require('./db/database');
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', detail: 'database unavailable' });
  }
});

// Serve frontend static build in production
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Error handler must be last
app.use(errorHandler);

// Fail fast on missing/invalid required env vars
try {
  const { getKey } = require('./services/encryption');
  getKey();
} catch (e) {
  logger.error('[Fatal] ENCRYPTION_KEY validation failed:', e.message);
}
if (!process.env.DASHBOARD_API_KEY) {
  logger.error('[Fatal] DASHBOARD_API_KEY is not set — all API requests will fail.');
}
if (!process.env.HELIOS_API_KEY) {
  logger.warn('HELIOS_API_KEY is not set — Helios discovery will be unavailable.');
}

app.listen(PORT, () => {
  logger.info(`Backend running on http://localhost:${PORT}`);
  initPoller();
});

module.exports = app;
