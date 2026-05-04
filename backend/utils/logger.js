const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level, args) {
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

const logger = {
  error: (...args) => { if (CURRENT_LEVEL >= 0) console.error(...fmt('error', args)); },
  warn:  (...args) => { if (CURRENT_LEVEL >= 1) console.warn(...fmt('warn', args)); },
  info:  (...args) => { if (CURRENT_LEVEL >= 2) console.log(...fmt('info', args)); },
  debug: (...args) => { if (CURRENT_LEVEL >= 3) console.log(...fmt('debug', args)); },
};

module.exports = logger;
