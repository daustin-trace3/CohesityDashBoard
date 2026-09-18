const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// An axios error carries the whole request: config.headers (Authorization,
// apiKey, X-API-KEY, session ids), config.auth (username + password) and
// config.data (login bodies, which for several platforms are the username and
// password in clear). Node prints all of that when the error object is logged,
// and there are several hundred `logger.error(msg, err)` call sites. So the
// logger itself reduces any such error to what is safe and useful: message,
// code, method, URL without its query string or userinfo, and HTTP status.

/** URL with userinfo and query removed ("?access_token=..." is a real case). */
function safeUrl(value) {
  const s = String(value || '');
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return s.split('?')[0].replace(/\/\/[^/@]*@/, '//');
  }
}

function isRequestError(a) {
  return !!a && typeof a === 'object' && (a.isAxiosError === true || (a.config && typeof a.config === 'object' && ('headers' in a.config || 'url' in a.config)));
}

function describeRequestError(err) {
  const cfg = err.config || {};
  const method = String(cfg.method || 'get').toUpperCase();
  const base = cfg.baseURL && !/^https?:/i.test(String(cfg.url || '')) ? String(cfg.baseURL).replace(/\/+$/, '') : '';
  const url = safeUrl(`${base}${cfg.url || ''}`);
  const status = err.response && err.response.status ? ` -> HTTP ${err.response.status}` : '';
  const code = err.code ? ` [${err.code}]` : '';
  return `${err.name || 'RequestError'}: ${err.message}${code} (${method} ${url}${status})`;
}

/** Makes one log argument safe to print. Exported for the error handler. */
function sanitize(a, depth = 0) {
  if (isRequestError(a)) return describeRequestError(a);
  if (a instanceof Error) {
    // A wrapped error can carry the request error as `cause` or a custom field.
    if (isRequestError(a.cause)) {
      const clean = new Error(`${a.message} <- ${describeRequestError(a.cause)}`);
      clean.name = a.name;
      clean.stack = a.stack;
      return clean;
    }
    return a;
  }
  if (depth < 2 && a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a)) {
    let touched = false;
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      const s = sanitize(v, depth + 1);
      if (s !== v) touched = true;
      out[k] = s;
    }
    return touched ? out : a;
  }
  return a;
}

function fmt(level, args) {
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}]`;
  return [prefix, ...args.map((a) => sanitize(a))];
}

const logger = {
  error: (...args) => { if (CURRENT_LEVEL >= 0) console.error(...fmt('error', args)); },
  warn:  (...args) => { if (CURRENT_LEVEL >= 1) console.warn(...fmt('warn', args)); },
  info:  (...args) => { if (CURRENT_LEVEL >= 2) console.log(...fmt('info', args)); },
  debug: (...args) => { if (CURRENT_LEVEL >= 3) console.log(...fmt('debug', args)); },
  sanitize,
  safeUrl,
};

module.exports = logger;
