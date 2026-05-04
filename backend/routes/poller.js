const express = require('express');
const db = require('../db/database');
const { pollCluster } = require('../services/poller');
const router = express.Router();

router.post('/trigger/:clusterId', (req, res, next) => {
  try {
    const { clusterId } = req.params;
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(Number(clusterId));
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
    pollCluster(cluster).catch(() => {}); // fire and forget
    res.json({ message: 'Poll triggered.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
