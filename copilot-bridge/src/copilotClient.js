import { config } from './config.js';
import { getCopilotToken } from './auth.js';

function copilotHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': config.editorVersion,
    'Editor-Plugin-Version': config.editorPluginVersion,
    'User-Agent': config.userAgent,
    'Openai-Intent': 'conversation-panel',
  };
}

export async function listModels() {
  const token = await getCopilotToken();
  const res = await fetch(`${config.copilotApiBase}/models`, { headers: copilotHeaders(token) });
  if (!res.ok) throw new Error(`models failed: ${res.status} ${await res.text()}`);
  return res.json();
}

let resolvedDefault = null;

// Resolve DEFAULT_MODEL. 'auto' picks the newest Claude Sonnet the account can access.
export async function resolveDefaultModel() {
  if (config.defaultModel && config.defaultModel !== 'auto') return config.defaultModel;
  if (resolvedDefault) return resolvedDefault;
  try {
    const models = await listModels();
    const ids = (models.data || models.models || [])
      .map((m) => m.id || m.model)
      .filter(Boolean);
    const sonnets = ids.filter((id) => /claude.*sonnet/i.test(id));
    sonnets.sort((a, b) => versionScore(b) - versionScore(a));
    resolvedDefault = sonnets[0] || 'claude-3.5-sonnet';
  } catch {
    resolvedDefault = 'claude-3.5-sonnet';
  }
  return resolvedDefault;
}

function versionScore(id) {
  const m = String(id).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Returns the raw fetch Response so the caller can stream or buffer as needed.
export async function chatCompletion(body) {
  const token = await getCopilotToken();
  return fetch(`${config.copilotApiBase}/chat/completions`, {
    method: 'POST',
    headers: copilotHeaders(token),
    body: JSON.stringify(body),
  });
}
