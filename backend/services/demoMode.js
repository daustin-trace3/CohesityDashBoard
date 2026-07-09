// Contract C11.1 — single source of truth for whether the process is
// running as the seeded ICC demo instance (pm2 `dashboard-demo`, DASHBOARD_DEMO=1).
module.exports = { isDemo: () => process.env.DASHBOARD_DEMO === '1' };
