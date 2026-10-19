// LogicMonitor interface description grammar (round 9, WP3, 2026-10-16).
//
// Port descriptions at real estates name other platforms' machines in fixed
// shapes ("ASX1NACLS-02 e4a" is a NetApp node and port, "SNX2GCPRDR1SA01-CT1
// Eth2" a Pure controller port, "SJX1PENTEST1 iDRAC" a Dell management port).
// parseEndpointDescription() reads those shapes before the generic "to <name>
// <port>" parser in logicmonitorPoller.parseLinkDescription runs. The shapes
// come from the CG portal export of 2026-10-15 (verbatim examples are in
// tests/logicmonitorGrammar.test.js); the readings of what each shape means
// (e.g. "Port 2" on a Pure controller being eth2) are UNVERIFIED.
//
// It returns null when no shape applies so the generic parser runs unchanged.
// A description that only carries the CG tag "[t=<class> m= q= n=]" returns
// the class (and the remaining text as host when that is a single token) so
// the poller can store it as the interface's iccClass.

const CG_TAG = /\s*\[\s*t=([A-Za-z0-9_]+)[^\]]*\]\s*/;
// "@<kind>" suffix as in "SNX1-CORE-2 E1/8 @int" or "...-C@uplink-".
const AT_SUFFIX = /\s*@[A-Za-z0-9_-]+-?\s*$/;
// Suffix kind to the CG tag class it stands for (round 13b). A tag in the description wins over the suffix.
const SUFFIX_CLASS = { int: 'inet', inet: 'inet', mpls: 'mpls', dia: 'dia', ptp: 'ptp', p2p: 'p2p', uplink: 'upl' };
// Pair uplink: "ASX1NACLS-01 & 2 -C@uplink-" (node 01 and 02 as an LACP pair).
const PAIR_RE = /^([A-Za-z0-9_]+(?:-[A-Za-z][A-Za-z0-9_]*)*)-(\d{1,2})\s*&\s*\d{1,2}\b/;
const NETAPP_RE = /^([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*?)\s+(e\d[a-z](?:\s*&\s*e\d[a-z])*)(?![A-Za-z0-9])/i;
const PURE_RE = /^([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*?)[-\s](ct[01])\s+(eth\d+|port\s*\d+)(?![A-Za-z0-9])/i;
const IDRAC_MAC_RE = /^idrac\s*-\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i;
const IDRAC_NAME_RE = /^([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*?)[\s-]+idrac\b/i;

/**
 * The "@<kind>" suffix of a description as { kind, cls } (kind as written, lower case; cls the tag class it
 * maps to), or null when there is no suffix, the kind is unknown, or a [t=...] tag is present (the tag wins).
 */
function suffixClass(desc) {
  const s = String(desc == null ? '' : desc);
  if (CG_TAG.test(s)) return null;
  const m = s.match(/@([A-Za-z0-9_-]+?)-?\s*$/);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  return SUFFIX_CLASS[kind] ? { kind, cls: SUFFIX_CLASS[kind] } : null;
}

/**
 * @returns null | { platformHint, host, nic, confidence, cls }
 *   platformHint: 'netapp' | 'pure' | 'dell' | null
 *   host: lower-cased name (or a MAC for "idrac - <mac>"); null when the
 *         text is not a single token
 *   nic: port text ("e4a", "e0e & e1a", "ct1.eth2", "idrac") or null
 *   confidence: 'high' | 'medium' | 'low'
 *   cls: CG tag class (upl, fw, wtl, mgt, wap, vid, srv, fac, ptp, wlc, mpls,
 *        ibgp, usr, dia, p2p, gtw, b2b ...) or null
 */
function parseEndpointDescription(desc) {
  let s = String(desc == null ? '' : desc).trim();
  if (!s) return null;
  let cls = null;
  const tag = s.match(CG_TAG);
  if (tag) {
    cls = tag[1].toLowerCase();
    s = s.replace(CG_TAG, ' ').trim();
  }

  // Pair uplink first: the "@uplink" text sits inside the last token.
  const pair = s.match(PAIR_RE);
  if (pair && /@|uplink/i.test(s)) {
    return { platformHint: 'netapp', host: `${pair[1]}-${pair[2]}`.toLowerCase(), nic: null, confidence: 'medium', cls };
  }
  s = s.replace(AT_SUFFIX, '').trim();

  let m = s.match(NETAPP_RE);
  if (m) {
    return { platformHint: 'netapp', host: m[1].toLowerCase(), nic: m[2].toLowerCase().replace(/\s*&\s*/g, ' & '), confidence: 'high', cls };
  }
  m = s.match(PURE_RE);
  if (m) {
    // "Port 2" is kept as typed ("ct0.port 2"); that it means eth2 is UNVERIFIED.
    return { platformHint: 'pure', host: m[1].toLowerCase(), nic: `${m[2]}.${m[3]}`.toLowerCase().replace(/\s+/g, ' '), confidence: 'high', cls };
  }
  m = s.match(IDRAC_MAC_RE);
  if (m) return { platformHint: 'dell', host: m[1].toLowerCase(), nic: 'idrac', confidence: 'high', cls };
  m = s.match(IDRAC_NAME_RE);
  if (m) return { platformHint: 'dell', host: m[1].toLowerCase(), nic: 'idrac', confidence: 'high', cls };

  if (cls) {
    // Tag only: the remaining text is the host when it is one token.
    const single = /^[A-Za-z0-9_.-]+$/.test(s) ? s.toLowerCase() : null;
    return { platformHint: null, host: single, nic: null, confidence: 'low', cls };
  }
  return null;
}

/**
 * Apply the grammar to one description and resolve its host: LM devices first
 * (lmResolve(name) -> device id | null), then the ICC identity index
 * (iccResolve(name) -> { platform, ref } | null). Returns
 * { link, cls } where link is a topology link in the poller's shape or null
 * (nothing resolved: the caller runs the generic parser), cls the CG class.
 * A resolved platform that differs from the grammar's hint drops one
 * confidence step.
 */
function linkFromDescription(desc, lmResolve, iccResolve) {
  const g = parseEndpointDescription(desc);
  // Round 13b: with no [t=...] tag the "@<kind>" suffix is the class (parseEndpointDescription stays tag-only).
  const sfx = suffixClass(desc);
  if (!g) return { link: null, cls: sfx ? sfx.cls : null };
  if (!g.cls && sfx) g.cls = sfx.cls;
  if (!g.host) return { link: null, cls: g.cls };
  const lmId = lmResolve ? lmResolve(g.host) : null;
  if (lmId != null) {
    return { link: { dstDeviceId: lmId, dstName: g.host, dstPort: g.nic, confidence: g.confidence, dstPlatform: 'logicmonitor', dstRef: null }, cls: g.cls };
  }
  const hit = iccResolve ? iccResolve(g.host) : null;
  if (hit && hit.platform) {
    let confidence = g.confidence;
    if (g.platformHint && !(hit.platforms || [hit.platform]).includes(g.platformHint) && confidence === 'high') confidence = 'medium';
    return {
      link: { dstDeviceId: null, dstName: g.host, dstPort: g.nic, confidence, dstPlatform: hit.platform, dstRef: hit.ref },
      cls: g.cls,
    };
  }
  return { link: null, cls: g.cls };
}

module.exports = { parseEndpointDescription, linkFromDescription, suffixClass };
