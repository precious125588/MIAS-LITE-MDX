const hostMemory = require("./mias/lib/hostMemory.cjs");
// Auto-detect optimal memory values and populate environment and .env
const memConfig = hostMemory.applyAutoMemoryEnv({ root: __dirname });
const botHeapMb = memConfig.botHeapMb;
const restartLimitMb = memConfig.restartMb;

module.exports = {
  apps: [{
    name: "mias-lite-mdx",
    script: "./index.js",
    watch: false,
    autorestart: true,
    max_memory_restart: Math.max(1024, restartLimitMb) + "M",
    node_args: "--max-old-space-size=" + Math.max(1024, botHeapMb) + " --expose-gc",
    env: {
      NODE_ENV: "production",
      RESTART_COUNT: "0",
      BOT_CHILD_HEAP_MB: String(botHeapMb),
      BOT_MEMORY_LIMIT_MB: String(memConfig.limitMb),
      SERVER_HEAP_MB: String(memConfig.serverHeapMb),
    },
    error_file: "./logs/error.log",
    out_file: "./logs/output.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    combine_logs: true,
    time: true,
    restart_delay: 5000,
    exp_backoff_restart_delay: 1000,
    min_uptime: "10s",
    wait_ready: true,
    listen_timeout: 30000,
  }],
};
