const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level, args) {
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

// Counters and a ring of the last RECENT_MAX error/warn lines, for the System
// Health page (services/systemHealth.js). Console output is unchanged.
const RECENT_MAX = 50;
const counts = { error: 0, warn: 0 };
const recent = [];
function note(level, args) {
  counts[level] += 1;
  let msg;
  try { msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '); } catch { msg = String(args[0]); }
  recent.push({ at: new Date().toISOString(), level, msg: String(msg).slice(0, 300) });
  if (recent.length > RECENT_MAX) recent.shift();
}

const logger = {
  error: (...args) => { note('error', args); if (CURRENT_LEVEL >= 0) console.error(...fmt('error', args)); },
  warn:  (...args) => { note('warn', args); if (CURRENT_LEVEL >= 1) console.warn(...fmt('warn', args)); },
  info:  (...args) => { if (CURRENT_LEVEL >= 2) console.log(...fmt('info', args)); },
  debug: (...args) => { if (CURRENT_LEVEL >= 3) console.log(...fmt('debug', args)); },
};

logger.stats = () => ({ error: counts.error, warn: counts.warn, recent: recent.slice() });

module.exports = logger;
