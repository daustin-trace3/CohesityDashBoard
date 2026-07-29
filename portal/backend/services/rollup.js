// Server-side rollup: periodically fetch each enabled tenant's
// /api/ops/summary (authenticated with that instance's DASHBOARD_API_KEY)
// and cache the result on the tenant row. Per-tenant failures only mark
// that tenant unreachable — they never fail the sweep.
const axios = require('axios');
const https = require('https');
const cron = require('node-cron');
const db = require('../db');
const { decrypt } = require('./encryption');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function client(baseUrl, apiKey) {
  return axios.create({
    baseURL: baseUrl.replace(/\/+$/, ''),
    timeout: 20000,
    httpsAgent,
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });
}

async function fetchSummary(baseUrl, apiKey) {
  const { data } = await client(baseUrl, apiKey).get('/api/ops/summary');
  if (!data || !Array.isArray(data.platforms)) {
    throw new Error('Unexpected response shape — is this an ICC instance?');
  }
  return data;
}

async function refreshTenant(tenant) {
  const now = new Date().toISOString();
  try {
    const apiKey = tenant.api_key_encrypted ? decrypt(tenant.api_key_encrypted) : null;
    const summary = await fetchSummary(tenant.url, apiKey);
    db.prepare('UPDATE tenants SET summary_json = ?, last_fetch_at = ?, last_fetch_ok = 1, last_fetch_error = NULL WHERE id = ?')
      .run(JSON.stringify(summary), now, tenant.id);
    return { ok: true };
  } catch (err) {
    const status = err.response?.status;
    const message = status
      ? `Instance responded HTTP ${status}${status === 401 || status === 403 ? ' — check the API key' : ''}`
      : (err.message || 'unreachable');
    db.prepare('UPDATE tenants SET last_fetch_at = ?, last_fetch_ok = 0, last_fetch_error = ? WHERE id = ?')
      .run(now, message, tenant.id);
    return { ok: false, error: message };
  }
}

async function refreshAll() {
  const tenants = db.prepare('SELECT * FROM tenants WHERE enabled = 1').all();
  await Promise.allSettled(tenants.map((t) => refreshTenant(t)));
}

function initRollup() {
  cron.schedule('*/5 * * * *', () => {
    refreshAll().catch((err) => console.error('[rollup] sweep failed:', err.message));
  });
  refreshAll().catch((err) => console.error('[rollup] initial sweep failed:', err.message));
}

module.exports = { initRollup, refreshAll, refreshTenant, fetchSummary };
