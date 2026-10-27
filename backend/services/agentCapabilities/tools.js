// Agent decides mode (ops_agent_capability_mode = 'tools'): the enabled
// capabilities are offered to the model as OpenAI function-calling tools
// instead of the playbook running every check on every target.
//
// The rules that keep this safe are the same as the playbook's:
//   - a target is a menu, never free text: each tool's `target` is an enum of
//     the incident's own resolved targets, in the form the model sees them
//     (anonymized tokens), and a call outside it is refused
//   - tcp_port may only probe ports the target's profile already lists
//   - the capability's platform filter and appliesTo rule still apply
//   - every real run goes through runOne: same timeout, same audit row
//   - the public demo never runs anything (the caller never builds a toolset)
const caps = require('./index');

const MAX_TOOL_LOOP_MS = caps.PLAYBOOK_TIMEOUT_MS;
const REASON_MAX = 200;

/** OpenAI tool names allow [a-zA-Z0-9_-]; pack ids are "<pack>:<id>". */
const toolName = (capId) => String(capId).replace(/:/g, '__');

function targetKey(anon, t, taken) {
  const base = String(anon.anonymize(t.name || t.address) || t.name || t.address);
  if (!taken.has(base)) return base;
  const alt = `${base} (${anon.anonymize(t.address)})`;
  if (!taken.has(alt)) return alt;
  return `${alt} #${taken.size + 1}`;
}

/** Build the tool definitions for one incident.
 *  Returns { tools, targets: Map(token -> target), caps: Map(toolName -> cap), perTool, anon, seen }. */
function buildToolset(inc, alerts, anon, { evidence = null, deep = false } = {}) {
  const targetList = caps.targetsFor(inc, alerts);
  const targets = new Map();
  const taken = new Set();
  const keyOf = new Map();
  for (const t of targetList) {
    const k = targetKey(anon, t, taken);
    taken.add(k);
    targets.set(k, t);
    keyOf.set(t, k);
  }
  const ctx = { incidentId: inc.id, incident: inc, alerts, evidence, logger: null };
  const tools = [];
  const toolCaps = new Map();
  const perTool = new Map();
  for (const cap of caps.catalog().filter((c) => c.playbook !== false && caps.isEnabled(c.id) && (deep || !c.deepOnly))) {
    const applicable = targetList.filter((t) => {
      if (cap.platform && cap.platform !== t.platform) return false;
      if (typeof cap.appliesTo === 'function') { try { return !!cap.appliesTo(t, ctx); } catch { return false; } }
      return true;
    });
    if (!applicable.length) continue;
    const name = toolName(cap.id);
    const enumList = applicable.map((t) => keyOf.get(t));
    const properties = {
      target: { type: 'string', enum: enumList, description: 'One of the systems in this incident.' },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why this check changes the conclusion (200 characters at most).' },
    };
    if (cap.id === 'tcp_port') {
      const ports = [...new Set(applicable.flatMap((t) => (t.portEntries || []).map((e) => e.port)))].filter(Number.isInteger);
      properties.ports = {
        type: 'array', items: { type: 'integer', enum: ports },
        description: 'Optional subset of the target\'s listed ports. Omit to probe the whole profile list.',
      };
    }
    const required = ['target', 'reason'];
    if (cap.params) {
      // Capability parameters: a JSON-schema properties fragment. A property with a paramEnums
      // resolver gets an enum of the union over the applicable targets (the call is checked
      // against the chosen target's own list again in runToolCall).
      for (const [k, def] of Object.entries(cap.params.properties)) {
        if (k === 'target' || k === 'reason' || k === 'ports') continue;
        const prop = { ...def };
        const resolver = cap.paramEnums && cap.paramEnums[k];
        if (typeof resolver === 'function') {
          const union = [...new Set(applicable.flatMap((t) => { try { return resolver(t) || []; } catch { return []; } }))];
          if (!union.length) continue;
          prop.enum = union;
        }
        properties[k] = prop;
      }
      for (const k of cap.params.required || []) if (properties[k] && !required.includes(k)) required.push(k);
    }
    tools.push({
      type: 'function',
      function: {
        name,
        description: `${cap.description || cap.label} Risk class: ${cap.risk}.`,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    });
    toolCaps.set(name, cap);
    perTool.set(name, applicable);
  }
  return { tools, targets, caps: toolCaps, perTool, anon, seen: new Set(), deep: !!deep };
}

function refuse(summary, extra = {}) {
  const content = JSON.stringify({ ok: false, summary });
  return { ok: false, refused: true, summary, data: null, content, ...extra };
}

/** Check the capability's own parameters against its schema and the chosen target's menu.
 *  Returns { args } (only the declared keys) or { error } (a refusal reason). */
function validateParams(cap, args, target) {
  const props = (cap.params && cap.params.properties) || {};
  const out = {};
  for (const k of Object.keys(args)) {
    if (k === 'target' || k === 'reason' || (k === 'ports' && cap.id === 'tcp_port')) continue;
    if (!props[k]) return { error: `refused: unknown argument "${String(k).slice(0, 40)}"` };
  }
  for (const [k, def] of Object.entries(props)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if ((cap.params.required || []).includes(k)) return { error: `refused: argument "${k}" is required` };
      continue;
    }
    if (def.type === 'integer') {
      if (!Number.isInteger(v)) return { error: `refused: "${k}" must be an integer` };
      if (def.minimum !== undefined && v < def.minimum) return { error: `refused: "${k}" must be at least ${def.minimum}` };
      if (def.maximum !== undefined && v > def.maximum) return { error: `refused: "${k}" must be at most ${def.maximum}` };
    } else if (def.type === 'string') {
      if (typeof v !== 'string') return { error: `refused: "${k}" must be a string` };
      const resolver = cap.paramEnums && cap.paramEnums[k];
      let allowed = Array.isArray(def.enum) ? def.enum : null;
      if (typeof resolver === 'function') { try { allowed = resolver(target) || []; } catch { allowed = []; } }
      if (allowed && !allowed.includes(v)) return { error: `refused: "${k}" is not one of the values offered for this target` };
      if (def.maxLength && v.length > def.maxLength) return { error: `refused: "${k}" is too long` };
    } else if (def.enum && !def.enum.includes(v)) {
      return { error: `refused: "${k}" is not an allowed value` };
    }
    out[k] = v;
  }
  return { args: out };
}

/** Run one tool call the model asked for. Never throws. */
async function runToolCall(call, toolset, inc, ctx = {}) {
  const fn = (call && call.function) || {};
  let args = {};
  try { args = typeof fn.arguments === 'string' && fn.arguments.trim() ? JSON.parse(fn.arguments) : (fn.arguments || {}); }
  catch { return refuse('refused: arguments were not valid JSON'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return refuse('refused: arguments must be an object');
  const cap = toolset.caps.get(fn.name);
  if (!cap) return refuse(`refused: no such check "${String(fn.name).slice(0, 60)}"`);
  if (cap.deepOnly && !toolset.deep) return refuse('refused: this check is only available on the deep pass');
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, REASON_MAX) : '';

  // The model sees tokens; accept a restored real name too, since it is the same menu entry.
  const wanted = String(args.target ?? '');
  let target = toolset.targets.get(wanted);
  let token = wanted;
  if (!target) {
    for (const [k, t] of toolset.targets) {
      if (toolset.anon.restore(wanted) === t.name || wanted === t.name) { target = t; token = k; break; }
    }
  }
  if (!target || !(toolset.perTool.get(fn.name) || []).includes(target)) {
    return refuse('refused: target not in this incident', { cap, reason });
  }

  let run = target;
  let portsKey = '';
  if (fn.name === 'tcp_port' && args.ports !== undefined && args.ports !== null) {
    const listed = (target.portEntries || []).map((e) => e.port);
    const asked = Array.isArray(args.ports) ? args.ports.map(Number) : [];
    if (!asked.length || asked.some((p) => !listed.includes(p))) {
      return refuse('refused: port not in this target\'s profile list', { cap, target, reason });
    }
    const entries = target.portEntries.filter((e) => asked.includes(e.port));
    run = { ...target, portEntries: entries, ports: entries.map((e) => e.port) };
    portsKey = [...asked].sort((a, b) => a - b).join(',');
  }
  let runArgs = {};
  if (cap.params) {
    const v = validateParams(cap, args, target);
    if (v.error) return refuse(v.error, { cap, target, reason });
    runArgs = v.args;
  }
  const paramsKey = Object.keys(runArgs).length ? JSON.stringify(runArgs) : '';
  const dedupe = `${fn.name}|${token}|${portsKey}|${paramsKey}`;
  if (toolset.seen.has(dedupe)) return refuse('refused: this check already ran on this target', { cap, target, reason });
  toolset.seen.add(dedupe);

  const rec = await caps.runOne(cap, run, { incidentId: inc.id, incident: inc, alerts: ctx.alerts, evidence: ctx.evidence, logger: ctx.logger, requestedBy: 'model', reason }, runArgs);
  if (!rec) return refuse('refused: this check has nothing to report for that target', { cap, target, reason });
  const content = JSON.stringify(toolset.anon.anonymize({ ok: rec.ok, summary: rec.summary, data: rec.data }));
  return { ok: rec.ok, summary: rec.summary, data: rec.data, target, cap, reason, rec, content };
}

module.exports = { buildToolset, runToolCall, validateParams, toolName, MAX_TOOL_LOOP_MS, REASON_MAX };
