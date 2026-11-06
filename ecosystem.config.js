const hostMemory = require('./mias/lib/hostMemory.cjs');
const botHeapMb = hostMemory.getRecommendedBotHeapMB({ workerCount: 1 });
const restartLimitMb = hostMemory.getRecommendedRestartMB();

module.exports = {
  apps: [{
    name: 'mias-lite-mdx',
    script: './index.js',
    watch: false,
    autorestart: true,
    max_memory_restart: `${restartLimitMb}M`,
    node_args: `--max-old-space-size=${botHeapMb}`,
    env: {
      NODE_ENV: 'production',
      RESTART_COUNT: '0',
    },
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    combine_logs: true,
    time: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    wait_ready: true,
    listen_timeout: 30000,
  }],
};
