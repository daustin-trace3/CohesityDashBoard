import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';

const DIR = 'conversations';

export function newConversationId() {
  return 'conv_' + crypto.randomBytes(8).toString('hex');
}

export function getConversation(id) {
  if (!isValidId(id)) return null;
  return readJson(`${DIR}/${id}.json`, null);
}

export function loadHistory(id) {
  return getConversation(id)?.messages || [];
}

export function appendMessages(id, messages) {
  if (!isValidId(id)) throw new Error('Invalid conversation id');
  const now = new Date().toISOString();
  let conv = getConversation(id) || { id, createdAt: now, messages: [] };
  conv.messages.push(...messages);
  conv.updatedAt = now;

  // Keep the first system message plus the most recent N messages.
  const max = config.maxHistoryMessages;
  if (conv.messages.length > max) {
    const system = conv.messages.filter((m) => m.role === 'system').slice(0, 1);
    const rest = conv.messages.filter((m) => m.role !== 'system');
    conv.messages = [...system, ...rest.slice(-max)];
  }

  writeJson(`${DIR}/${id}.json`, conv);
  return conv;
}

export function listConversations() {
  const dir = path.join(config.dataDir, DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(`${DIR}/${f}`, null))
    .filter(Boolean)
    .map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages?.length || 0,
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function deleteConversation(id) {
  if (!isValidId(id)) return false;
  const full = path.join(config.dataDir, DIR, `${id}.json`);
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
    return true;
  }
  return false;
}

// Guard against path traversal in conversation ids.
function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
