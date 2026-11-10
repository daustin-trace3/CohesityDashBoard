const fs = require('fs');
const path = require('path');

// Overridable for tests so they don't have to mutate the real repo-root file.
const CHANGELOG_PATH = process.env.RELEASE_NOTES_CHANGELOG_PATH
  || path.join(__dirname, '..', '..', 'CHANGELOG.md');
const pkg = require('../../package.json');

const HEADING_RE = /^##\s*\[(.+?)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const CATEGORY_RE = /^###\s*(Added|Fixed|Changed|Removed|Security)\s*$/;
const BULLET_RE = /^-\s+(.*)$/;

let cache = null; // { mtimeMs, entries }

function fallback() {
  return { version: pkg.version, date: null, previousVersion: null, sections: [] };
}

function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;
  let currentSection = null;
  let pendingBullet = null;

  function flushBullet() {
    if (pendingBullet !== null && currentSection) {
      currentSection.items.push(pendingBullet.trim());
    }
    pendingBullet = null;
  }

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(HEADING_RE);
    if (headingMatch) {
      flushBullet();
      current = { version: headingMatch[1], date: headingMatch[2], sections: [] };
      currentSection = null;
      entries.push(current);
      continue;
    }
    if (!current) continue;

    const categoryMatch = rawLine.match(CATEGORY_RE);
    if (categoryMatch) {
      flushBullet();
      currentSection = { title: categoryMatch[1], items: [] };
      current.sections.push(currentSection);
      continue;
    }

    const bulletMatch = rawLine.match(BULLET_RE);
    if (bulletMatch) {
      flushBullet();
      pendingBullet = bulletMatch[1];
      continue;
    }

    // Continuation line for a multi-line bullet: non-empty, indented content
    // with no bullet/heading marker.
    if (pendingBullet !== null && rawLine.trim() !== '') {
      pendingBullet += ' ' + rawLine.trim();
    }
  }
  flushBullet();

  // Drop empty categories.
  for (const entry of entries) {
    entry.sections = entry.sections.filter((s) => s.items.length > 0);
  }

  return entries;
}

function loadEntries() {
  let stat;
  try {
    stat = fs.statSync(CHANGELOG_PATH);
  } catch {
    return [];
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) {
    return cache.entries;
  }
  let text;
  try {
    text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  } catch {
    return [];
  }
  let entries;
  try {
    entries = parseChangelog(text);
  } catch {
    entries = [];
  }
  cache = { mtimeMs: stat.mtimeMs, entries };
  return entries;
}

function getAll() {
  try {
    return loadEntries().map((entry) => ({
      version: entry.version,
      date: entry.date,
      sections: entry.sections,
    }));
  } catch {
    return [];
  }
}

function getLatest() {
  try {
    const entries = loadEntries();
    if (entries.length === 0) return fallback();
    const [latest, previous] = entries;
    return {
      version: latest.version,
      date: latest.date,
      previousVersion: previous ? previous.version : null,
      sections: latest.sections,
    };
  } catch {
    return fallback();
  }
}

module.exports = { getLatest, getAll };
