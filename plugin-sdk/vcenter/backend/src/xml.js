// Minimal SOAP/XML -> JS object parser. api.js's SOAP client was ported from
// backend/services/vcenterApi.js, which used the host's fast-xml-parser
// (ignoreAttributes:false, removeNSPrefix:true) — npm deps outside plugin-sdk
// are unreachable to a bundled plugin (no axios, no fast-xml-parser; see the
// conversion skill's sandbox-limits section), so this hand-rolled parser
// reproduces just enough of that library's default shape for the vim25 SOAP
// bodies parsed here:
//   - namespace prefixes stripped from both tag and attribute names
//   - attributes kept as `@_name`
//   - a text-only element with no attributes collapses to a bare string
//   - an element with attributes AND text keeps `{ '#text': ..., '@_x': ... }`
//   - a tag repeated under the same parent becomes an array; a single
//     occurrence stays a bare object/string
// Every call site in api.js already normalizes both shapes through the
// asArray()/flat() helpers, exactly as it did against fast-xml-parser.
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function stripNs(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

function addChild(parent, name, node) {
  if (!parent.children) parent.children = {};
  const existing = parent.children[name];
  if (existing === undefined) parent.children[name] = node;
  else if (Array.isArray(existing)) existing.push(node);
  else parent.children[name] = [existing, node];
}

function finalizeNode(node) {
  const attrKeys = Object.keys(node).filter((k) => k.startsWith('@_'));
  const hasChildren = node.children && Object.keys(node.children).length > 0;
  if (hasChildren) {
    const obj = {};
    for (const k of attrKeys) obj[k] = node[k];
    for (const [k, v] of Object.entries(node.children)) {
      obj[k] = Array.isArray(v) ? v.map(finalizeNode) : finalizeNode(v);
    }
    return obj;
  }
  if (attrKeys.length) {
    const obj = {};
    for (const k of attrKeys) obj[k] = node[k];
    if (node._text !== undefined) obj['#text'] = node._text;
    return obj;
  }
  return node._text !== undefined ? node._text : '';
}

const TAG_RE = /<([^!?/][^>]*?)(\/)?>|<\/([^>]+)>/g;
const ATTR_RE = /([^\s=/]+)\s*=\s*"([^"]*)"|([^\s=/]+)\s*=\s*'([^']*)'/g;

function parseXml(xml) {
  const src = String(xml)
    .replace(/<\?xml[^?]*\?>/, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
    .replace(/<!--[\s\S]*?-->/g, '');

  const root = {};
  const stack = [root];
  let lastIndex = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const between = src.slice(lastIndex, m.index);
    lastIndex = TAG_RE.lastIndex;
    const top = stack[stack.length - 1];
    const text = unescapeXml(between).trim();
    if (text) top._text = (top._text ? `${top._text} ` : '') + text;

    if (m[3]) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const raw = m[1];
    const selfClose = !!m[2];
    const sp = raw.match(/^([^\s/]+)([\s\S]*)$/);
    const rawName = sp[1];
    const attrsStr = sp[2] || '';
    const name = stripNs(rawName);
    const node = {};
    let am;
    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(attrsStr))) {
      const aName = stripNs(am[1] || am[3]);
      const aVal = unescapeXml(am[2] !== undefined ? am[2] : am[4]);
      node[`@_${aName}`] = aVal;
    }

    addChild(stack[stack.length - 1], name, node);
    if (!selfClose) stack.push(node);
  }

  const out = {};
  for (const [k, v] of Object.entries(root.children || {})) {
    out[k] = Array.isArray(v) ? v.map(finalizeNode) : finalizeNode(v);
  }
  return out;
}

module.exports = { parseXml };
