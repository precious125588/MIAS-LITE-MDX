"use strict";

const { SpeedTestService } = require("@ginkohub/speedtest-js");

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Speed test timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runSpeedTest(options = {}) {
  const timeoutMs = Math.max(10_000, Math.min(Number(options.timeoutMs) || 90_000, 300_000));
  const service = options.service || new SpeedTestService();
  const startedAt = Date.now();
  await withTimeout(service.fetchClientInfo(), timeoutMs);
  const server = options.server || await withTimeout(service.findBestServer(), timeoutMs);
  if (!server) throw new Error("No speed-test server was available");
  const latency = await withTimeout(service.testLatency(server, options.samples || 5), timeoutMs);
  const download = await withTimeout(service.testDownload(server, undefined, {
    threads: options.threads || 4,
    duration: options.downloadDuration || 5_000,
  }), timeoutMs);
  const upload = await withTimeout(service.testUpload(server, undefined, {
    duration: options.uploadDuration || 5_000,
  }), timeoutMs);
  return {
    downloadMbps: Number(download),
    uploadMbps: Number(upload),
    pingMs: Number(latency.latency),
    jitterMs: Number(latency.jitter),
    server: server.toMap ? server.toMap() : server,
    clientIp: service.clientIp || null,
    clientIsp: service.clientIsp || null,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { runSpeedTest };