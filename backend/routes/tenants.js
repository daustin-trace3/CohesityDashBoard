// Tenant list for the switcher. Phase 1: every authenticated caller sees every
// tenant. Phase 2 filters this by membership and adds global admin management.
const express = require('express');
const registry = require('../core/tenantRegistry');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    current: req.tenantId || null,
    tenants: registry.listTenants().map((t) => ({ id: t.id, name: t.name, status: t.status })),
  });
});

module.exports = router;
