// Shared LLM provider resolution for all AI features (cluster analysis +
// per-alert reviews), so they stay on the same provider/model and can't drift.
//
// Prefers the OpenAI API (pay-per-use, no GitHub free-tier daily cap) when an
// OpenAI token is configured; otherwise falls back to GitHub Models (free
// PAT). Both expose the same OpenAI-compatible /chat/completions interface.
//
// Tokens are resolved lazily on every call — encrypted app_settings values
// (saved from the Settings → Credentials UI) take priority over .env, and a
// token saved in the UI takes effect immediately without a restart.
const axios = require('axios');
const { getSetting, getSecretSetting } = require('./settings');

function resolveProvider() {
  const openaiToken = (
    getSecretSetting('openai_token', 'OPENAI_TOKEN') || process.env.OPENAI_API_KEY || ''
  ).trim();
  const useOpenAI = openaiToken.length > 0;
  // Provider defaults: OpenAI (pay-per-use) → gpt-5.4. GitHub Models free
  // tier → gpt-4o-mini, since the GPT-5 tier there has a strict daily cap.
  const defaultModel = useOpenAI
    ? (process.env.OPENAI_MODEL || 'gpt-5.4')
    : (process.env.GITHUB_MODELS_MODEL || process.env.AI_MODEL || 'openai/gpt-4o-mini');
  return {
    provider: useOpenAI ? 'openai' : 'github-models',
    endpoint: useOpenAI
      ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      : (process.env.GITHUB_MODELS_ENDPOINT || 'https://models.github.ai/inference'),
    apiToken: useOpenAI ? openaiToken : getSecretSetting('github_models_token', 'GITHUB_MODELS_TOKEN'),
    // The UI-selected model (Global Settings → AI) wins over env/provider defaults.
    model: (getSetting('llm_model') || '').trim() || defaultModel,
    defaultModel,
  };
}

// Model ids that can't do chat completions — filtered out of the picker.
const NON_CHAT_RE = /(embed|whisper|tts|audio|realtime|transcribe|image|dall-e|moderation|search|similarity|edit-|instruct|davinci|babbage|curie|ada)/i;

/**
 * List chat-capable models from the active provider so the UI can offer a
 * picker. OpenAI-compatible endpoints expose GET /models; GitHub Models
 * publishes its catalog separately.
 */
async function listModels() {
  const { provider, endpoint, apiToken, model, defaultModel } = resolveProvider();
  if (!apiToken) {
    const err = new Error('LLM is not configured.');
    err.code = 'LLM_NOT_CONFIGURED';
    throw err;
  }
  const url = provider === 'github-models'
    ? 'https://models.github.ai/catalog/models'
    : `${endpoint}/models`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    timeout: 20000,
  });
  const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
  const ids = raw
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .filter((id) => !NON_CHAT_RE.test(id))
    .sort();
  return { provider, models: [...new Set(ids)], current: model, default: defaultModel };
}

function isConfigured() {
  return Boolean(resolveProvider().apiToken);
}

/**
 * Shared OpenAI-compatible chat call. Returns the assistant message content.
 * Throws typed errors: LLM_NOT_CONFIGURED, LLM_RATE_LIMITED (with retryAfter),
 * LLM_REQUEST_FAILED. No temperature/max_tokens are sent (GPT-5 family rejects
 * a custom temperature and uses max_completion_tokens).
 */
async function chatCompletion(messages, { responseFormat, timeout = 90000 } = {}) {
  const { provider, endpoint, apiToken, model } = resolveProvider();
  if (!apiToken) {
    const err = new Error('LLM is not configured.');
    err.code = 'LLM_NOT_CONFIGURED';
    throw err;
  }
  const body = { model, messages };
  if (responseFormat) body.response_format = responseFormat;
  try {
    const resp = await axios.post(`${endpoint}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      timeout,
    });
    return resp.data?.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      const h = e.response?.headers || {};
      const retryAfter = Number(h['retry-after'] ?? h['x-ratelimit-timeremaining']) || null;
      const err = new Error(
        `Rate limited by ${provider} for "${model}".` +
        (retryAfter ? ` Try again in ~${Math.ceil(retryAfter / 60)} min.` : ' Try again later.')
      );
      err.code = 'LLM_RATE_LIMITED';
      err.retryAfter = retryAfter;
      throw err;
    }
    const detail = e.response?.data?.error?.message || e.message;
    const err = new Error(`LLM request failed${status ? ` (HTTP ${status})` : ''}.`);
    err.code = 'LLM_REQUEST_FAILED';
    err.detail = detail;
    throw err;
  }
}

module.exports = { resolveProvider, isConfigured, chatCompletion, listModels };
