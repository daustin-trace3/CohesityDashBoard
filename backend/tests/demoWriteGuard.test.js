import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const demoWriteGuard = require('../middleware/demoWriteGuard');

function run(method, path, demo = true) {
  if (demo) process.env.DASHBOARD_DEMO = '1';
  else delete process.env.DASHBOARD_DEMO;
  const req = { method, path };
  let status = null;
  let body = null;
  let nexted = false;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
  demoWriteGuard(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

afterEach(() => { delete process.env.DASHBOARD_DEMO; });

describe('demoWriteGuard', () => {
  it('passes everything through outside demo mode', () => {
    expect(run('PUT', '/settings', false).nexted).toBe(true);
    expect(run('POST', '/tenants', false).nexted).toBe(true);
  });

  it('passes reads through in demo mode', () => {
    expect(run('GET', '/settings').nexted).toBe(true);
    expect(run('GET', '/users').nexted).toBe(true);
  });

  it('blocks settings, users, tenants, plugins and connection writes in demo mode', () => {
    for (const [method, path] of [
      ['PUT', '/settings'],
      ['POST', '/settings/llm-test'],
      ['POST', '/users'],
      ['PUT', '/users/1'],
      ['POST', '/users/grants'],
      ['POST', '/tenants'],
      ['POST', '/tenants/acme/close'],
      ['POST', '/plugins/install'],
      ['DELETE', '/plugins/zerto'],
      ['POST', '/vcenter/vcenters'],
      ['POST', '/vcenter/vcenters/test'],
      ['POST', '/dell/instances/test'],
      ['PUT', '/zerto/account'],
      ['POST', '/clusters'],
      ['PUT', '/alert-notify/cohesity'],
      ['DELETE', '/clusters/1'],
    ]) {
      const r = run(method, path);
      expect(r.nexted, `${method} ${path}`).toBe(false);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.demo).toBe(true);
    }
  });

  it('allows the interactive demo surfaces', () => {
    for (const [method, path] of [
      ['POST', '/auth/login'],
      ['POST', '/auth/logout'],
      ['POST', '/app-services/evaluate'],
      ['POST', '/app-services/watch'],
      ['DELETE', '/app-services/watch/aa00001722'],
      ['POST', '/ops-agent/incidents/3/retriage'],
      ['POST', '/service-status/events/9/analyze'],
      ['POST', '/alerts/5/resolve'],
      ['POST', '/dell/export'],
    ]) {
      expect(run(method, path).nexted, `${method} ${path}`).toBe(true);
    }
  });

  it('does not let auth paths other than login/logout through', () => {
    expect(run('POST', '/auth/claim').status).toBe(403);
    expect(run('POST', '/auth/change-password').status).toBe(403);
  });
});
