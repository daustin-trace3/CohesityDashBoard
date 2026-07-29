module.exports = {
  apps: [
    {
      name: 'icc-dashboard',
      script: './backend/server.js',
      cwd: __dirname,
      // Fork mode (not cluster): a single instance gains nothing from cluster
      // mode, and pm2 cluster mode on Windows is unreliable — the long-lived
      // daemon can serve stale, cached module code after code updates.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      // Scheduled data collectors live in their own process so heavy poll
      // cycles (synchronous better-sqlite3 transactions, large JSON parses)
      // never stall API responses. Shares the SQLite DB via WAL.
      name: 'icc-poller',
      script: './backend/pollerProcess.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/poller-error.log',
      out_file: './logs/poller-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
