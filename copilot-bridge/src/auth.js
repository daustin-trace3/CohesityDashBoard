import { config } from './config.js';
import { readJson, writeJson } from './store.js';

const AUTH_FILE = 'auth.json';

// --- GitHub OAuth device flow -------------------------------------------------

export async function startDeviceFlow() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': config.userAgent,
    },
    body: JSON.stringify({ client_id: config.githubClientId, scope: 'read:user' }),
  });
  if (!res.ok) throw new Error(`device/code failed: ${res.status} ${await res.text()}`);
  return res.json(); // { device_code, user_code, verification_uri, expires_in, interval }
}

export async function pollForToken(deviceCode, interval) {
  let delay = (Number(interval) + 1) * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(delay);
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': config.userAgent,
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await res.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      delay += 5000;
      continue;
    }
    throw new Error(`Authorization failed: ${data.error_description || data.error}`);
  }
}

// --- Token persistence --------------------------------------------------------

export function saveGithubToken(token) {
  const data = readJson(AUTH_FILE, {});
  data.githubToken = token;
  data.savedAt = new Date().toISOString();
  writeJson(AUTH_FILE, data);
}

export function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return readJson(AUTH_FILE, {}).githubToken || null;
}

// --- Short-lived Copilot token -----------------------------------------------

let cached = null; // { token, expiresAt }

export async function getCopilotToken(force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cached && cached.expiresAt - 60 > now) return cached.token;

  const gh = getGithubToken();
  if (!gh) throw new Error('Not logged in. Run `npm run login` (or set GITHUB_TOKEN in .env).');

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${gh}`,
      Accept: 'application/json',
      'User-Agent': config.userAgent,
      'Editor-Version': config.editorVersion,
      'Editor-Plugin-Version': config.editorPluginVersion,
    },
  });
  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cached = { token: data.token, expiresAt: data.expires_at };
  return data.token;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
