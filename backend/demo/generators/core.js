// Deterministic PRNG utilities shared by every demo generator, plus core-scope
// seeding (app_settings, admin user + Admin group membership).

function seedFromString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

// mulberry32: small, fast, deterministic PRNG. Same seed -> same sequence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(name) {
  return mulberry32(seedFromString(name));
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(rng, min, max, digits = 2) {
  const v = rng() * (max - min) + min;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function chance(rng, probability) {
  return rng() < probability;
}

async function seedCore(db, { argon2, now }) {
  const setSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const { encrypt } = require('../../services/encryption');

  const settings = {
    platform_pure_enabled: '1',
    platform_netapp_enabled: '1',
    license_entitled_dataprotect_tib: '2500',
    license_entitled_replica_tib: '1200',
    license_entitled_smartfiles_tib: '400',
    license_expiry: '2027-06-30',
    license_edition: 'DataProtect Premium',
    pure1_app_id: 'demo-app-id',
    pure1_private_key: encrypt('demo'),
    netapp_aiqum_host: 'aiqum.demo.local',
    netapp_aiqum_pass: encrypt('demo'),
  };
  for (const [key, value] of Object.entries(settings)) {
    setSetting.run(key, value);
  }

  const nowIso = new Date(now).toISOString();
  const passwordHash = await argon2.hash('IccDemo2026!', { type: argon2.argon2id });

  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, auth_provider, is_active, created_at, updated_at)
    VALUES ('demo', ?, 'Demo Admin', 'local', 1, ?, ?)
  `).run(passwordHash, nowIso, nowIso);

  const userId = db.prepare("SELECT id FROM users WHERE username = 'demo'").get().id;
  const adminGroupId = db.prepare("SELECT id FROM groups WHERE name = 'Admin'").get().id;
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, adminGroupId);

  return { userCount: 1 };
}

module.exports = {
  seedFromString,
  mulberry32,
  rngFor,
  randInt,
  randFloat,
  pick,
  chance,
  seedCore,
};
