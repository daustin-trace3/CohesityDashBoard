import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { normalizeEndpoint, authHeaders, testEndpoint } from '../services/llmProvider.js';

let server; let base;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.headers.authorization || '') !== 'Bearer k1') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'bridge-gpt' }, { id: 'text-embedding-3' }, { id: 'bridge-claude' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const j = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: 'OK' } }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('custom OpenAI-compatible endpoint', () => {
  it('normalizes a pasted chat completions URL down to the API base', () => {
    expect(normalizeEndpoint('http://127.0.0.1:8787/v1/chat/completions')).toBe('http://127.0.0.1:8787/v1');
    expect(normalizeEndpoint('http://h/v1/models/')).toBe('http://h/v1');
    expect(normalizeEndpoint(' http://h/v1/ ')).toBe('http://h/v1');
    expect(normalizeEndpoint('')).toBe('');
  });

  it('omits the Authorization header when there is no key', () => {
    expect(authHeaders('', { A: 1 })).toEqual({ A: 1 });
    expect(authHeaders('k', {})).toEqual({ Authorization: 'Bearer k' });
  });

  it('reports models (chat-capable only) and a chat round trip', async () => {
    const r = await testEndpoint({ endpoint: `${base}/chat/completions`, apiToken: 'k1' });
    expect(r.error).toBeNull();
    expect(r.models).toEqual(['bridge-claude', 'bridge-gpt']);
    expect(r.chat.ok).toBe(true);
    expect(r.chat.model).toBe('bridge-claude');
    expect(r.chat.reply).toBe('OK');
  });

  it('uses the model the operator picked for the chat leg', async () => {
    const r = await testEndpoint({ endpoint: base, apiToken: 'k1', model: 'bridge-gpt' });
    expect(r.chat.model).toBe('bridge-gpt');
  });

  it('names the failure when the key is wrong', async () => {
    const r = await testEndpoint({ endpoint: base, apiToken: 'nope' });
    expect(r.modelsError).toMatch(/HTTP 401/);
    expect(r.chat.ok).toBe(false);
    expect(r.error).toMatch(/did not answer/);
  });

  it('rejects a non-http endpoint', async () => {
    const r = await testEndpoint({ endpoint: 'ftp://x', apiToken: '' });
    expect(r.error).toMatch(/http/);
  });
});
