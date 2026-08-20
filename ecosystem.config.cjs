/**
 * PM2 ecosystem config — System Clow.
 *
 * `clow` runs as a SINGLE process (fork mode), not cluster, on purpose:
 * the SSE live-update bus (src/crm/events.ts) keeps subscribers in an
 * in-memory Map per process. With 2+ cluster workers, a webhook landing
 * on a different worker than the one holding a browser's SSE connection
 * would silently never notify it — an intermittent "sometimes updates
 * live, sometimes needs a manual refresh" bug (incidente 2026-08-21).
 * A single tenant on this deployment doesn't need multi-core sharding;
 * correctness of live updates matters more here than zero-downtime reload.
 * If this ever needs to scale to multiple processes again, the event bus
 * has to move to something cross-process first (Redis pub/sub, etc).
 *
 * Memory ceiling: the worker above 1GB gets auto-restarted. Anthropic
 * streaming + full session context can balloon, so we keep generous
 * headroom to avoid mid-stream OOM kills.
 *
 * `litellm` stays in fork mode too — it's a single-instance proxy that
 * can't be sharded across processes (state in upstream-conn pools).
 */
module.exports = {
  apps: [
    {
      name: 'clow',
      script: 'dist/server/server.js',
      cwd: '/opt/system_clow',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      node_args: ['--max-old-space-size=1024'],
      env: {
        NODE_ENV: 'production',
        // Fixado aqui (nao so no .env) de proposito: o daemon do PM2 nesta
        // VPS foi iniciado com CLOW_HOME=/var/lib/crm-territorio no ambiente
        // (vazado de outro app), e dotenv nao sobrescreve uma env var que ja
        // existe. Sem isso, o system_clow silenciosamente lia/escrevia no
        // banco de dados do crm-territorio (incidente 2026-08-20).
        CLOW_HOME: '/var/lib/system-clow',
      },
      env_production: {
        NODE_ENV: 'production',
        CLOW_HOME: '/var/lib/system-clow',
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
