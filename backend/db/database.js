const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'cohesity.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys via exec
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Run schema migrations
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migration: add tags column if not present
try {
  db.exec("ALTER TABLE clusters ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists — ignore
}

module.exports = db;
