// Shared LLM provider resolution for all AI features (cluster analysis +
// per-alert reviews), so they stay on the same provider/model and can't drift.
//
// Prefers the OpenAI API (pay-per-use, no GitHub free-tier daily cap) when
// OPENAI_TOKEN is set; otherwise falls back to GitHub Models (free PAT). Both
// expose the same OpenAI-compatible /chat/completions interface.
const OPENAI_TOKEN = (process.env.OPENAI_TOKEN || process.env.OPENAI_API_KEY || '').trim();
const USE_OPENAI = OPENAI_TOKEN.length > 0;

const PROVIDER = USE_OPENAI ? 'openai' : 'github-models';
const ENDPOINT = USE_OPENAI
  ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
  : (process.env.GITHUB_MODELS_ENDPOINT || 'https://models.github.ai/inference');
const API_TOKEN = USE_OPENAI ? OPENAI_TOKEN : (process.env.GITHUB_MODELS_TOKEN || '');
// OpenAI (pay-per-use) → gpt-5.4. GitHub Models free tier → gpt-4o-mini, since
// the GPT-5 tier there has a strict daily cap.
const MODEL = USE_OPENAI
  ? (process.env.OPENAI_MODEL || 'gpt-5.4')
  : (process.env.GITHUB_MODELS_MODEL || process.env.AI_MODEL || 'openai/gpt-4o-mini');

function isConfigured() {
  return Boolean(API_TOKEN);
}

const axios = require('axios');

/**
 * Shared OpenAI-compatible chat call. Returns the assistant message content.
 * Throws typed errors: LLM_NOT_CONFIGURED, LLM_RATE_LIMITED (with retryAfter),
 * LLM_REQUEST_FAILED. No temperature/max_tokens are sent (GPT-5 family rejects
 * a custom temperature and uses max_completion_tokens).
 */
async function chatCompletion(messages, { responseFormat, timeout = 90000 } = {}) {
  if (!API_TOKEN) {
    const err = new Error('LLM is not configured.');
    err.code = 'LLM_NOT_CONFIGURED';
    throw err;
  }
  const body = { model: MODEL, messages };
  if (responseFormat) body.response_format = responseFormat;
  try {
    const resp = await axios.post(`${ENDPOINT}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      timeout,
    });
    return resp.data?.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      const h = e.response?.headers || {};
      const retryAfter = Number(h['retry-after'] ?? h['x-ratelimit-timeremaining']) || null;
      const err = new Error(
        `Rate limited by ${PROVIDER} for "${MODEL}".` +
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

module.exports = { PROVIDER, ENDPOINT, API_TOKEN, MODEL, USE_OPENAI, isConfigured, chatCompletion };
