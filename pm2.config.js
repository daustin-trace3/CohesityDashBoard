module.exports = {
  apps: [
    {
      name: 'cohesity-dashboard',
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
  ],
};
