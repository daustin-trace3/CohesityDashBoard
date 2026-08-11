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
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const DOMAIN_USER_RE = /\b[A-Za-z][A-Za-z0-9_-]{1,15}\\[A-Za-z][A-Za-z0-9._-]+\b/g;
const UNC_RE = /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+/g;
const MAC_RE = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
// Protected object/VM names named inline in Cohesity messages ("Restore for
// object symantecmanagementplatform_cpz in job ..."). Only tokenize candidates
// that look like machine names (contain a digit, dot, hyphen or underscore) so
// plain English after the keyword ("object could not ...") passes through.
const OBJECT_RE = /\b(object|entity|VM|volume|datastore|database|view|share|job|task)\s+['"[]?([A-Za-z0-9][A-Za-z0-9._-]{2,62})/gi;
const TOKEN_RE = /\b(CLUSTER|JOB|POLICY|SOURCE|HOST|IP|VIEW|USER|MAC|OBJECT|SERIAL|TAG)-(\d+)\b/gi;
const TOKEN_RE_TEST = /^(?:CLUSTER|JOB|POLICY|SOURCE|HOST|IP|VIEW|USER|MAC|OBJECT|SERIAL|TAG)-\d+$/i;

// Keys whose ENTIRE value is masked outright, regardless of content — these
// are opaque identifiers (serials) or bare usernames/WWNs that the pattern
// scrubbers below cannot recognize on their own.
const SERIAL_KEY_RE = /serial|service_tag/i;
const USER_KEY_RE = /^user(_?name)?$|requested_by|created_by/i;
const WWN_KEY_RE = /wwn/i;

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
  const addHostOrIp = (rows) => {
    for (const r of rows) {
      const val = String(r.name ?? '').trim();
      if (val.length >= 3) entries.push([val, isIpv4(val) ? 'IP' : 'HOST']);
    }
  };

  try {
    add(db.prepare('SELECT name FROM clusters').all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT target_cluster_name AS name FROM replication_runs WHERE target_cluster_name IS NOT NULL AND target_cluster_name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT job_name AS name FROM protection_runs WHERE job_name IS NOT NULL AND job_name != ''").all(), 'JOB');
    add(db.prepare("SELECT DISTINCT name FROM policies WHERE name IS NOT NULL AND name != ''").all(), 'POLICY');
    add(db.prepare("SELECT DISTINCT source_name AS name FROM source_registrations WHERE source_name IS NOT NULL AND source_name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT DISTINCT view_name AS name FROM license_view_detail WHERE view_name IS NOT NULL AND view_name != ''").all(), 'VIEW');
    addHostOrIp(db.prepare("SELECT DISTINCT vip AS name FROM clusters WHERE vip IS NOT NULL AND vip != ''").all());
    // Cluster tags are operator-chosen labels (site codes, programs) —
    // identifying, sent to the model in cluster context, so tokenized too.
    for (const r of db.prepare("SELECT tags FROM clusters WHERE tags IS NOT NULL AND tags != ''").all()) {
      for (const t of String(r.tags).split(',')) {
        const name = t.trim();
        if (name.length >= 3) entries.push([name, 'TAG']);
      }
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

  try {
    add(db.prepare('SELECT name FROM pure_arrays').all(), 'CLUSTER');
    addHostOrIp(db.prepare("SELECT mgmt_host AS name FROM pure_arrays WHERE mgmt_host IS NOT NULL AND mgmt_host != ''").all());
    add(db.prepare("SELECT DISTINCT remote_name AS name FROM pure_array_connections WHERE remote_name IS NOT NULL AND remote_name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT name FROM pure_volumes WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
    add(db.prepare("SELECT name FROM pure_pods WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
    add(db.prepare("SELECT name FROM pure_hosts WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
    add(db.prepare("SELECT name FROM pure_protection_groups WHERE name IS NOT NULL AND name != ''").all(), 'JOB');
    add(db.prepare("SELECT DISTINCT source_name AS name FROM pure_protection_groups WHERE source_name IS NOT NULL AND source_name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT common_name AS name FROM pure_certificates WHERE common_name IS NOT NULL AND common_name != ''").all(), 'HOST');
    add(db.prepare("SELECT issued_to AS name FROM pure_certificates WHERE issued_to IS NOT NULL AND issued_to != ''").all(), 'HOST');
    add(db.prepare('SELECT name FROM pure1_arrays').all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT array_name AS name FROM pure1_alerts WHERE array_name IS NOT NULL AND array_name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT name FROM pure1_pods WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
  } catch { /* Pure tables not present on this instance */ }

  try {
    add(db.prepare('SELECT name FROM netapp_arrays').all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT source_cluster AS name FROM netapp_snapmirror WHERE source_cluster IS NOT NULL AND source_cluster != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT DISTINCT destination_cluster AS name FROM netapp_snapmirror WHERE destination_cluster IS NOT NULL AND destination_cluster != ''").all(), 'CLUSTER');
    addHostOrIp(db.prepare("SELECT mgmt_host AS name FROM netapp_arrays WHERE mgmt_host IS NOT NULL AND mgmt_host != ''").all());
    addHostOrIp(db.prepare("SELECT management_ip AS name FROM netapp_arrays WHERE management_ip IS NOT NULL AND management_ip != ''").all());
    add(db.prepare("SELECT name FROM netapp_svms WHERE name IS NOT NULL AND name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT name FROM netapp_volumes WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
    add(db.prepare("SELECT DISTINCT aggregate_name AS name FROM netapp_volumes WHERE aggregate_name IS NOT NULL AND aggregate_name != ''").all(), 'VIEW');
    add(db.prepare("SELECT DISTINCT qtree_name AS name FROM netapp_quotas WHERE qtree_name IS NOT NULL AND qtree_name != ''").all(), 'VIEW');
    add(db.prepare("SELECT share_name AS name FROM netapp_cifs_shares WHERE share_name IS NOT NULL AND share_name != ''").all(), 'VIEW');
    add(db.prepare("SELECT name FROM netapp_nodes WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
    add(db.prepare("SELECT name FROM netapp_lifs WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
    add(db.prepare("SELECT DISTINCT node_name AS name FROM netapp_lifs WHERE node_name IS NOT NULL AND node_name != ''").all(), 'HOST');
    add(db.prepare("SELECT DISTINCT policy_name AS name FROM netapp_export_rules WHERE policy_name IS NOT NULL AND policy_name != ''").all(), 'POLICY');
  } catch { /* NetApp tables not present on this instance */ }

  try {
    add(db.prepare("SELECT name FROM zerto_sites WHERE name IS NOT NULL AND name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT name FROM zerto_vpgs WHERE name IS NOT NULL AND name != ''").all(), 'JOB');
    add(db.prepare("SELECT DISTINCT name FROM zerto_vms WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM zerto_vras WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
  } catch { /* Zerto tables not present on this instance */ }

  try {
    add(db.prepare('SELECT name FROM vcenter_vcenters').all(), 'CLUSTER');
    addHostOrIp(db.prepare("SELECT host AS name FROM vcenter_vcenters WHERE host IS NOT NULL AND host != ''").all());
    add(db.prepare("SELECT name FROM vcenter_clusters WHERE name IS NOT NULL AND name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT name FROM vcenter_hosts WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
    add(db.prepare("SELECT name FROM vcenter_vms WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM vcenter_datastores WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
  } catch { /* vCenter tables not present on this instance */ }

  try {
    add(db.prepare('SELECT name FROM dell_ome_instances').all(), 'CLUSTER');
    addHostOrIp(db.prepare("SELECT host AS name FROM dell_ome_instances WHERE host IS NOT NULL AND host != ''").all());
    add(db.prepare("SELECT name FROM dell_devices WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
  } catch { /* Dell tables not present on this instance */ }

  try {
    add(db.prepare('SELECT name FROM aria_instances').all(), 'CLUSTER');
    addHostOrIp(db.prepare("SELECT host AS name FROM aria_instances WHERE host IS NOT NULL AND host != ''").all());
    add(db.prepare("SELECT name FROM aria_deployments WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aria_projects WHERE name IS NOT NULL AND name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT name FROM aria_blueprints WHERE name IS NOT NULL AND name != ''").all(), 'JOB');
    add(db.prepare("SELECT name FROM aria_endpoints WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
  } catch { /* Aria tables not present on this instance */ }

  try {
    // aws_accounts/aws_ec2_instances/aws_lightsail_instances/aws_ecs_*/aws_s3_buckets
    // ship in AWS migration v1.
    add(db.prepare('SELECT name FROM aws_accounts').all(), 'CLUSTER');
    add(db.prepare("SELECT access_key_id AS name FROM aws_accounts WHERE access_key_id IS NOT NULL AND access_key_id != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_ec2_instances WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT instance_id AS name FROM aws_ec2_instances WHERE instance_id IS NOT NULL AND instance_id != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_lightsail_instances WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT cluster_name AS name FROM aws_ecs_clusters WHERE cluster_name IS NOT NULL AND cluster_name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT service_name AS name FROM aws_ecs_services WHERE service_name IS NOT NULL AND service_name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_s3_buckets WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
  } catch { /* AWS v1 tables not present on this instance */ }

  try {
    // aws_rds_instances/aws_lambda_functions/aws_dynamo_tables/aws_ecr_repos/aws_vpcs
    // ship in AWS migration v2 (WP1); guarded separately so its absence
    // doesn't drop the v1 AWS entries above.
    add(db.prepare("SELECT db_id AS name FROM aws_rds_instances WHERE db_id IS NOT NULL AND db_id != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_lambda_functions WHERE name IS NOT NULL AND name != ''").all(), 'JOB');
    add(db.prepare("SELECT name FROM aws_dynamo_tables WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_ecr_repos WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT vpc_id AS name FROM aws_vpcs WHERE vpc_id IS NOT NULL AND vpc_id != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM aws_vpcs WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
  } catch { /* AWS v2 tables not present until migration v2 lands */ }

  try {
    // nutanix_* tables ship in the Nutanix migration (WP1); guarded
    // separately so their absence never breaks other platforms' dictionary
    // entries.
    add(db.prepare("SELECT name FROM nutanix_sources WHERE name IS NOT NULL AND name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT host AS name FROM nutanix_sources WHERE host IS NOT NULL AND host != ''").all(), 'SOURCE');
    add(db.prepare("SELECT name FROM nutanix_clusters WHERE name IS NOT NULL AND name != ''").all(), 'CLUSTER');
    add(db.prepare("SELECT name FROM nutanix_hosts WHERE name IS NOT NULL AND name != ''").all(), 'HOST');
    add(db.prepare("SELECT serial AS name FROM nutanix_hosts WHERE serial IS NOT NULL AND serial != ''").all(), 'SERIAL');
    add(db.prepare("SELECT name FROM nutanix_vms WHERE name IS NOT NULL AND name != ''").all(), 'OBJECT');
    add(db.prepare("SELECT name FROM nutanix_containers WHERE name IS NOT NULL AND name != ''").all(), 'VIEW');
    add(db.prepare("SELECT name FROM nutanix_pds WHERE name IS NOT NULL AND name != ''").all(), 'JOB');
    add(db.prepare("SELECT name FROM nutanix_move_conns WHERE name IS NOT NULL AND name != ''").all(), 'SOURCE');
    add(db.prepare("SELECT host AS name FROM nutanix_move_conns WHERE host IS NOT NULL AND host != ''").all(), 'SOURCE');
  } catch { /* Nutanix tables not present on this instance */ }

  return entries;
}

// Appended to every AI system prompt so the model preserves tokens verbatim.
const PROMPT_NOTE =
  ' NOTE: identifiable names in the data (servers, clusters, jobs, policies, sources, views/shares, user accounts, hostnames, IP addresses, serial numbers, operator tags/labels) ' +
  'have been replaced with anonymous tokens such as CLUSTER-1, JOB-2, HOST-3, IP-4 or TAG-5. Refer to each entity ONLY ' +
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
    if (key) {
      if (SERIAL_KEY_RE.test(key)) return token('SERIAL', out);
      if (WWN_KEY_RE.test(key)) return token('MAC', out);
      if (USER_KEY_RE.test(key) && !TOKEN_RE_TEST.test(out)) return token('USER', out);
    }
    if (key && VERSION_KEY_RE.test(key)) return out;
    out = out.replace(UNC_RE, (m) => token('HOST', m));
    out = out.replace(EMAIL_RE, (m) => token('USER', m));
    out = out.replace(DOMAIN_USER_RE, (m) => token('USER', m));
    out = out.replace(MAC_RE, (m) => token('MAC', m));
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
    out = out.replace(OBJECT_RE, (kw, _keyword, name) => {
      if (!/[\d._-]/.test(name)) return kw;   // plain English, not a machine name
      if (TOKEN_RE_TEST.test(name)) return kw; // already tokenized by an earlier pass
      return kw.replace(name, token('OBJECT', name));
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
