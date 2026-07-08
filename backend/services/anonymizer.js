// Anonymization layer for all outbound AI/LLM requests.
//
// Identifiable data — cluster/server names, protection job names, policies,
// sources, hostnames, and IP addresses — is replaced with stable per-request
// tokens (CLUSTER-1, JOB-2, HOST-3, IP-4 ...) before the payload leaves the
// box. Tokens in the model's response are mapped back to the real names
// locally before the result is cached or returned, so the user always sees
// real names. Metrics (bytes, percentages, counts, versions) pass through.
//
// Two complementary strategies:
//  1. Dictionary: every known entity name in the local DB (clusters,
//     replication targets, jobs, policies, sources, VIPs) is replaced
//     wherever it appears, including embedded inside alert descriptions and
//     error messages.
//  2. Patterns: IPv4/IPv6 addresses and FQDN-shaped hostnames in free text
//     are replaced even when they are not in the dictionary.

const db = require('../db/database');

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const IPV6_RE = /\b(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g;
const FQDN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?\.)+[A-Za-z]{2,24}\b/g;
const TOKEN_RE = /\b(CLUSTER|JOB|POLICY|SOURCE|HOST|IP)-(\d+)\b/gi;

// Keys whose values are version strings — exempt from IP/FQDN scrubbing so
// "7.0.1.100" is not mistaken for an IPv4 address (dictionary still applies).
const VERSION_KEY_RE = /version|dominant/i;

// two-label matches ending in a common file extension are files, not hosts.
const FILE_EXTS = new Set([
  'js', 'ts', 'json', 'xml', 'yml', 'yaml', 'log', 'txt', 'csv', 'md', 'html',
  'htm', 'sql', 'db', 'exe', 'dll', 'so', 'conf', 'cfg', 'ini', 'gz', 'zip',
  'tar', 'tmp', 'bak', 'old', 'dat', 'bin', 'iso', 'ova', 'ovf', 'vmdk',
  'vhdx', 'vhd', 'vbk', 'vib', 'pst', 'mdf', 'ldf', 'png', 'jpg', 'pdf',
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isIpv4 = (s) => new RegExp(`^${IPV4_RE.source}$`).test(s);

/** Best-effort load of every known entity name → category from the local DB. */
function loadDictionary() {
  const entries = [];
  const add = (rows, category) => {
    for (const r of rows) {
      const name = String(r.name ?? '').trim();
      if (name.length >= 3) entries.push([name, category]);
    }
  };
  try {
    add(db.prepare('SELECT name FROM clusters').all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT target_cluster_name AS name FROM replication_runs WHERE target_cluster_name IS NOT NULL AND target_cluster_name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT job_name AS name FROM protection_runs WHERE job_name IS NOT NULL AND job_name != ''").all(), 'JOB');
    add(db.prepare("SELECT DISTINCT name FROM policies WHERE name IS NOT NULL AND name != ''").all(), 'POLICY');
    add(db.prepare("SELECT DISTINCT source_name AS name FROM source_registrations WHERE source_name IS NOT NULL AND source_name != ''").all(), 'SOURCE');
    for (const r of db.prepare("SELECT DISTINCT vip AS name FROM clusters WHERE vip IS NOT NULL AND vip != ''").all()) {
      const vip = String(r.name).trim();
      if (vip.length >= 3) entries.push([vip, isIpv4(vip) ? 'IP' : 'HOST']);
    }
    // Policy replication/archival targets are JSON arrays of names.
    for (const r of db.prepare("SELECT replication_targets, archival_targets FROM policies").all()) {
      for (const col of [r.replication_targets, r.archival_targets]) {
        try {
          for (const t of JSON.parse(col || '[]')) {
            const name = String(t ?? '').trim();
            if (name.length >= 3) entries.push([name, 'CLUSTER']);
          }
        } catch { /* ignore malformed target JSON */ }
      }
    }
  } catch { /* dictionary is best-effort; pattern scrubbing still applies */ }
  return entries;
}

// Appended to every AI system prompt so the model preserves tokens verbatim.
const PROMPT_NOTE =
  ' NOTE: identifiable names in the data (servers, clusters, jobs, policies, sources, hostnames, IP addresses) ' +
  'have been replaced with anonymous tokens such as CLUSTER-1, JOB-2, HOST-3 or IP-4. Refer to each entity ONLY ' +
  'by its exact token, verbatim and unaltered, so it can be mapped back to the real name locally. ' +
  'Never guess or invent the real names behind the tokens.';

/**
 * Create a per-request anonymizer. Token numbering is stable within one
 * request, so the same name always maps to the same token in the prompt and
 * the response maps cleanly back.
 */
function createAnonymizer() {
  const forward = new Map();  // lower(real) -> token
  const reverse = new Map();  // TOKEN -> real
  const counters = Object.create(null);
  const categoryOf = new Map();

  for (const [name, category] of loadDictionary()) {
    const key = name.toLowerCase();
    if (!categoryOf.has(key)) categoryOf.set(key, category);
  }
  const names = [...categoryOf.keys()].sort((a, b) => b.length - a.length);
  const nameRe = names.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi')
    : null;

  function token(category, real) {
    const key = real.toLowerCase();
    const existing = forward.get(key);
    if (existing) return existing;
    counters[category] = (counters[category] || 0) + 1;
    const t = `${category}-${counters[category]}`;
    forward.set(key, t);
    reverse.set(t, real);
    return t;
  }

  function scrubText(str, key) {
    if (!str || typeof str !== 'string') return str;
    let out = str;
    if (nameRe) {
      out = out.replace(nameRe, (m) => token(categoryOf.get(m.toLowerCase()) || 'HOST', m));
    }
    if (key && VERSION_KEY_RE.test(key)) return out;
    out = out.replace(IPV4_RE, (m) => token('IP', m));
    out = out.replace(IPV6_RE, (m) => {
      // Reject time-of-day lookalikes (12:30:44): a real IPv6 has a hex
      // letter, 4+ groups, or a compressed "::".
      const plausible = /[A-Fa-f]/.test(m) || m.split(':').length >= 4 || m.includes('::');
      return plausible ? token('IP', m) : m;
    });
    out = out.replace(FQDN_RE, (m) => {
      const labels = m.split('.');
      if (labels.length === 2 && FILE_EXTS.has(labels[labels.length - 1].toLowerCase())) return m;
      return token('HOST', m);
    });
    return out;
  }

  /** Deep-walk any value, scrubbing every string. Non-strings pass through. */
  function anonymize(value, key) {
    if (typeof value === 'string') return scrubText(value, key);
    if (Array.isArray(value)) return value.map((v) => anonymize(v, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = anonymize(v, k);
      return out;
    }
    return value;
  }

  /** Replace tokens in the model's response with the real names. */
  function restore(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(TOKEN_RE, (m) => reverse.get(m.toUpperCase()) ?? m);
  }

  return {
    anonymize,
    restore,
    /** Token → real-name pairs assigned so far (local-only, for the audit UI). */
    mappings() {
      return [...reverse.entries()].map(([token, real]) => ({ token, real }));
    },
    get mappedCount() { return forward.size; },
  };
}

module.exports = { createAnonymizer, PROMPT_NOTE };
