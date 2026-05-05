/**
 * PM2 ecosystem config — System Clow.
 *
 * `clow` runs in CLUSTER mode (2 workers by default). PM2 sets
 * NODE_APP_INSTANCE=0..N-1 on each spawn; the scheduler in
 * src/crm/scheduler.ts gates itself to NODE_APP_INSTANCE === '0' so
 * cron-style work (reminders, stale detection, monthly quota rotation,
 * billing tick) only runs once per cluster instead of N times.
 *
 * Reload model:
 *   pm2 reload clow --update-env
 *     → restarts workers ONE AT A TIME with PM2 routing traffic to
 *       surviving workers during each swap. /health/live stays
 *       reachable throughout (zero-downtime).
 *   pm2 restart clow
 *     → kills all workers at once (15-30s downtime). DO NOT USE in prod.
 *
 * Memory ceiling: workers above 1GB get auto-restarted. Anthropic
 * streaming + full session context can balloon, so we keep generous
 * headroom to avoid mid-stream OOM kills.
 *
 * `litellm` stays in fork mode — it's a single-instance proxy that
 * can't be sharded across processes (state in upstream-conn pools).
 */
module.exports = {
  apps: [
    {
      name: 'clow',
      script: 'dist/server/server.js',
      cwd: '/opt/system-clow',
      // CLUSTER mode + 2 instances → zero-downtime reload via pm2 reload.
      // Set CLOW_INSTANCES=max in shell env to use all CPU cores.
      exec_mode: 'cluster',
      instances: process.env.CLOW_INSTANCES || 2,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      node_args: ['--max-old-space-size=1024'],
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      time: true,
      out_file: '/root/.pm2/logs/clow-out.log',
      error_file: '/root/.pm2/logs/clow-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Grace period for in-flight requests during reload.
      kill_timeout: 8000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 200,
    },
    {
      name: 'litellm',
      script: '/opt/litellm/start.sh',
      cwd: '/opt/litellm',
      interpreter: 'bash',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      out_file: '/root/.pm2/logs/litellm-out.log',
      error_file: '/root/.pm2/logs/litellm-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
