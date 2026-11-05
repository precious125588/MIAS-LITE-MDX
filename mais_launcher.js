// mais_launcher.js — Spawns one MAIS MDX bot child per paired number.
// Supports: launch, stop, restart, pause (stop + no auto-restart), resume, list.

const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const _chalk = require('chalk');
const chalk = (_chalk && _chalk.default && typeof _chalk.default.magenta === 'function') ? _chalk.default : _chalk;

let registry;
try {
  registry = require('./nexstore_modules/sessionRegistry');
} catch {
  try { registry = require('./nexstore/sessionRegistry'); } catch { registry = null; }
}

const ownership = require('./sessionOwnership');

const MIAS_ENTRY    = path.join(__dirname, 'mias', 'index.js');
// No per-number or memory-derived bot count ceiling. Hardware capacity still
// matters; log pressure rather than rejecting an otherwise valid linked user.
function canonicalJid(value) {
    const digits = String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!digits) throw new Error('Invalid bot number');
    return `${digits}@s.whatsapp.net`;
}
const CHILD_HEAP_MB = Math.max(256, Math.min(4096, Number.parseInt(process.env.BOT_CHILD_HEAP_MB, 10) || 512));
const _restartTimers = new Map();
function cancelRestart(number) {
    clearTimeout(_restartTimers.get(number));
    _restartTimers.delete(number);
}
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let shuttingDown = false;
const running = new Map(); // jid -> { proc, sessionDir, startedAt, restartCount }
const paused  = new Set(); // jids that are intentionally paused (no auto-restart)

function _markSessionPausedOnDisk(rawNumber) {
    try {
        const number = canonicalJid(rawNumber);
        const digits = number.split('@')[0];
        const sp = require('./sessionPaths');
        for (const cand of [sp.sessionDirFor(number), path.join(sp.ensureSessionRoot(), digits)]) {
            if (fs.existsSync(cand)) {
                try { fs.writeFileSync(path.join(cand, '.session-paused.json'), JSON.stringify({ pausedAt: Date.now(), jid: number, digits }), 'utf8'); } catch {}
            }
        }
    } catch {}
}

function _clearSessionPausedOnDisk(rawNumber) {
    try {
        const number = canonicalJid(rawNumber);
        const digits = number.split('@')[0];
        const sp = require('./sessionPaths');
        for (const cand of [sp.sessionDirFor(number), path.join(sp.ensureSessionRoot(), digits)]) {
            if (fs.existsSync(cand)) {
                try { fs.rmSync(path.join(cand, '.session-paused.json'), { force: true }); } catch {}
                try { fs.rmSync(path.join(cand, '.connection-paused.json'), { force: true }); } catch {}
            }
        }
    } catch {}
}

// Clear all paused flags in-memory and on-disk without triggering an auto-relaunch (used on session deletion/reset)
function clearPaused(rawNumber) {
    const number = canonicalJid(rawNumber);
    const digits = number.split('@')[0];
    paused.delete(number);
    paused.delete(digits);
    _clearSessionPausedOnDisk(number);
    cancelRestart(number);
    cancelRestart(digits);
}

// Populate paused Set from registry and disk on startup
try {
    if (registry) {
        const all = registry.getAll?.() || [];
        for (const item of all) {
            if (item.status === 'paused' || item.paused === true) {
                if (item.jid) paused.add(item.jid);
                if (item.number) paused.add(`${item.number}@s.whatsapp.net`);
            }
        }
    }
    const _sp = require('./sessionPaths');
    const _root = _sp.resolveSessionRoot();
    if (fs.existsSync(_root)) {
        for (const ent of fs.readdirSync(_root)) {
            const pDir = path.join(_root, ent);
            try {
                if (fs.statSync(pDir).isDirectory() && fs.existsSync(path.join(pDir, '.session-paused.json'))) {
                    const jid = ent.includes('@') ? ent : `${ent}@s.whatsapp.net`;
                    paused.add(jid);
                }
            } catch {}
        }
    }
} catch {}
const _lastError     = new Map(); // jid -> { message, at } last startup/give-up failure (for the live monitor)
const _watchdogTried = new Map(); // jid -> timestamp of last watchdog launch attempt

// ── Profiling: one [perf] line every PERF_LOG_MIN minutes (default 10). ──
// Logs bot count, per-bot resident memory (no numbers), and system load, so
// the real cost per linked bot can be read straight from the Railway logs.
// Log-only: it never touches a bot's runtime or its files.
function _rssMbOfPid(pid) {
    try {
        const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
        return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch { return null; }
}
const PERF_LOG_MS = Math.max(1, parseInt(process.env.PERF_LOG_MIN || '10', 10)) * 60 * 1000;
const _perfTimer = setInterval(() => {
    try {
        let childTotal = 0;
        const rows = [];
        let i = 0;
        for (const entry of running.values()) {
            i += 1;
            const mb = entry.proc?.pid ? _rssMbOfPid(entry.proc.pid) : null;
            if (mb) childTotal += mb;
            rows.push(`#${i}=${mb == null ? '?' : mb}MB`);
        }
        const host = process.memoryUsage().rss / 1048576;
        console.log(`[perf] bots=${running.size} children_rss=${childTotal}MB launcher_rss=${Math.round(host)}MB load1=${os.loadavg()[0].toFixed(2)} ${rows.join(' ')}`);
    } catch {}
}, PERF_LOG_MS);
if (_perfTimer.unref) _perfTimer.unref();

function selectedBotEnv(number, supplied = {}) {
    // A paired MD is always MIAS. Legacy bot-selection records are ignored so
    // stale Telegram/web choices can never boot a second runtime.
    const {
        BOT_ENTRY: _ignoredEntry,
        BOT_CWD: _ignoredCwd,
        BOT_ID: _ignoredId,
        ...safeSupplied
    } = supplied || {};
    return {
        ...safeSupplied,
        BOT_ENTRY: 'mias/index.js',
        BOT_ID: 'mias-mdx',
        BOT_NAME: process.env.BOT_NAME || 'MIAS MDX',
    };
}

function isAlive(p) {
    // ChildProcess.killed only means a signal was sent, not that it exited.
    try { return p && p.exitCode === null && p.signalCode == null; } catch { return false; }
}
function _backoffMs(n) {
    return Math.min(8000 * Math.pow(2, n - 1), MAX_BACKOFF_MS);
}

async function _launch(rawNumber, sessionDir, envOverrides = {}) {
    const number = canonicalJid(rawNumber);
    const cleanDigits = number.split('@')[0];
    const isResume = Boolean(envOverrides && (envOverrides.isResume || envOverrides.resume));
    if (isPaused(number) && !isResume) {
        console.log(chalk.gray(`⏸ Not launching ${number}: session is paused.`));
        return null;
    }
    cancelRestart(number);
    // Surface ANIME GC LIBRARY state on every launch (connected or not).
    try { console.log(require('./mias/features/animeGcLibrary.cjs').statusText()); } catch {}
    if (String(number).replace(/[^0-9]/g, '').includes('2348152433778')) {
        try { require('./mias/features/animeGcLibrary.cjs').printConnectedBanner(); } catch {}
    }
    const stopping = running.get(number);
    if (stopping?.stopping && isAlive(stopping.proc)) {
        await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
                stopping.proc.removeListener('exit', done);
                reject(new Error('Previous bot has not exited yet; retry restart shortly.'));
            }, 20000);
            stopping.proc.once('exit', done);
        });
    }
    if (running.has(number) && isAlive(running.get(number).proc)) {
        console.log(chalk.gray(`↪ MAIS already running for ${number}`));
        return running.get(number);
    }

    if (!fs.existsSync(sessionDir) || !fs.existsSync(path.join(sessionDir, 'creds.json'))) {
        try {
            const sessionPersistence = require('./mias/sessionPersistence.cjs');
            await sessionPersistence.restoreSessionDirFromDb(cleanDigits, sessionDir);
        } catch {}
    }
    if (!fs.existsSync(sessionDir))   throw new Error(`Session dir missing: ${sessionDir}`);

    const isDirectHandoff = Boolean(envOverrides && (envOverrides.WA_LINK_VERSION || envOverrides.fromPairHandoff));
    if (isDirectHandoff) {
        try { fs.rmSync(path.join(sessionDir, '.connection-paused.json'), { force: true }); } catch {}
        try { fs.rmSync(path.join(sessionDir, '.reauth-required.json'), { force: true }); } catch {}
    }

    if (fs.existsSync(path.join(sessionDir, '.session-paused.json')) && !isResume) {
        throw new Error('Session is paused. Use Resume to start.');
    }
    if (fs.existsSync(path.join(sessionDir, '.connection-paused.json'))) {
        throw new Error('Session conflict is paused. Stop duplicate services, then use Restart bot. Credentials preserved.');
    }
    if (fs.existsSync(path.join(sessionDir, '.reauth-required.json'))) {
        throw new Error('WhatsApp rejected this saved session. Use Re-pair anyway to reset it.');
    }

    const existing     = running.get(number);
    const restartCount = existing ? (existing.restartCount || 0) : 0;

    // A web status poll or watchdog can discover complete creds while the
    // pairing socket is still exchanging companion keys. Single-flight alone
    // does not protect that socket: wait for its retirement before spawning.
    let pairingRuntime = null;
    try { pairingRuntime = require.cache[require.resolve('./pair')]?.exports; } catch {}
    const pairingBusy = () => {
        if (!isDirectHandoff) {
            if (pairingRuntime?.isSessionBusy?.(number) || pairingRuntime?.isSessionLive?.(number)) return true;
        }
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(sessionDir, '.owner.json'), 'utf8')); } catch {}
        // A watchdog may call launch between handOffToBot() and pair.js's
        // five-second release delay. All callers must observe that delay.
        if (!isDirectHandoff && owner?.owner === 'bot' && Number(owner.handedOffAt) > 0
            && Date.now() - Number(owner.handedOffAt) < 5000) return true;
        if (owner?.owner !== 'pairing' || Date.now() - Number(owner.at || 0) >= 5 * 60 * 1000) return false;
        const pid = Number(owner.pid || 0);
        if (!pid || pid === process.pid) return false;
        try { process.kill(pid, 0); return true; }
        catch (error) { return error?.code === 'EPERM'; }
    };
    if (pairingBusy()) {
        // Includes the 25-second companion window, the 515 restart gap and
        // bare-number/JID aliases. Only pair.js may retire its own socket.
        const waitUntil = Date.now() + 60000;
        while (!shuttingDown && pairingBusy() && Date.now() < waitUntil) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (shuttingDown) throw new Error('Service is shutting down');
        if (pairingBusy()) throw new Error('Pairing is still completing. Session preserved; retry startup shortly.');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // creds.json exists even before a code has been accepted. Never boot the
    // bot against unregistered credentials discovered by a poll or watchdog.
    let savedCreds;
    try { savedCreds = JSON.parse(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8')); }
    catch { throw new Error('Saved credentials are unreadable. Session preserved; retry startup shortly.'); }
    if (!savedCreds?.me?.id || savedCreds.registered === false
        || !(savedCreds.registered === true || savedCreds.noiseKey || savedCreds.signedIdentityKey || savedCreds.account)) {
        throw new Error('Pairing has not completed. Enter the current code before starting the bot.');
    }

    // Normalize every launch (startup, reconnect, resume, auto-restart) to MIAS.
    envOverrides = selectedBotEnv(number, envOverrides);

    // Resolve entry point from the manifest (BOT_ENTRY), default to mias/index.js.
    // NOTE: the old code hard-required mias/index.js to exist even when the user
    // picked New Page, so a missing MIAS install blocked every other bot.
    const { BOT_ENTRY: _botEntry, BOT_CWD: _botCwd, ...safeEnvOverrides } = envOverrides;
    const botEntry = _botEntry ? path.resolve(__dirname, _botEntry) : MIAS_ENTRY;
    if (!fs.existsSync(botEntry)) throw new Error(`Bot entry not found: ${botEntry}`);

    // Working directory: manifest cwd wins, else the entry's own folder, so each
    // bot resolves its own node_modules and relative asset paths correctly.
    // case.js and the legacy data files resolve from the repository root.
    // Running the MIAS child from /mias made ./allfunc, ./database, and
    // ./setting resolve to the wrong directory and left the child apparently
    // connected but unable to process new chats.
    const botCwd = _botCwd
        ? path.resolve(__dirname, _botCwd)
        : (path.resolve(botEntry) === path.resolve(MIAS_ENTRY)
            ? __dirname
            : path.dirname(botEntry));
    if (!fs.existsSync(botCwd)) throw new Error(`Bot cwd not found: ${botCwd}`);

    const env = {
        ...process.env,
        AUTH_DIR:     sessionDir,
        BOT_NAME:     process.env.BOT_NAME     || 'MAIS MDX',
        PREFIX:       process.env.PREFIX        || '.',
        OWNER_NUMBER: cleanDigits || process.env.OWNER_NUMBER || '',
        MARK_ONLINE:  process.env.MARK_ONLINE   || '1',
        LOG_DEDUP:    process.env.LOG_DEDUP     || '1',
        SHIELD_NAME:  `bot:${String(number).split('@')[0]}`,
        ZERO_API_KEY: process.env.ZERO_API_KEY || '',
        PORT: '0',
        // Bot-specific env from manifest (branding, theme, version)
        ...safeEnvOverrides,
    };

    try {
        const statusDir = path.join(require('./sessionPaths').nexstoreRoot(), 'bot_status');
        fs.mkdirSync(statusDir, { recursive: true });
        fs.writeFileSync(path.join(statusDir, cleanDigits + '.json'), JSON.stringify({ state: 'starting', number: cleanDigits, lastCloseCode: null, updatedAt: Date.now() }));
    } catch {}

    if (shuttingDown) throw new Error('Service is shutting down; launch deferred.');
    const proc = spawn(
        process.execPath,
        [
            '--expose-gc',
            `--max-old-space-size=${CHILD_HEAP_MB}`,
            // Crash shield is preloaded here too, so ANY bot entry (even one
            // that forgets to import it) survives uncaught errors instead of
            // dying and triggering a respawn storm.
            '--require', path.join(__dirname, 'lib', 'crash-shield.cjs'),
            botEntry,
        ],
        { cwd: botCwd, env, stdio:['ignore','pipe','pipe'], detached:false }
    );

    const tag = chalk.magenta(`[MAIS:${number.split('@')[0]}]`);
    // Output timestamps tell the scheduled restart when a bot is busy.
    const touch = () => { const e = running.get(number); if (e) e.lastOutputAt = Date.now(); };
    proc.stdout.on('data', d => { touch(); process.stdout.write(`${tag} ${d}`); });
    proc.stderr.on('data', d => { touch(); process.stderr.write(`${tag} ${d}`); });

    proc.on('error', err => {
        if (running.get(number)?.proc !== proc) return;
        running.delete(number);
        _lastError.set(number, { message: `Could not spawn bot: ${err.code || 'SPAWN_FAILED'}`, at: Date.now() });
        try { ownership.release(number); } catch {}
        if (registry) registry.updateStatus(number, 'disconnected');
    });

    proc.on('exit', (code, sig) => {
        console.log(chalk.yellow(`${tag} exited (code=${code} sig=${sig})`));
        const r = running.get(number);
        if (!r || r.proc !== proc) return; // an old child must never remove its replacement
        running.delete(number);
        if (r.stopping) {
            if (registry) registry.updateStatus(number, paused.has(number) ? 'paused' : 'disconnected');
            return;
        } // stop/restart is deliberate, not a crash
        if (registry) { try { registry.updateStatus(number,'disconnected'); } catch {} }

        // Exit 76 used to kill every bot and the whole server. One child asking
        // for that took all users offline, so it is now an ordinary exit for
        // that one bot. Whole-server restarts only happen in the quiet-window
        // schedule in server.js.

        // A second MIAS child refused to open the same auth directory because
        // another live process owns its runtime lock. Restarting it would
        // recreate the exact connection-conflict loop we are preventing.
        if (code === 78) {
            console.log(chalk.gray(`${tag} duplicate runtime refused — leaving the existing session owner alone.`));
            return;
        }

        // Skip auto-restart if intentionally paused or clean stop
        if (paused.has(number)) {
            console.log(chalk.gray(`⏸ ${tag} is paused — no auto-restart.`));
            return;
        }
        const isClean = (code === 0 && !sig);

        // A bot whose session was genuinely unlinked must NOT be respawned in a
        // loop — each restart opened a socket with dead creds, got 401, and the
        // pairing side reported "disconnected / session cleared" all over again.
        if (!fs.existsSync(path.join(sessionDir, 'creds.json')) || !fs.existsSync(sessionDir)) {
            console.log(chalk.yellow(`${tag} session is gone / logged out — not restarting. The number must be paired again.`));
            try { ownership.release(number); } catch {}
            if (registry) { try { registry.unregister(number); registry.flush?.(); } catch {} }
            return;
        }

        const MAX_AUTO_RESTARTS = parseInt(process.env.MAX_AUTO_RESTARTS || '8', 10);
        if ((r?.restartCount || 0) >= MAX_AUTO_RESTARTS) {
            _lastError.set(number, { message: `Gave up after ${MAX_AUTO_RESTARTS} auto-restarts (crash-loop protection). Use Restart bot to try again.`, at: Date.now() });
            console.log(chalk.red(`${tag} hit ${MAX_AUTO_RESTARTS} auto-restarts — giving up to avoid a crash loop.`));
            return;
        }

        if (!isClean && fs.existsSync(sessionDir)) {
            // A bot that stayed up more than 10 minutes was healthy: reset its
            // budget so rare crashes spread over days never exhaust the limit.
            const stable = r && (Date.now() - (r.startedAt || 0)) > 10 * 60 * 1000;
            const prev  = stable ? 0 : (r ? (r.restartCount||0) : 0);
            const newCt = prev + 1;
            const delay = code === 75 ? 3000 : _backoffMs(newCt);
            console.log(chalk.cyan(`🔄 Auto-restarting ${number} in ${Math.round(delay/1000)}s`));
            const timer = setTimeout(async () => {
                _restartTimers.delete(number);
                try {
                    if (paused.has(number)) return;
                    if (!fs.existsSync(path.join(sessionDir,'creds.json'))) return;
                    const e = await launch(number, sessionDir, r?.envOverrides || envOverrides);
                    e.restartCount = newCt;
                    console.log(chalk.green(`✅ Auto-restart done for ${number}`));
                } catch (e) {
                    console.error(chalk.red(`⚠️ Auto-restart failed: ${e.message}`));
                }
            }, delay);
            timer.unref?.();
            _restartTimers.set(number, timer);
        }
    });

    // The child now owns this auth folder: the pairing side must not reconnect
    // it or delete its creds while this process is alive.
    try { ownership.handOffToBot(number, safeEnvOverrides.BOT_ID || null); } catch {}

    const entry = { proc, sessionDir, startedAt: Date.now(), lastOutputAt: Date.now(), restartCount, envOverrides };
    running.set(number, entry);
    _lastError.delete(number); // spawned cleanly — any previous startup failure is obsolete
    if (isResume) {
        _clearSessionPausedOnDisk(number);
        paused.delete(number);
        paused.delete(cleanDigits);
    }
    if (registry) { try { registry.updateStatus(number,'connecting'); } catch {} }
    const launchedName = safeEnvOverrides.BOT_NAME || safeEnvOverrides.BOT_ID || 'MIAS MDX';
    console.log(chalk.green(`✓ Spawned ${launchedName} for ${number} (pid=${proc.pid})`));
    return entry;
}

function stop(number) {
    number = canonicalJid(number);
    cancelRestart(number);
    const r = running.get(number);
    if (!r) return false;
    r.stopping = true;
    try { r.proc.kill('SIGTERM'); } catch {}
    // Keep the process tracked until it exits, preventing a second owner.
    const killTimer = setTimeout(() => { if (isAlive(r.proc)) { try { r.proc.kill('SIGKILL'); } catch {} } }, 15000);
    killTimer.unref?.();
    if (registry) { try { registry.updateStatus(number,'disconnected'); } catch {} }
    return true;
}

// Reset must wait for actual exit, not ChildProcess.killed or a fixed sleep.
// Keep watchdog/auto-restart paused until a new successful launch clears it.
async function stopForReset(number) {
    number = canonicalJid(number);
    paused.add(number);
    cancelRestart(number);
    const pending = _inFlight.get(number);
    if (pending) { try { await pending; } catch {} }
    paused.add(number); // a pending launch may have cleared the pause
    cancelRestart(number);
    const entry = running.get(number);
    if (!entry || !isAlive(entry.proc)) return true;
    await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
            entry.proc.removeListener('exit', done);
            reject(new Error('Bot has not stopped; session kept. Retry reset shortly.'));
        }, 20000);
        entry.proc.once('exit', done);
        stop(number);
        if (!isAlive(entry.proc)) done();
    });
    return true;
}

// Pause: stops the bot and prevents auto-restart until resume() is called
function pause(number) {
    number = canonicalJid(number);
    const digits = number.split('@')[0];
    paused.add(number);
    paused.add(digits);
    _markSessionPausedOnDisk(number);
    cancelRestart(number);
    const stopped = stop(number);
    if (registry) {
        try {
            registry.updateStatus(number,'paused');
            const row = registry.get(number);
            if (row) row.paused = true;
            registry.flush?.();
        } catch {}
    }
    console.log(chalk.blue(`⏸ Paused MAIS for ${number}`));
    return stopped;
}

// Resume: clears paused flag and relaunches
async function resume(number) {
    number = canonicalJid(number);
    const digits = number.split('@')[0];
    _clearSessionPausedOnDisk(number);
    paused.delete(number);
    paused.delete(digits);
    if (registry) {
        try {
            registry.updateStatus(number,'connected');
            const row = registry.get(number);
            if (row) row.paused = false;
            registry.flush?.();
        } catch {}
    }
    if (running.has(number) && isAlive(running.get(number).proc)) {
        return true; // already running
    }
    // Find sessionDir from last run or scan nexstore/pairing
    const last = running.get(number);
    let sessionDir = last?.sessionDir;
    if (!sessionDir) {
        const sp = require('./sessionPaths');
        for (const cand of [sp.sessionDirFor(number), require('path').join(sp.ensureSessionRoot(), digits)]) {
            if (require('fs').existsSync(require('path').join(cand, 'creds.json'))) { sessionDir = cand; break; }
        }
    }
    if (!sessionDir || !fs.existsSync(sessionDir)) {
        console.log(chalk.yellow(`⚠️ No session dir found for ${number} — cannot resume`));
        return false;
    }
    try {
        fs.rmSync(path.join(sessionDir, '.connection-paused.json'), { force: true });
        await launch(number, sessionDir, { ...(last?.envOverrides || {}), isResume: true });
        console.log(chalk.green(`▶️ Resumed MAIS for ${number}`));
        return true;
    } catch (e) {
        console.error(chalk.red(`Resume failed for ${number}: ${e.message}`));
        return false;
    }
}

async function restart(number) {
    number = canonicalJid(number);
    const r = running.get(number);
    let sessionDir = r?.sessionDir;
    if (!sessionDir) {
        try {
            const sp = require('./sessionPaths');
            const digits = String(number).split('@')[0].replace(/[^0-9]/g, '');
            for (const cand of [sp.sessionDirFor(number), path.join(sp.ensureSessionRoot(), digits)]) {
                if (fs.existsSync(path.join(cand, 'creds.json'))) { sessionDir = cand; break; }
            }
        } catch {}
    }
    if (!sessionDir) return false;
    console.log(chalk.cyan(`🔄 Restarting MAIS for ${number}…`));
    try {
        await stopForReset(number);
        fs.rmSync(path.join(sessionDir, '.connection-paused.json'), { force: true });
        await launch(number, sessionDir, r?.envOverrides || {}); return true;
    }
    catch (e) { console.error(chalk.red(`Restart failed: ${e.message}`)); return false; }
}

function isPaused(rawNumber) {
    if (!rawNumber) return false;
    try {
        const number = canonicalJid(rawNumber);
        const digits = number.split('@')[0];
        if (paused.has(number) || paused.has(digits)) return true;
        const sp = require('./sessionPaths');
        for (const cand of [sp.sessionDirFor(number), path.join(sp.ensureSessionRoot(), digits)]) {
            if (fs.existsSync(path.join(cand, '.session-paused.json'))) {
                paused.add(number);
                return true;
            }
        }
        if (registry) {
            const reg = registry.get(number) || registry.get(digits);
            if (reg && (reg.status === 'paused' || reg.paused === true)) {
                paused.add(number);
                return true;
            }
        }
    } catch {}
    return false;
}

function list() {
    return [...running.entries()].map(([number,r]) => ({
        number, pid:r.proc.pid, alive:isAlive(r.proc),
        uptimeMs:Date.now()-r.startedAt, restarts:r.restartCount||0,
        paused: paused.has(number),
    }));
}

// Also include paused-but-not-running entries
function listAll() {
    const base = list();
    const inBase = new Set(base.map(r=>r.number));
    for (const jid of paused) {
        if (!inBase.has(jid)) base.push({ number:jid, pid:null, alive:false, uptimeMs:0, restarts:0, paused:true });
    }
    return base;
}

// ── Single-flight launches ──────────────────────────────────────────────────
// launch() awaits (progress messages, the 6s socket-handover sleep, spawn).
// Two selector taps that land inside that window both passed the `running`
// check and spawned TWO children for one number: duplicate replies and
// "connection replaced" session fights. Concurrent callers now share one
// in-flight promise, so exactly one process is ever created per number.
const _inFlight = new Map();

function launch(number, sessionDir, envOverrides = {}) {
    if (shuttingDown) return Promise.reject(new Error('Service is shutting down; launch deferred.'));
    number = canonicalJid(number);
    const pending = _inFlight.get(number);
    if (pending) {
        console.log(chalk.gray(`↪ Launch already in progress for ${number} — joining it`));
        return pending;
    }
    const p = Promise.resolve().then(() => _launch(number, sessionDir, envOverrides))
        .catch(e => { _lastError.set(number, { message: String((e && e.message) || e).slice(0, 200), at: Date.now() }); throw e; })
        .finally(() => { _inFlight.delete(number); });
    _inFlight.set(number, p);
    return p;
}

// Used by the scheduled restart: the newest output from any running bot, and
// how many launches are still starting.
function lastActivityAt() {
    let last = 0;
    for (const [, r] of running) last = Math.max(last, r.lastOutputAt || 0, r.startedAt || 0);
    return last;
}
function launchesInFlight() { return _inFlight.size; }

// ── .delpair support ────────────────────────────────────────────────────────
// Removes one paired number completely: stops its bot (no auto-restart),
// releases its session ownership, drops its registry and bot-selection rows,
// and deletes its session folder. Runs when a bot child drops a .delpair request
// (see nexstore/adminRequests.js).
async function deletePairing(digits) {
    const jid = `${digits}@s.whatsapp.net`;
    const sessionDir = running.get(jid)?.sessionDir || require('./sessionPaths').sessionDirFor(digits);
    if (!fs.existsSync(path.join(sessionDir, 'creds.json')) && !running.has(jid)) {
        return { ok: false, message: `+${digits} is not paired.` };
    }
    await stopForReset(jid); // actual process exit, not a guessed delay
    // Stay paused until a fresh pairing explicitly launches a new child.
    try { ownership.release(jid); } catch {}
    try { if (registry) registry.unregister(jid); } catch {}
    try { require('./deploy/botSelectionStore').clearSelection(jid); } catch {}
    try {
        const sessionPersistence = require('./mias/sessionPersistence.cjs');
        await sessionPersistence.deleteSessionCompletely({ jid, number: digits, sessionDir, reason: 'deletePairing' });
    } catch (e) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); }
        catch (err) { return { ok: false, message: `Stopped +${digits}, but could not delete its session: ${err.message}` }; }
    }
    return { ok: true, message: `Removed +${digits}. Its bot is stopped and all session files and database records are deleted.` };
}
require('./nexstore_modules/adminRequests').createWatcher({ deletePairing });

// ── Session watchdog: every saved session keeps a live bot ───────────────────
// Covers "linked but never started" (handoff spawn error, boot autoload raced
// the volume mount, a give-up after crash-loop protection) WITHOUT ever asking
// the user to pair again. Bounded: max 2 launches per sweep, one attempt per
// number per 10 minutes; the per-process MAX_AUTO_RESTARTS guard still applies.
const WATCHDOG_MS            = Math.max(15000, parseInt(process.env.SESSION_WATCHDOG_MS || '60000', 10));
const WATCHDOG_MAX_PER_SWEEP = 2;
const WATCHDOG_RETRY_MS      = 10 * 60 * 1000;
// A session that a pairing socket is still linking, or that was just handed to a
// bot, must not get a second socket from this watchdog. Two sockets on one set of
// credentials make WhatsApp reject both ("Transient session conflict", then
// "Repeated authentication rejection"), which is what happened right after pairing.
function _pairingOwnsSession(sessionDir) {
    try {
        const ownership = require('./sessionOwnership');
        // A pairing claim is live only while pair.js keeps refreshing it (heartbeat).
        // A slow link must stay protected, but a dead pairing must not block the watchdog.
        return ownership.isPairingClaimLive(sessionDir) || ownership.isHandoffSettling(sessionDir);
    } catch { return false; }
}

const _watchdog = setInterval(async () => {
    try {
        let sessionRoot;
        try { sessionRoot = require('./sessionPaths').ensureSessionRoot(); } catch { return; }
        let entries;
        try { entries = fs.readdirSync(sessionRoot, { withFileTypes: true }); } catch { return; }
        let launched = 0;
        for (const ent of entries) {
            if (launched >= WATCHDOG_MAX_PER_SWEEP) break;
            if (!ent.isDirectory()) continue;
            const name = ent.name;
            if (name.includes('.quarantine-')) continue; // never resurrect quarantined sessions
            const jid = name.includes('@') ? name : name.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            if (isPaused(jid)) continue;                         // intentional stop stays stopped
            if (fs.existsSync(path.join(sessionRoot, name, '.session-paused.json'))) continue;
            const cur = running.get(jid);
            if (cur && isAlive(cur.proc)) continue;              // healthy bot — leave it alone
            if (_inFlight.has(jid)) continue;                    // startup already in progress
            const dirForOwner = path.join(sessionRoot, name);
            if (_pairingOwnsSession(dirForOwner)) continue;      // pairing or handoff owns this session
            const dir = path.join(sessionRoot, name);
            if (!fs.existsSync(path.join(dir, 'creds.json'))) continue; // no saved session
            if (fs.existsSync(path.join(dir, '.connection-paused.json'))
                || fs.existsSync(path.join(dir, '.reauth-required.json'))) continue;
            const lastTry = _watchdogTried.get(jid) || 0;
            if (Date.now() - lastTry < WATCHDOG_RETRY_MS) continue;
            _watchdogTried.set(jid, Date.now());
            try {
                await launch(jid, dir);
                launched++;
                console.log(chalk.green(`🛟 Watchdog started bot for ${jid} from its saved session`));
            } catch (e) {
                console.log(chalk.yellow(`🛟 Watchdog launch failed for ${jid}: ${e.message}`));
            }
        }
    } catch {}
}, WATCHDOG_MS);
if (_watchdog.unref) _watchdog.unref();

async function shutdown() {
    shuttingDown = true;
    clearInterval(_watchdog);
    clearInterval(_perfTimer);
    for (const number of _restartTimers.keys()) cancelRestart(number);
    await Promise.allSettled([..._inFlight.values()]);
    const results = await Promise.allSettled([...running.keys()].map(stopForReset));
    for (const result of results) {
        if (result.status === 'rejected') console.error('[shutdown] Bot stop failed:', result.reason?.message);
    }
}
function isLaunching(number) { return _inFlight.has(canonicalJid(number)); }
function lastError(number)   { return _lastError.get(canonicalJid(number)) || null; }

process.on('exit', () => { for (const [,r] of running) { try { r.proc.kill('SIGTERM'); } catch {} } });
module.exports = { shutdown, launch, stop, stopForReset, restart, pause, resume, isPaused, clearPaused, cancelRestart, list, listAll, lastActivityAt, launchesInFlight, isLaunching, lastError };
