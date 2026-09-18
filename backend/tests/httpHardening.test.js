import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

afterEach(() => { delete process.env.DASHBOARD_DEMO; });

describe('response headers', () => {
  it('sends a tight CSP, Permissions-Policy and no server banner', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    // No blanket scheme sources.
    expect(csp).not.toMatch(/(style|font|script|connect)-src[^;]* https:(;| |$)/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeTruthy();
  });

  it('only answers CORS preflights for configured origins', async () => {
    const lan = await request(app).options('/api/ops/summary').set('Origin', 'http://172.17.16.113:5173').set('Access-Control-Request-Method', 'GET');
    expect(lan.headers['access-control-allow-origin']).toBeUndefined();
    const evil = await request(app).options('/api/ops/summary').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const dev = await request(app).options('/api/ops/summary').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('a fresh install is open only to a caller on the box itself', async () => {
    const db = require('../db/database');
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get().c).toBe(0);
    // supertest connects over loopback: the local administrator can still get in.
    const local = await request(app).get('/api/ops/summary');
    expect(local.status).toBe(200);
    // Anyone arriving through a proxy or tunnel is remote, whatever the socket says.
    for (const header of ['X-Forwarded-For', 'CF-Connecting-IP', 'X-Real-IP']) {
      const remote = await request(app).get('/api/ops/summary').set(header, '203.0.113.9');
      expect(remote.status, header).toBe(401);
      expect(JSON.stringify(remote.body)).not.toMatch(/at .*\.js:\d+/);
    }
    const status = await request(app).get('/api/auth/setup-status').set('X-Forwarded-For', '203.0.113.9');
    expect(status.body).toMatchObject({ needsSetup: true, authEnabled: true });
    const session = await request(app).get('/api/auth/session').set('X-Forwarded-For', '203.0.113.9');
    expect(session.status).toBe(401);
    // Creating the first admin remotely needs the claim token, not just a POST.
    const enable = await request(app).post('/api/auth/enable').set('X-Forwarded-For', '203.0.113.9').send({ username: 'intruder', password: 'long-enough-pw' });
    expect(enable.status).toBe(403);
    const setup = await request(app).post('/api/auth/setup').set('X-Forwarded-For', '203.0.113.9').send({ token: 'wrong', username: 'intruder', password: 'long-enough-pw' });
    expect(setup.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get().c).toBe(0);
  });
});
