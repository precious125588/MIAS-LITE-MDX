'use strict';
/* ── PROCESS SUPERVISOR ───────────────────────────────────────────────────────
   Runs server.js as one child and keeps exactly one copy of the bot alive:
   - Only one supervisor per app folder: a newer start stops the older one.
   - Reclaims the port from a leftover copy of this bot (the pid file, or whatever
     process is listening on the port and was started from this app folder).
     Anything else holding the port is left alone and reported once.
   - Restarts the child with backoff instead of ending the whole process, so the
     host does not churn the container on every crash.
   - Collapses repeated log lines: an error prints once, then at most one
     "repeated Nx" summary every 10 minutes.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { startAutoUpdateWatch } = require('./auto-update-watch.cjs');

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
const announced = new Set();
function announceOnce(key, log, msg) {
  if (announced.has(key)) return;
  announced.add(key);
  log(msg);
}

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

/* ── process helpers (Linux /proc, with ps as a fallback for the command line) ── */

function readPid(file) {
  try { return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch (_) { return 0; }
}

function procStat(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], ppid: Number(fields[1]) || 0 };
  } catch (_) { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (err) { if (err.code !== 'EPERM') return false; }
  const stat = procStat(pid);
  return !(stat && stat.state === 'Z');   // a zombie has exited
}

function commandLineOf(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
  } catch (_) {}
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '') : '';
}

function cwdOf(pid) {
  try { return path.resolve(fs.readlinkSync('/proc/' + pid + '/cwd')); } catch (_) { return ''; }
}

/* Was this process started from this app folder (or is it running this server.js)? */
function isThisApp(pid, appRoot, serverScript) {
  if (!pid || pid === process.pid || !isAlive(pid)) return false;
  const root = path.resolve(appRoot);
  const cwd = cwdOf(pid);
  if (cwd && cwd === root) return true;
  return commandLineOf(pid).split(' ').some((t) => t === serverScript || t === root || t.startsWith(root + path.sep));
}

async function terminate(pid, graceMs = 10000) {
  if (!pid || pid === process.pid || !isAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  for (let i = 0; i < graceMs / 250 && isAlive(pid); i++) await sleep(250);
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
  }
  return !isAlive(pid);
}

/* PIDs that have a listening TCP socket on the port (IPv4 and IPv6). */
function listenersOnPort(port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue;          // 0A = LISTEN
      if ((cols[1].split(':')[1] || '').toUpperCase() !== hex) continue;
      inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return [];
  const pids = new Set();
  let procs = [];
  try { procs = fs.readdirSync('/proc'); } catch (_) { return []; }
  for (const entry of procs) {
    if (!/^\d+$/.test(entry)) continue;
    let fds = [];
    try { fds = fs.readdirSync('/proc/' + entry + '/fd'); } catch (_) { continue; }
    for (const fd of fds) {
      try {
        const m = fs.readlinkSync('/proc/' + entry + '/fd/' + fd).match(/^socket:\[(\d+)\]$/);
        if (m && inodes.has(m[1])) { pids.add(Number(entry)); break; }
      } catch (_) {}
    }
  }
  return [...pids].filter((pid) => pid !== process.pid);
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
  announceOnce('wait:' + port, log, 'port ' + port + ' is still in use by another process; waiting for it to be released');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1000);
    if (await portFree(port)) { log('port ' + port + ' is free now'); return true; }
  }
  log('port ' + port + ' is still busy after ' + Math.round(timeoutMs / 1000) + 's; starting anyway');
  return false;
}

/* Free the port from a leftover copy of this bot. Foreign processes are never touched. */
async function reclaimPortHolders({ port, appRoot, serverScript, log = defaultLog }) {
  const parentOfHolder = [];
  for (const pid of listenersOnPort(port)) {
    if (pid === process.ppid) continue;
    if (!isThisApp(pid, appRoot, serverScript)) {
      announceOnce('foreign:' + pid, log,
        'port ' + port + ' is held by a process that is not this bot (pid ' + pid + '); leaving it alone');
      continue;
    }
    const parent = procStat(pid) ? procStat(pid).ppid : 0;
    log('port ' + port + ' is held by a leftover copy of this bot (pid ' + pid + '); stopping it');
    await terminate(pid);
    parentOfHolder.push(parent);
  }
  // The leftover's own launcher, when it is a node process of this app, would restart it.
  for (const parent of parentOfHolder) {
    if (!parent || parent <= 1 || parent === process.pid || !isAlive(parent)) continue;
    if (/\bnode\b.*(index\.js|start-with-session-migration\.cjs|server\.js)/.test(commandLineOf(parent)) &&
        isThisApp(parent, appRoot, serverScript)) {
      log('stopping the launcher (pid ' + parent + ') of the leftover copy so it cannot restart it');
      await terminate(parent);
    }
  }
}

/* Stop a server.js left behind by an earlier run (tracked by the pid file). */
async function reclaimLeftoverServer({ pidFile, serverScript, appRoot, log = defaultLog }) {
  const pid = readPid(pidFile);
  const drop = () => { try { fs.rmSync(pidFile, { force: true }); } catch (_) {} };
  if (!pid || pid === process.pid || !isAlive(pid)) { drop(); return false; }
  if (!isThisApp(pid, appRoot, serverScript)) { drop(); return false; }
  log('stopping a leftover bot process from an earlier run (pid ' + pid + ') so the port and WhatsApp session are free');
  await terminate(pid);
  drop();
  return true;
}

/* Only one supervisor per app folder: a newer start replaces the older one. */
async function takeSupervisorLock({ lockFile, appRoot, serverScript, log = defaultLog }) {
  const other = readPid(lockFile);
  if (other && other !== process.pid && isThisApp(other, appRoot, serverScript)) {
    log('another supervisor for this bot is running (pid ' + other + '); stopping it so only one copy runs');
    await terminate(other);
  }
  fs.writeFileSync(lockFile, String(process.pid));
}

async function runSupervised({
  serverScript, cwd, env, port, pidFile, execArgs = [],
  log = defaultLog, backoffBaseMs = 3000,
}) {
  const appRoot = path.resolve(cwd);
  const runDir = path.dirname(pidFile);
  const lockFile = path.join(runDir, 'supervisor.pid');
  const outFilter = createLineFilter((line) => { lastOutputAt = Date.now(); process.stdout.write(line + '\n'); });
  const errFilter = createLineFilter((line) => { lastOutputAt = Date.now(); process.stderr.write(line + '\n'); });
  let child = null;
  let stopping = false;
  let fastFails = 0;
  let restarts = 0;
  let lastOutputAt = Date.now();
  const gate = { updating: false };

  fs.mkdirSync(runDir, { recursive: true });
  await takeSupervisorLock({ lockFile, appRoot, serverScript, log });
  await reclaimLeftoverServer({ pidFile, serverScript, appRoot, log });

  const stopChild = () => new Promise((resolve) => {
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return resolve();
    current.once('exit', () => resolve());
    try { current.kill('SIGTERM'); } catch (_) { resolve(); }
    const force = setTimeout(() => { try { current.kill('SIGKILL'); } catch (_) {} }, 10000);
    if (force.unref) force.unref();
  });
  const autoUpdate = startAutoUpdateWatch({
    root: appRoot, env: process.env, log, gate, stopChild,
    lastOutputAt: () => lastOutputAt,
  });

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    autoUpdate.stop();
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
    if (readPid(lockFile) === process.pid) { try { fs.rmSync(lockFile, { force: true }); } catch (_) {} }
  });

  while (!stopping) {
    while (gate.updating && !stopping) await sleep(500);
    if (stopping) break;
    if (port && !(await portFree(port))) {
      await reclaimPortHolders({ port, appRoot, serverScript, log });
      await waitForPort(port, { log });
    }
    if (stopping) break;

    const startedAt = Date.now();
    const result = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(process.execPath, [...execArgs, serverScript], { cwd: appRoot, env, stdio: ['inherit', 'pipe', 'pipe'] });
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
    if (!stopping) await reclaimLeftoverServer({ pidFile, serverScript, appRoot, log });
  }

  outFilter.flush();
  errFilter.flush();
  process.exit(0);
}

module.exports = {
  runSupervised,
  createLineFilter,
  reclaimPortHolders,
  listenersOnPort,
  portFree,
  waitForPort,
};
