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
process.env.DASHBOARD_API_KEY = 'test-api-key';
process.env.LICENSE_KEY = '';
process.env.LOG_LEVEL = 'error';

afterAll(() => {
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* win file locks */ }
});
