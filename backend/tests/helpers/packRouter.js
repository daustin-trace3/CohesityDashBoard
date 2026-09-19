// Test helper: load a plugin pack's backend straight from plugin-sdk/<id>/
// source and call its bare router the way core/registry.js does, without
// building or installing the pack. Used by the credential-forwarding tests so
// every pack twin is held to the same contract as its host router.
const path = require('path');

/**
 * @param {string} id pack id (folder under plugin-sdk/)
 * @param {{ grants?: string[] }} [opts]
 * @returns {{ manifest, coreApi, call: (method, path, body?, query?) => Promise<{status:number, body:any}> }}
 */
function loadPack(id) {
  process.env.DASHBOARD_DEMO = '';
  const db = require('../../db/database');
  const { runMigrations } = require('../../core/migrations');
  const { buildCoreApi } = require('../../core/coreApi');
  const manifest = require(path.join('..', '..', '..', 'plugin-sdk', id, 'backend', 'src', 'index.js'));
  runMigrations(db, manifest.id || id, manifest.migrations || []);
  const coreApi = buildCoreApi({ db });
  const router = manifest.createRouter(coreApi);

  function call(method, reqPath, body, query) {
    return new Promise((resolve) => {
      const [p, qs] = String(reqPath).split('?');
      const req = {
        method: method.toUpperCase(),
        path: p,
        url: reqPath,
        originalUrl: reqPath,
        query: Object.assign(Object.fromEntries(new URLSearchParams(qs || '')), query || {}),
        body: body || {},
        params: {},
        headers: {},
        auth: { kind: 'service', name: 'test', grants: ['*:*:*'], user: { username: 'tester' } },
        get() { return undefined; },
      };
      const res = {
        statusCode: 200,
        headers: {},
        status(c) { this.statusCode = c; return this; },
        set() { return this; },
        setHeader() { return this; },
        type() { return this; },
        json(j) { resolve({ status: this.statusCode, body: j }); return this; },
        send(j) { resolve({ status: this.statusCode, body: j }); return this; },
        end() { resolve({ status: this.statusCode, body: null }); return this; },
      };
      Promise.resolve(router(req, res, (err) => resolve({ status: err ? (err.status || 500) : 404, body: err ? { error: String(err.message || err) } : { error: 'no route' } })))
        .catch((err) => resolve({ status: err.status || 500, body: { error: String(err.message || err) } }));
    });
  }

  return { manifest, coreApi, db, call };
}

module.exports = { loadPack };
