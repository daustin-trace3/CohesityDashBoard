import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger');
const errorHandler = require('../middleware/errorHandler');

function fakeAxiosError() {
  const err = new Error('Request failed with status code 401');
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.code = 'ERR_BAD_REQUEST';
  err.status = 401;
  err.config = {
    method: 'post',
    baseURL: 'https://cohesity01.corp.example',
    url: '/irisservices/api/v1/public/accessTokens?access_token=QUERYSECRET',
    headers: { Authorization: 'Bearer HEADERSECRET', apiKey: 'APIKEYSECRET', 'X-API-KEY': 'XAPISECRET' },
    auth: { username: 'svc-icc', password: 'BASICSECRET' },
    data: JSON.stringify({ username: 'svc-icc', password: 'BODYSECRET' }),
  };
  err.request = {};
  err.response = { status: 401, data: { message: 'UPSTREAMBODY' } };
  return err;
}

const SECRETS = ['QUERYSECRET', 'HEADERSECRET', 'APIKEYSECRET', 'XAPISECRET', 'BASICSECRET', 'BODYSECRET', 'UPSTREAMBODY'];

afterEach(() => vi.restoreAllMocks());

function captured(spy) {
  const util = require('util');
  return spy.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' ')).join('\n');
}

describe('logger', () => {
  it('never prints credentials carried by a request error, however it is passed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = fakeAxiosError();
    logger.error('login failed:', err);
    logger.error('wrapped', { clusterId: 4, err });
    logger.error('caused', new Error('poll failed', { cause: err }));
    const out = captured(spy);
    for (const s of SECRETS) expect(out, s).not.toContain(s);
    expect(out).toContain('POST https://cohesity01.corp.example/irisservices/api/v1/public/accessTokens');
    expect(out).toContain('HTTP 401');
  });

  it('leaves ordinary errors and values alone', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plain = new Error('boom');
    logger.error('x', plain, { a: 1 }, 'text');
    expect(spy.mock.calls[0][2]).toBe(plain);
    expect(spy.mock.calls[0][3]).toEqual({ a: 1 });
  });
});

describe('errorHandler', () => {
  it('turns an upstream failure into a 502 and logs nothing secret', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/boom', (req, res, next) => next(fakeAxiosError()));
    app.use(errorHandler);
    const res = await request(app).get('/boom?token=URLSECRET');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('401');
    const out = captured(spy);
    for (const s of [...SECRETS, 'URLSECRET']) expect(out, s).not.toContain(s);
  });

  it('keeps caller errors and hides internals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/bad', (req, res, next) => next(Object.assign(new Error('nope'), { status: 409 })));
    app.get('/crash', (req, res, next) => next(new Error('SELECT secret FROM t')));
    app.use(errorHandler);
    expect((await request(app).get('/bad')).body).toEqual({ error: 'nope' });
    const crash = await request(app).get('/crash');
    expect(crash.status).toBe(500);
    expect(crash.body).toEqual({ error: 'Internal server error.' });
  });
});
