const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Must run before any app module loads. dotenv (loaded by server.js) does not
// override variables that are already defined — including empty strings — so
// everything set here wins over the developer's real .env.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-test-db-'));
process.env.DASHBOARD_DB_PATH = path.join(dbDir, 'test.db');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.DASHBOARD_TEST_NO_RATELIMIT = '1';
process.env.DASHBOARD_API_KEY = 'test-api-key';
process.env.LICENSE_KEY = '';
process.env.LOG_LEVEL = 'error';
// No test may reach a live model. The developer's own .env carries a real key,
// so a test that exercises a triage path would otherwise spend money and wait
// on the network (one did, for ten seconds a run, until 2026-09-26). The
// provider is left UNCONFIGURED; a test that needs the AI path on sets
// llm_custom_endpoint to a closed port itself and stubs the chat call, so a
// call nobody stubbed fails at once instead of leaving the machine.
process.env.LLM_PROVIDER = 'custom';
process.env.LLM_CUSTOM_ENDPOINT = '';
process.env.LLM_CUSTOM_TOKEN = '';
process.env.LLM_CUSTOM_MODEL = 'test-model';
process.env.OPENAI_API_KEY = '';
process.env.GITHUB_TOKEN = '';
process.env.GITHUB_MODELS_TOKEN = '';

afterAll(() => {
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* win file locks */ }
});
