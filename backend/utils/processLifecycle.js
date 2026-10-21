const { execFileSync } = require('child_process');
const logger = require('./logger');

const startedAt = new Date();
const SHUTDOWN_GRACE_MS = 8000; // stays under pm2 kill_timeout (10s)

function identity() {
  let version = 'unknown';
  try { version = require('../package.json').version; } catch { /* ignore */ }
  const pmId = process.env.pm_id ?? 'none';
  return `pid=${process.pid} ppid=${process.ppid} pm_id=${pmId} version=${version} started=${startedAt.toISOString()}`;
}

function uptimeSec() {
  return Math.round(process.uptime());
}

// Best-effort lookup of whoever is listening on the port; only runs on a failed listen.
function describePortOwner(port) {
  const p = Number.parseInt(port, 10);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return 'invalid port';
  try {
    if (process.platform === 'win32') {
      const script =
        `$c = Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        'if (-not $c) { "no listener found"; exit } ' +
        '$pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; ' +
        '"pid=$($c.OwningProcess) ppid=$($pr.ParentProcessId) started=$(if ($pr.CreationDate) { $pr.CreationDate.ToString(\'o\') }) cmd=$($pr.CommandLine)"';
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    }
    const ss = execFileSync('ss', ['-ltnpH', `sport = :${p}`], { encoding: 'utf8', timeout: 5000 }).trim();
    const pid = (ss.match(/pid=(\d+)/) || [])[1];
    if (!pid) return ss || 'no listener found';
    return execFileSync('ps', ['-o', 'pid=,ppid=,lstart=,args=', '-p', pid], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (err) {
    return `lookup failed: ${err.message}`;
  }
}

function logListenError(err, port) {
  if (err.code !== 'EADDRINUSE') {
    logger.error(`[Lifecycle] listen failed on port ${port}: ${err.message} (${identity()})`);
    return;
  }
  const owner = describePortOwner(port);
  const ownerPpid = (owner.match(/ppid=(\d+)/) || [])[1];
  const sibling = ownerPpid && Number(ownerPpid) === process.ppid
    ? ' — owner shares our parent (likely an orphaned pm2 child)'
    : '';
  logger.error(`[Lifecycle] port ${port} already in use. Owner: ${owner}${sibling}. This instance: ${identity()}`);
}

function installLifecycle(server, port) {
  logger.info(`[Lifecycle] starting ${identity()}`);

  server.on('error', (err) => {
    logListenError(err, port);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) {
      logger.warn(`[Lifecycle] ${reason} received again during shutdown (pid=${process.pid})`);
      return;
    }
    shuttingDown = true;
    logger.info(`[Lifecycle] ${reason} received — closing server (pid=${process.pid} uptime=${uptimeSec()}s)`);
    setTimeout(() => {
      logger.warn(`[Lifecycle] server did not close within ${SHUTDOWN_GRACE_MS}ms — forcing exit (pid=${process.pid})`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
    server.close(() => {
      logger.info(`[Lifecycle] server closed (pid=${process.pid})`);
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // pm2 on Windows cannot deliver signals; with shutdown_with_message it sends this instead.
  process.on('message', (msg) => { if (msg === 'shutdown') shutdown('pm2 shutdown message'); });

  // Observes fatal errors without changing Node's default crash behaviour.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    logger.error(`[Lifecycle] fatal ${origin} (pid=${process.pid} uptime=${uptimeSec()}s): ${err?.stack || err}`);
  });

  process.on('exit', (code) => {
    logger.info(`[Lifecycle] exiting code=${code} pid=${process.pid} uptime=${uptimeSec()}s`);
  });
}

module.exports = { installLifecycle, identity, describePortOwner };
