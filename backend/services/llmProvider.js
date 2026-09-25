// Shared LLM provider resolution for all AI features (cluster analysis,
// per-alert reviews, platform advisors, Service Status), so they stay on the
// same provider/model and can't drift.
//
// Providers (Global Settings > AI, setting llm_provider):
//   auto           OpenAI when an OpenAI token is present, else GitHub Models
//   openai         api.openai.com (pay-per-use)
//   github-models  models.github.ai (free PAT, daily caps)
//   custom         any OpenAI-compatible endpoint the operator points ICC at
//                  (a Copilot bridge, a local model server); the API key is
//                  optional because some bridges take none.
// All of them speak the same /chat/completions and /models interface.
//
// Tokens are resolved lazily on every call — encrypted app_settings values
// (saved from the Settings UI) take priority over .env, and a value saved in
// the UI takes effect immediately without a restart.
const axios = require('axios');
const { getSetting, getSecretSetting } = require('./settings');

const PROVIDERS = ['auto', 'openai', 'github-models', 'custom'];

/** Accepts the full URL an operator is likely to paste
 *  (http://host:8787/v1/chat/completions) and keeps the API base. */
function normalizeEndpoint(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  return s.replace(/\/+$/, '');
}

function authHeaders(apiToken, extra = {}) {
  const h = { ...extra };
  if (apiToken) h.Authorization = `Bearer ${apiToken}`;
  return h;
}

function resolveProvider() {
  const choiceRaw = (getSetting('llm_provider') || process.env.LLM_PROVIDER || 'auto').trim();
  const choice = PROVIDERS.includes(choiceRaw) ? choiceRaw : 'auto';
  const pickedModel = (getSetting('llm_model') || '').trim();

  if (choice === 'custom') {
    const endpoint = normalizeEndpoint(getSetting('llm_custom_endpoint') || process.env.LLM_CUSTOM_ENDPOINT);
    const apiToken = (getSecretSetting('llm_custom_token', 'LLM_CUSTOM_TOKEN') || '').trim();
    const defaultModel = (process.env.LLM_CUSTOM_MODEL || '').trim();
    return {
      provider: 'custom', choice, endpoint, apiToken,
      configured: endpoint.length > 0,
      model: pickedModel || defaultModel,
      defaultModel: defaultModel || 'first model the endpoint lists',
    };
  }

  const openaiToken = (
    getSecretSetting('openai_token', 'OPENAI_TOKEN') || process.env.OPENAI_API_KEY || ''
  ).trim();
  const useOpenAI = choice === 'openai' || (choice === 'auto' && openaiToken.length > 0);
  // Provider defaults: OpenAI (pay-per-use) → gpt-5.4. GitHub Models free
  // tier → gpt-4o-mini, since the GPT-5 tier there has a strict daily cap.
  const defaultModel = useOpenAI
    ? (process.env.OPENAI_MODEL || 'gpt-5.4')
    : (process.env.GITHUB_MODELS_MODEL || process.env.AI_MODEL || 'openai/gpt-4o-mini');
  const apiToken = useOpenAI ? openaiToken : (getSecretSetting('github_models_token', 'GITHUB_MODELS_TOKEN') || '').trim();
  return {
    provider: useOpenAI ? 'openai' : 'github-models',
    choice,
    endpoint: useOpenAI
      ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      : (process.env.GITHUB_MODELS_ENDPOINT || 'https://models.github.ai/inference'),
    apiToken,
    configured: apiToken.length > 0,
    // The UI-selected model (Global Settings → AI) wins over env/provider defaults.
    model: pickedModel || defaultModel,
    defaultModel,
  };
}

// Model ids that can't do chat completions — filtered out of the picker.
const NON_CHAT_RE = /(embed|whisper|tts|audio|realtime|transcribe|image|dall-e|moderation|search|similarity|edit-|instruct|davinci|babbage|curie|ada)/i;

function notConfigured() {
  const err = new Error('LLM is not configured.');
  err.code = 'LLM_NOT_CONFIGURED';
  return err;
}

/** GET the model catalogue of one endpoint; returns sorted chat-capable ids. */
async function fetchModelIds({ provider, endpoint, apiToken }, timeout = 20000) {
  const url = provider === 'github-models'
    ? 'https://models.github.ai/catalog/models'
    : `${endpoint}/models`;
  const resp = await axios.get(url, { headers: authHeaders(apiToken, { Accept: 'application/json' }), timeout });
  const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.data || resp.data?.models || []);
  const ids = raw
    .map((m) => (typeof m === 'string' ? m : (m.id || m.name)))
    .filter(Boolean)
    .filter((id) => !NON_CHAT_RE.test(id))
    .sort();
  return [...new Set(ids)];
}

/**
 * List chat-capable models from the active provider so the UI can offer a
 * picker. OpenAI-compatible endpoints expose GET /models; GitHub Models
 * publishes its catalog separately.
 */
async function listModels() {
  const p = resolveProvider();
  if (!p.configured) throw notConfigured();
  const models = await fetchModelIds(p);
  return { provider: p.provider, endpoint: p.provider === 'custom' ? p.endpoint : undefined, models, current: p.model, default: p.defaultModel };
}

// A custom endpoint with no model picked uses the first model it lists;
// cached briefly so every analysis does not start with a /models call.
let firstModelCache = { endpoint: null, model: null, at: 0 };
async function firstListedModel(p) {
  if (firstModelCache.endpoint === p.endpoint && Date.now() - firstModelCache.at < 10 * 60 * 1000) return firstModelCache.model;
  const models = await fetchModelIds(p);
  firstModelCache = { endpoint: p.endpoint, model: models[0] || null, at: Date.now() };
  return firstModelCache.model;
}

function isConfigured() {
  return resolveProvider().configured;
}

function failedError(e, provider, model) {
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
    return err;
  }
  const detail = e.response?.data?.error?.message || e.response?.data?.error || e.message;
  const err = new Error(`LLM request failed${status ? ` (HTTP ${status})` : ''}.`);
  err.code = 'LLM_REQUEST_FAILED';
  err.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return err;
}

/**
 * Shared OpenAI-compatible chat call. Returns the assistant message content.
 * Throws typed errors: LLM_NOT_CONFIGURED, LLM_RATE_LIMITED (with retryAfter),
 * LLM_REQUEST_FAILED. No temperature/max_tokens are sent (GPT-5 family rejects
 * a custom temperature and uses max_completion_tokens).
 */
async function chatCompletion(messages, { responseFormat, timeout = 90000 } = {}) {
  const p = resolveProvider();
  if (!p.configured) throw notConfigured();
  let model = p.model;
  if (!model && p.provider === 'custom') {
    try { model = await firstListedModel(p); } catch (e) { throw failedError(e, p.provider, '(model list)'); }
  }
  const body = { messages };
  if (model) body.model = model;
  if (responseFormat) body.response_format = responseFormat;
  try {
    const resp = await axios.post(`${p.endpoint}/chat/completions`, body, {
      headers: authHeaders(p.apiToken, { 'Content-Type': 'application/json' }),
      timeout,
    });
    return resp.data?.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    throw failedError(e, p.provider, model);
  }
}

/**
 * Probe an OpenAI-compatible endpoint the operator typed in (not necessarily
 * the saved one): is it alive, what does it list, does a chat round trip
 * work. Never throws; every leg reports its own outcome.
 */
async function testEndpoint({ endpoint, apiToken, model }) {
  const base = normalizeEndpoint(endpoint);
  const out = { endpoint: base, models: [], chat: null, error: null, latencyMs: null };
  if (!/^https?:\/\//i.test(base)) { out.error = 'Endpoint must start with http:// or https://.'; return out; }
  const p = { provider: 'custom', endpoint: base, apiToken: (apiToken || '').trim() };
  const t0 = Date.now();
  try {
    out.models = await fetchModelIds(p, 15000);
  } catch (e) {
    const status = e.response?.status;
    out.modelsError = `${status ? `HTTP ${status}` : e.code || 'request failed'}: ${e.response?.data?.error?.message || e.message}`;
  }
  out.latencyMs = Date.now() - t0;
  const pick = (model || '').trim() || out.models[0];
  const body = { messages: [{ role: 'user', content: 'Reply with the single word OK.' }] };
  if (pick) body.model = pick;
  try {
    const t1 = Date.now();
    const resp = await axios.post(`${base}/chat/completions`, body, {
      headers: authHeaders(p.apiToken, { 'Content-Type': 'application/json' }), timeout: 30000,
    });
    const content = resp.data?.choices?.[0]?.message?.content;
    out.chat = { ok: typeof content === 'string', model: resp.data?.model || pick || null, reply: String(content || '').slice(0, 80), latencyMs: Date.now() - t1 };
  } catch (e) {
    const status = e.response?.status;
    out.chat = { ok: false, model: pick || null, error: `${status ? `HTTP ${status}` : e.code || 'request failed'}: ${e.response?.data?.error?.message || e.message}` };
  }
  if (out.modelsError && !out.chat.ok) out.error = 'Endpoint did not answer /models or /chat/completions.';
  return out;
}

module.exports = { PROVIDERS, normalizeEndpoint, authHeaders, resolveProvider, isConfigured, chatCompletion, listModels, testEndpoint };
