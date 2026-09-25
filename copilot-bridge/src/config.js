import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Minimal .env loader (no external dependency).
function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

export const config = {
  rootDir,
  dataDir: path.join(rootDir, '.bridge'),
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: parseInt(process.env.BRIDGE_PORT || '8787', 10),
  githubClientId: process.env.GITHUB_CLIENT_ID || 'Iv1.b507a08c87ecfe98',
  defaultModel: process.env.DEFAULT_MODEL || 'auto',
  editorVersion: process.env.EDITOR_VERSION || 'vscode/1.95.0',
  editorPluginVersion: process.env.EDITOR_PLUGIN_VERSION || 'copilot-chat/0.23.0',
  userAgent: process.env.USER_AGENT || 'GitHubCopilotChat/0.23.0',
  copilotApiBase: process.env.COPILOT_API_BASE || 'https://api.githubcopilot.com',
  maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES || '40', 10),
};

export function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}
