'use strict';
/* ── PROCESS SUPERVISOR ───────────────────────────────────────────────────────
   Runs server.js as one child and keeps exactly one copy of the bot alive:
   - Reclaims the port and WhatsApp session from a leftover server.js of an
     earlier run (tracked by a pid file), so a restart never hits EADDRINUSE
     or opens a second connection that conflicts with the first.
   - Restarts the child with backoff instead of ending the whole process, so
     the host does not churn the container on every crash.
   - Collapses repeated log lines: an error prints once, then at most one
     "repeated Nx" summary every 10 minutes.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR_RE = /EADDRINUSE|conflict|replaced|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|error|fail|unhandled|timeout|❌|✖|⚠/i;
const ERROR_QUIET_MS = 10 * 60 * 1000;
const PLAIN_QUIET_MS = 2000;
const MAX_SIGNATURES = 500;
const MAX_FAST_FAILS = 12;
const FAST_EXIT_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg) => process.stdout.write('[supervisor] ' + msg + '\n');

/* Line filter: first occurrence prints, repeats inside the quiet window are counted. */
function createLineFilter(write, opts = {}) {
  const errorQuiet = opts.errorQuietMs || ERROR_QUIET_MS;
  const plainQuiet = opts.plainQuietMs || PLAIN_QUIET_MS;
  const seen = new Map();
  let partial = '';

  function summary(entry, now) {
    if (!entry.suppressed) return;
    const count = entry.suppressed;
    entry.suppressed = 0;
    entry.printedAt = now;
    write(entry.sample + '  [repeated ' + count + 'x, suppressed]');
  }

  function emit(raw) {
    const line = String(raw).replace(ANSI, '').replace(/\s+$/, '');
    if (!line.trim()) return;
    const now = Date.now();
    const key = line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 240);
    const quiet = ERROR_RE.test(line) ? errorQuiet : plainQuiet;
    const entry = seen.get(key);
    if (entry && now - entry.printedAt < quiet) { entry.suppressed++; return; }
    if (entry) summary(entry, now);
    write(line);
    if (!entry && seen.size >= MAX_SIGNATURES) seen.delete(seen.keys().next().value);
    seen.set(key, { printedAt: now, suppressed: 0, sample: line, quiet });
  }

  function feed(chunk) {
    partial += String(chunk);
    let idx;
    while ((idx = partial.indexOf('\n')) !== -1) {
      emit(partial.slice(0, idx));
      partial = partial.slice(idx + 1);
    }
    if (partial.length > 4000) { emit(partial); partial = ''; }
  }

  function flush() {
    if (partial) { emit(partial); partial = ''; }
    const now = Date.now();
    for (const entry of seen.values()) {
      if (entry.suppressed && now - entry.printedAt >= entry.quiet) summary(entry, now);
    }
  }

  const timer = setInterval(flush, 15000);
  if (timer.unref) timer.unref();
  return { feed, flush };
}

/* Is the port free on all interfaces? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(Number(port), '0.0.0.0'); } catch (_) { resolve(false); }
  });
}

async function waitForPort(port, { timeoutMs = 45000, log = defaultLog } = {}) {
  if (await portFree(port)) return true;
  log('port ' + port + ' is still in use by another process; waiting for it to be released');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1000);
    if (await portFree(port)) { log('port ' + port + ' is free now'); return true; }
  }
  log('port ' + port + ' is still busy after ' + Math.round(timeoutMs / 1000) + 's; starting anyway');
  return false;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function commandLineOf(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
  } catch (_) {}
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '') : '';
}

/* Stop a server.js left behind by an earlier run. Only a process whose command line
   is this exact server.js is touched. */
async function reclaimLeftoverServer({ pidFile, serverScript, log = defaultLog }) {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10) || 0; } catch (_) { return false; }
  const drop = () => { try { fs.rmSync(pidFile, { force: true }); } catch (_) {} };
  if (!pid || pid === process.pid || !isAlive(pid)) { drop(); return false; }
  if (!commandLineOf(pid).includes(serverScript)) { drop(); return false; }

  log('stopping a leftover bot process from an earlier run (pid ' + pid + ') so the port and WhatsApp session are free');
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(250);
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
  }
  drop();
  return true;
}

async function runSupervised({
  serverScript, cwd, env, port, pidFile,
  log = defaultLog, backoffBaseMs = 3000,
}) {
  const outFilter = createLineFilter((line) => process.stdout.write(line + '\n'));
  const errFilter = createLineFilter((line) => process.stderr.write(line + '\n'));
  let child = null;
  let stopping = false;
  let fastFails = 0;
  let restarts = 0;

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  await reclaimLeftoverServer({ pidFile, serverScript, log });

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch (_) {}
    }
    const force = setTimeout(() => {
      if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch (_) {} }
    }, 10000);
    if (force.unref) force.unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
  process.on('exit', () => {
    if (child && child.exitCode === null) { try { child.kill('SIGTERM'); } catch (_) {} }
  });

  while (!stopping) {
    await waitForPort(port, { log });
    if (stopping) break;

    const startedAt = Date.now();
    const result = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(process.execPath, [serverScript], { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: 1, signal: null, error: err });
        return;
      }
      child = proc;
      try { fs.writeFileSync(pidFile, String(proc.pid)); } catch (_) {}
      proc.stdout.on('data', (chunk) => outFilter.feed(chunk));
      proc.stderr.on('data', (chunk) => errFilter.feed(chunk));
      proc.on('error', (err) => resolve({ code: 1, signal: null, error: err }));
      proc.on('exit', (code, signal) => resolve({ code, signal, error: null }));
    });
    child = null;
    outFilter.flush();
    errFilter.flush();
    try { fs.rmSync(pidFile, { force: true }); } catch (_) {}
    if (stopping) break;

    const ranMs = Date.now() - startedAt;
    fastFails = ranMs < FAST_EXIT_MS ? fastFails + 1 : 0;
    const reason = result.error ? 'could not start' : result.signal ? 'signal ' + result.signal : 'exit code ' + result.code;
    if (fastFails >= MAX_FAST_FAILS) {
      log('server keeps stopping right after start (' + reason + '); giving up after ' + fastFails + ' tries');
      process.exit(1);
    }
    restarts++;
    const wait = Math.min(MAX_BACKOFF_MS, backoffBaseMs * 2 ** Math.max(0, fastFails - 1));
    log('server stopped (' + reason + '); restarting in ' + Math.round(wait / 1000) + 's (restart #' + restarts + ')');
    await sleep(wait);
    if (!stopping) await reclaimLeftoverServer({ pidFile, serverScript, log });
  }

  outFilter.flush();
  errFilter.flush();
  process.exit(0);
}

module.exports = {
  runSupervised,
  createLineFilter,
  reclaimLeftoverServer,
  portFree,
  waitForPort,
};
