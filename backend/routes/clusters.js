const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const { invalidateSession } = require('../services/cohesityApi');
const { scheduleCluster, cancelCluster } = require('../services/poller');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

function isBlockedVip(vip) {
  const blocked = [
    /^127\./,
    /^0\.0\.0\.0/,
    /^169\.254\./,
    /^::1$/,
    /^localhost$/i,
    /^metadata\.google\.internal$/i,
    /^169\.254\.169\.254$/
  ];
  return blocked.some((pattern) => pattern.test(vip));
}

/**
 * GET /api/clusters
 * List all clusters, omitting encrypted credentials.
 */
router.get('/', (req, res, next) => {
  try {
    const clusters = db.prepare(`
      SELECT id, name, connection_type, vip, auth_type,
             polling_interval_minutes, ssl_verify, tags, created_at, updated_at
      FROM clusters
      ORDER BY name ASC
    `).all();
    res.json(clusters);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/clusters
 * Add a new cluster.
 */
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 253 }),
    body('connection_type')
      .isIn(['helios', 'direct'])
      .withMessage('connection_type must be helios or direct'),
    body('auth_type')
      .isIn(['userpass', 'apikey'])
      .withMessage('auth_type must be userpass or apikey'),
    body('credentials').isObject().withMessage('credentials must be an object'),
    body('credentials').custom((creds, { req }) => {
      const authType = req.body.auth_type;
      const connType = req.body.connection_type;
      if (connType === 'helios') {
        // apiKey is optional for Helios — falls back to HELIOS_API_KEY env var when blank/absent
        if (creds.apiKey !== undefined && creds.apiKey !== '' &&
            (typeof creds.apiKey !== 'string' || creds.apiKey.length > 512)) {
          throw new Error('credentials.apiKey must be a string (max 512 chars)');
        }
      } else if (authType === 'apikey') {
        if (!creds.apiKey || typeof creds.apiKey !== 'string' || creds.apiKey.length > 512) {
          throw new Error('credentials.apiKey is required (max 512 chars)');
        }
      } else if (authType === 'userpass') {
        if (!creds.username || typeof creds.username !== 'string' || creds.username.length > 256) {
          throw new Error('credentials.username must be a string (max 256 chars)');
        }
        if (!creds.password || typeof creds.password !== 'string' || creds.password.length > 1024) {
          throw new Error('credentials.password must be a string (max 1024 chars)');
        }
        const allowedKeys = new Set(['username', 'password', 'domain']);
        for (const key of Object.keys(creds)) {
          if (!allowedKeys.has(key)) throw new Error(`credentials: unexpected key '${key}'`);
        }
      }
      return true;
    }),
    body('vip')
      .if(body('connection_type').equals('direct'))
      .trim()
      .notEmpty().withMessage('VIP/hostname is required for direct connections')
      .matches(/^[a-zA-Z0-9._-]+$/).withMessage('VIP contains invalid characters')
      .isLength({ max: 253 }).withMessage('VIP too long')
      .custom(val => {
        if (isBlockedVip(val)) throw new Error('VIP address not allowed');
        return true;
      }),
    body('vip')
      .if(body('connection_type').equals('helios'))
      .trim()
      .notEmpty().withMessage('Helios cluster ID is required')
      .matches(/^\d+$/).withMessage('Helios cluster ID must be numeric')
      .isLength({ max: 20 }).withMessage('Helios cluster ID too long'),
    body('polling_interval_minutes')
      .optional()
      .isInt({ min: 5 })
      .withMessage('polling_interval_minutes must be >= 5'),
    body('ssl_verify').optional().isBoolean(),
    body('tags')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('tags too long')
      .custom(val => {
        const tags = val.split(',').map(t => t.trim()).filter(Boolean);
        for (const tag of tags) {
          if (!/^[a-zA-Z0-9 _-]{1,50}$/.test(tag)) {
            throw new Error(`Invalid tag: "${tag}". Tags may contain letters, numbers, spaces, hyphens, underscores (max 50 chars each).`);
          }
        }
        return true;
      })
  ],
  validate,
  (req, res, next) => {
    try {
      const {
        name,
        connection_type,
        vip,
        auth_type,
        credentials,
        polling_interval_minutes = 15,
        ssl_verify = false,
        tags = ''
      } = req.body;

      if (connection_type === 'direct' && !vip) {
        return res.status(400).json({ error: 'vip is required for direct connections' });
      }

      if (connection_type === 'direct' && vip && isBlockedVip(vip)) {
        return res.status(400).json({ error: 'Invalid VIP address.' });
      }

      const encryptedCreds = encrypt(JSON.stringify(credentials));

      const stmt = db.prepare(`
        INSERT INTO clusters
          (name, connection_type, vip, auth_type, encrypted_credentials,
           polling_interval_minutes, ssl_verify, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        name.trim(),
        connection_type,
        vip || null,
        auth_type,
        encryptedCreds,
        Number(polling_interval_minutes),
        ssl_verify ? 1 : 0,
        tags || ''
      );

      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(result.lastInsertRowid);
      scheduleCluster(cluster);

      // Return without sensitive data
      const { encrypted_credentials: _, ...safeCluster } = cluster;
      res.status(201).json(safeCluster);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'A cluster with that name already exists' });
      }
      next(err);
    }
  }
);

/**
 * PUT /api/clusters/:id
 * Update a cluster configuration.
 */
router.put(
  '/:id',
  [
    param('id').isInt({ min: 1 }),
    body('name').optional().trim().notEmpty().isLength({ max: 253 }),
    body('connection_type').optional().isIn(['helios', 'direct']),
    body('auth_type').optional().isIn(['userpass', 'apikey']),
    body('credentials').optional().isObject(),
    body('credentials').optional().custom((creds, { req }) => {
      const authType = req.body.auth_type;
      const connType = req.body.connection_type;
      if (connType === 'helios') {
        // apiKey is optional for Helios — falls back to HELIOS_API_KEY env var when blank/absent
        if (creds.apiKey !== undefined && creds.apiKey !== '' &&
            (typeof creds.apiKey !== 'string' || creds.apiKey.length > 512)) {
          throw new Error('credentials.apiKey must be a string (max 512 chars)');
        }
      } else if (authType === 'apikey') {
        if (!creds.apiKey || typeof creds.apiKey !== 'string' || creds.apiKey.length > 512) {
          throw new Error('credentials.apiKey is required (max 512 chars)');
        }
      } else if (authType === 'userpass') {
        if (!creds.username || typeof creds.username !== 'string' || creds.username.length > 256) {
          throw new Error('credentials.username must be a string (max 256 chars)');
        }
        if (!creds.password || typeof creds.password !== 'string' || creds.password.length > 1024) {
          throw new Error('credentials.password must be a string (max 1024 chars)');
        }
        const allowedKeys = new Set(['username', 'password', 'domain']);
        for (const key of Object.keys(creds)) {
          if (!allowedKeys.has(key)) throw new Error(`credentials: unexpected key '${key}'`);
        }
      }
      return true;
    }),
    body('vip')
      .if(body('connection_type').equals('direct'))
      .trim()
      .notEmpty().withMessage('VIP/hostname is required for direct connections')
      .matches(/^[a-zA-Z0-9._-]+$/).withMessage('VIP contains invalid characters')
      .isLength({ max: 253 }).withMessage('VIP too long')
      .custom(val => {
        if (isBlockedVip(val)) throw new Error('VIP address not allowed');
        return true;
      }),
    body('vip')
      .if(body('connection_type').equals('helios'))
      .trim()
      .notEmpty().withMessage('Helios cluster ID is required')
      .matches(/^\d+$/).withMessage('Helios cluster ID must be numeric')
      .isLength({ max: 20 }).withMessage('Helios cluster ID too long'),
    body('polling_interval_minutes').optional().isInt({ min: 5 }),
    body('ssl_verify').optional().isBoolean(),
    body('tags')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('tags too long')
      .custom(val => {
        const tags = val.split(',').map(t => t.trim()).filter(Boolean);
        for (const tag of tags) {
          if (!/^[a-zA-Z0-9 _-]{1,50}$/.test(tag)) {
            throw new Error(`Invalid tag: "${tag}". Tags may contain letters, numbers, spaces, hyphens, underscores (max 50 chars each).`);
          }
        }
        return true;
      })
  ],
  validate,
  (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Cluster not found' });

      const {
        name,
        connection_type,
        vip,
        auth_type,
        credentials,
        polling_interval_minutes,
        ssl_verify,
        tags
      } = req.body;

      const updatedType = connection_type !== undefined ? connection_type : existing.connection_type;
      const updatedVip = vip !== undefined ? vip : existing.vip;

      if (updatedType === 'direct' && updatedVip && isBlockedVip(updatedVip)) {
        return res.status(400).json({ error: 'Invalid VIP address.' });
      }

      const updatedName = name !== undefined ? name.trim() : existing.name;
      const updatedAuthType = auth_type !== undefined ? auth_type : existing.auth_type;
      const updatedInterval =
        polling_interval_minutes !== undefined ? Number(polling_interval_minutes) : existing.polling_interval_minutes;
      const updatedSslVerify =
        ssl_verify !== undefined ? (ssl_verify ? 1 : 0) : existing.ssl_verify;
      const updatedCreds =
        credentials !== undefined ? encrypt(JSON.stringify(credentials)) : existing.encrypted_credentials;
      const updatedTags = tags !== undefined ? tags : existing.tags;

      db.prepare(`
        UPDATE clusters SET
          name = ?, connection_type = ?, vip = ?, auth_type = ?,
          encrypted_credentials = ?, polling_interval_minutes = ?,
          ssl_verify = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(updatedName, updatedType, updatedVip, updatedAuthType, updatedCreds, updatedInterval, updatedSslVerify, updatedTags, id);

      if (credentials !== undefined) {
        invalidateSession(Number(id));
      }

      const updated = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
      scheduleCluster(updated);

      const { encrypted_credentials: _, ...safeCluster } = updated;
      res.json(safeCluster);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'A cluster with that name already exists' });
      }
      next(err);
    }
  }
);

/**
 * DELETE /api/clusters/:id
 */
router.delete(
  '/:id',
  [param('id').isInt({ min: 1 })],
  validate,
  (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = db.prepare('SELECT id FROM clusters WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Cluster not found' });

      db.prepare('DELETE FROM clusters WHERE id = ?').run(id);
      cancelCluster(Number(id));
      invalidateSession(Number(id));

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/clusters/:id/status
 * Live cluster status from Cohesity API.
 */
router.get(
  '/:id/status',
  [param('id').isInt({ min: 1 })],
  validate,
  async (req, res, next) => {
    try {
      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(req.params.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const { fetchClusterStatus } = require('../services/cohesityApi');
      const data = await fetchClusterStatus(cluster);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/clusters/:id/hardware
 * Node and hardware info.
 */
router.get(
  '/:id/hardware',
  [param('id').isInt({ min: 1 })],
  validate,
  async (req, res, next) => {
    try {
      const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(req.params.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const { fetchNodes } = require('../services/cohesityApi');
      const data = await fetchNodes(cluster);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
