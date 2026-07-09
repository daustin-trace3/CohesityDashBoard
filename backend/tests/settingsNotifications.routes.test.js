/**
 * WP14 (C10.2): /api/settings/notifications GET/PUT + the write-only-secret
 * convention smtpPassword must follow (same pattern as /credentials).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;

beforeAll(() => {
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('GET/PUT /api/settings/notifications', () => {
  const get = () => request(app).get('/api/settings/notifications').set('x-api-key', API_KEY);
  const put = (body) => request(app).put('/api/settings/notifications').set('x-api-key', API_KEY).send(body);

  it('GET returns the default shape', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpEncryption: 'starttls',
      smtpAuthMethod: 'login',
      smtpUsername: '',
      smtpPasswordSet: false,
      smtpFrom: '',
      smtpRecipients: '',
      alertMinSeverity: 'warning',
      alertPlatforms: { cohesity: true, pure: true, netapp: true },
      reminderHours: 24,
    });
  });

  it('PUT roundtrips non-secret fields', async () => {
    const res = await put({
      smtpEnabled: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpEncryption: 'tls',
      smtpAuthMethod: 'login',
      smtpUsername: 'alerts@example.com',
      smtpFrom: 'alerts@example.com',
      smtpRecipients: 'ops@example.com,oncall@example.com',
      alertMinSeverity: 'critical',
      alertPlatforms: { cohesity: true, pure: false, netapp: true },
      reminderHours: 12,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      smtpEnabled: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpEncryption: 'tls',
      smtpUsername: 'alerts@example.com',
      smtpFrom: 'alerts@example.com',
      smtpRecipients: 'ops@example.com,oncall@example.com',
      alertMinSeverity: 'critical',
      alertPlatforms: { cohesity: true, pure: false, netapp: true },
      reminderHours: 12,
    });

    const after = await get();
    expect(after.body.smtpHost).toBe('smtp.example.com');
  });

  it('smtpPassword is write-only: never in GET, saving sets smtpPasswordSet, empty string clears it, omitted leaves it untouched', async () => {
    const setRes = await put({ smtpPassword: 'super-secret' });
    expect(setRes.status).toBe(200);
    expect(setRes.body.smtpPasswordSet).toBe(true);
    expect(setRes.body.smtpPassword).toBeUndefined();

    const afterSet = await get();
    expect(afterSet.body.smtpPasswordSet).toBe(true);
    expect(afterSet.body.smtpPassword).toBeUndefined();

    const untouched = await put({ smtpHost: 'still.example.com' });
    expect(untouched.body.smtpPasswordSet).toBe(true);

    const cleared = await put({ smtpPassword: '' });
    expect(cleared.body.smtpPasswordSet).toBe(false);
  });

  it('rejects an invalid port with 400', async () => {
    const res = await put({ smtpPort: 70000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();

    const res2 = await put({ smtpPort: 0 });
    expect(res2.status).toBe(400);
  });

  it('rejects invalid enum fields with 400', async () => {
    const encRes = await put({ smtpEncryption: 'bogus' });
    expect(encRes.status).toBe(400);

    const authRes = await put({ smtpAuthMethod: 'bogus' });
    expect(authRes.status).toBe(400);

    const sevRes = await put({ alertMinSeverity: 'bogus' });
    expect(sevRes.status).toBe(400);
  });

  it('rejects an out-of-range reminderHours with 400', async () => {
    const res = await put({ reminderHours: 500 });
    expect(res.status).toBe(400);

    const res2 = await put({ reminderHours: -1 });
    expect(res2.status).toBe(400);
  });
});

describe('POST /api/settings/notifications/test', () => {
  const post = () => request(app).post('/api/settings/notifications/test').set('x-api-key', API_KEY).send({});

  it('400s when SMTP is not configured', async () => {
    // Fresh app instance's settings are shared with prior describe block via
    // the same test DB; explicitly clear the required fields first.
    await request(app).put('/api/settings/notifications').set('x-api-key', API_KEY).send({
      smtpHost: '', smtpFrom: '', smtpRecipients: '',
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('502s when the transport throws', async () => {
    const alertNotifier = require('../services/alertNotifier');
    await request(app).put('/api/settings/notifications').set('x-api-key', API_KEY).send({
      smtpHost: 'smtp.example.com', smtpFrom: 'a@example.com', smtpRecipients: 'b@example.com',
    });
    alertNotifier._setTransportFactory(() => ({
      sendMail: async () => { throw new Error('connection refused'); },
    }));
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('connection refused');
    alertNotifier._reset();
  });

  it('200s when the transport succeeds', async () => {
    const alertNotifier = require('../services/alertNotifier');
    const sent = [];
    alertNotifier._setTransportFactory(() => ({
      sendMail: async (msg) => { sent.push(msg); },
    }));
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('INFO | ICC | SMTP configuration test');
    alertNotifier._reset();
  });
});
