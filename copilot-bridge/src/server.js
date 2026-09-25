import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { config, ensureDataDir } from './config.js';
import { ensureApiKey, verifyApiKey } from './apiKey.js';
import { chatCompletion, listModels, resolveDefaultModel } from './copilotClient.js';
import { ensureTls, lanIPv4 } from './tls.js';
import * as memory from './memory.js';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function authError(res) {
  sendJson(res, 401, {
    error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' },
  });
}

function readBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthed(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return verifyApiKey(token);
}

async function handleChatCompletions(req, res) {
  let incoming = [];
  try {
    const body = await readBody(req);
    const conversationId = body.conversation_id;
    delete body.conversation_id;

    if (!body.model || body.model === 'auto' || body.model === 'default') {
      body.model = await resolveDefaultModel();
    }

    incoming = Array.isArray(body.messages) ? body.messages : [];

    // If a conversation is referenced, prepend stored history.
    if (conversationId) {
      const history = memory.loadHistory(conversationId);
      body.messages = [...history, ...incoming];
    }

    const upstream = await chatCompletion(body);

    if (!upstream.ok) {
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(text);
      return;
    }

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let assistant = '';
      let buffer = '';
      const decoder = new TextDecoder();

      for await (const chunk of upstream.body) {
        const text = decoder.decode(chunk, { stream: true });
        res.write(text); // forward SSE as-is (already OpenAI-compatible)
        buffer += text;

        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) assistant += delta;
          } catch {
            /* partial JSON spanning chunks – ignore */
          }
        }
      }
      res.end();

      if (conversationId) {
        memory.appendMessages(conversationId, [...incoming, { role: 'assistant', content: assistant }]);
      }
    } else {
      const data = await upstream.json();
      const assistant = data.choices?.[0]?.message?.content || '';
      if (conversationId) {
        memory.appendMessages(conversationId, [...incoming, { role: 'assistant', content: assistant }]);
        data.conversation_id = conversationId;
      }
      sendJson(res, 200, data);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;

  // Health (no auth)
  if (method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', time: new Date().toISOString() });
  }

  // Everything under /v1 requires the bridge API key.
  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    if (!isAuthed(req)) return authError(res);
  } else {
    return sendJson(res, 404, { error: { message: 'Not found' } });
  }

  if (method === 'GET' && pathname === '/v1/models') {
    try {
      return sendJson(res, 200, await listModels());
    } catch (e) {
      return sendJson(res, 502, { error: { message: e.message } });
    }
  }

  if (method === 'POST' && pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res);
  }

  if (pathname === '/v1/conversations') {
    if (method === 'GET') return sendJson(res, 200, { data: memory.listConversations() });
    if (method === 'POST') return sendJson(res, 201, { id: memory.newConversationId() });
  }

  const convMatch = pathname.match(/^\/v1\/conversations\/([^/]+)$/);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]);
    if (method === 'GET') {
      const conv = memory.getConversation(id);
      if (!conv) return sendJson(res, 404, { error: { message: 'Conversation not found' } });
      return sendJson(res, 200, conv);
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { deleted: memory.deleteConversation(id) });
    }
  }

  return sendJson(res, 404, { error: { message: 'Not found' } });
}

export function createServer() {
  return http.createServer(requestHandler);
}

function requestHandler(req, res) {
  route(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  });
}

function banner(label, url) {
  console.log(`  ${label.padEnd(9)}: ${url}`);
}

export function startServer() {
  ensureDataDir();
  const key = ensureApiKey();

  console.log('\n  Copilot Bridge is running');

  // HTTP listener (local only, keeps existing 127.0.0.1 access).
  const httpServer = http.createServer(requestHandler);
  httpServer.on('error', (e) => console.error(`  HTTP error: ${e.message}`));
  httpServer.listen(config.port, config.host, () => {
    banner('HTTP', `http://${config.host}:${config.port}`);
  });

  // HTTPS listener (LAN-accessible on port 443).
  if (config.httpsEnabled) {
    const ips = lanIPv4();
    const host = os.hostname();
    const fqdn = process.env.USERDNSDOMAIN ? `${host}.${process.env.USERDNSDOMAIN}`.toLowerCase() : null;
    const sans = [...new Set([
      'localhost', '127.0.0.1', host, fqdn, ...ips, ...config.tlsExtraSans,
    ].filter(Boolean))];
    try {
      const tlsOptions = ensureTls(sans);
      const httpsServer = https.createServer(tlsOptions, requestHandler);
      httpsServer.on('error', (e) => {
        if (e.code === 'EADDRINUSE') console.error(`  HTTPS error: port ${config.httpsPort} already in use`);
        else if (e.code === 'EACCES') console.error(`  HTTPS error: no permission to bind port ${config.httpsPort}`);
        else console.error(`  HTTPS error: ${e.message}`);
      });
      httpsServer.listen(config.httpsPort, config.httpsHost, () => {
        banner('HTTPS', `https://${config.httpsHost}:${config.httpsPort}`);
        for (const ip of ips) banner('  LAN', `https://${ip}:${config.httpsPort}`);
      });
    } catch (e) {
      console.error(`  HTTPS disabled (TLS setup failed): ${e.message}`);
    }
  }

  console.log(`  API key  : ${key}`);
  console.log(`  Model    : ${config.defaultModel}`);
  console.log('\n  Send requests with header:  Authorization: Bearer <API key>');
  console.log('  Self-signed HTTPS: clients must skip cert verification (curl -k / rejectUnauthorized:false).\n');
}
