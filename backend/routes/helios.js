const express = require('express');
const { heliosAllClusters } = require('../services/helios');

const router = express.Router();

/**
 * GET /api/helios/clusters
 * Returns all clusters connected to Helios (uses HELIOS_API_KEY from .env).
 * Used by the frontend to discover available cluster IDs when adding a Helios cluster.
 */
router.get('/clusters', async (req, res, next) => {
  try {
    const apiKey = process.env.HELIOS_API_KEY;
    if (!apiKey || apiKey === 'your_helios_api_key_here' || apiKey.length < 20) {
      return res.status(400).json({ error: 'HELIOS_API_KEY is not configured in .env' });
    }
    const clusters = await heliosAllClusters(apiKey);
    // Return only safe fields — no credentials
    const safe = clusters.map(c => ({
      clusterId: c.clusterId,
      name: c.name,
      softwareVersion: c.softwareVersion,
      connectedToCluster: c.connectedToCluster
    }));
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
