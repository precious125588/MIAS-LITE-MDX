// @itsliaaa/baileys is ESM-only — cannot use require(). Load via dynamic import.
let makeWASocket, jidDecode, DisconnectReason, PHONENUMBER_MCC,
    makeCacheableSignalKeyStore, useMultiFileAuthState, Browsers,
    getContentType, proto, downloadContentFromMessage, fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    makeInMemoryStore;

const _baileysReady = (async () => {
    try {
        const B = await import("@whiskeysockets/baileys");
        makeWASocket               = B.default || B.makeWASocket;
        jidDecode                  = B.jidDecode;
        DisconnectReason           = B.DisconnectReason;
        PHONENUMBER_MCC            = B.PHONENUMBER_MCC || {};
        makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
        useMultiFileAuthState      = B.useMultiFileAuthState;
        Browsers                   = B.Browsers;
        getContentType             = B.getContentType;
        proto                      = B.proto;
        downloadContentFromMessage = B.downloadContentFromMessage;
        fetchLatestBaileysVersion  = B.fetchLatestBaileysVersion;
        fetchLatestWaWebVersion    = B.fetchLatestWaWebVersion;
        makeInMemoryStore          = B.makeInMemoryStore;
    } catch (e) {
        console.error('[pair] Failed to load @whiskeysockets/baileys:', e.message);
        throw e;
    }
})();
const { EventEmitter } = require("events");
const pairEvents = new EventEmitter();
const NodeCache = require("node-cache");
const _ = require('lodash')
const {
    Boom
} = require('@hapi/boom')
const PhoneNumber = require('awesome-phonenumber')
// Pairing is selected by the caller.  The old implementation hard-coded a
// phone number here, which made every connection use pairing-code mode and
// made it impossible for the web UI to offer a QR option.
const defaultPairingMode = process.argv.includes("--qr") ? "qr" : "code";
const useMobile = process.argv.includes("--mobile");
const pino = require('pino')
// file-type 22 is ESM-only: load it with a dynamic import on first use.
const FileType = { fromBuffer: async (buf) => { const m = await import('file-type'); return (m.fileTypeFromBuffer ?? m.default?.fromBuffer)(buf) } }
const fs = require('fs')
const path = require('path')
let themeemoji = "😇";
const chalk = require('chalk')
const { writeExif, imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./allfunc/exif')
const { isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch } = require('./allfunc/myfunc')
const ownership = require('./sessionOwnership')
const { waitForCompanionSync } = require('./mias/lib/companionSyncGrace.cjs')

// Define sleep function directly here to avoid import issues
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// PRECIOUS: always the Railway volume (falls back to <repo>/nexstore/pairing).
// v34: precious-session-boot is merged into precious-master-fix-boot.cjs
// (bootParent). ensureSessionRoot() below keeps this module self-sufficient.
const _sessionPaths = require('./sessionPaths');
const PAIRING_ROOT = _sessionPaths.ensureSessionRoot();
const LEGACY_PAIRING_FILE = path.join(PAIRING_ROOT, 'pairing.json');

function canonicalSessionName(nexusDevNumber) {
    const raw = String(nexusDevNumber || '');
    if (!raw.endsWith('@s.whatsapp.net')) return raw;
    const digits = raw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : raw;
}

function getSessionPath(nexusDevNumber) {
    return path.join(PAIRING_ROOT, canonicalSessionName(nexusDevNumber));
}

function getPairingCodePath(nexusDevNumber) {
    return path.join(getSessionPath(nexusDevNumber), 'pairing-code.json');
}

function getPairingQrPath(nexusDevNumber) {
    return path.join(getSessionPath(nexusDevNumber), 'pairing-qr.json');
}

function ensureSessionPath(nexusDevNumber) {
    ensureDirectoryExists(PAIRING_ROOT);
    const sessionPath = getSessionPath(nexusDevNumber);
    ensureDirectoryExists(sessionPath);
    return sessionPath;
}

// ── Session liveness ─────────────────────────────────────────────────────────
// A folder with a creds.json is NOT proof the number is still linked. When a
// user unlinks the device from their phone (or WhatsApp kills the session with
// a 401), the files stay on disk, so the old check answered "already paired"
// forever and the number could never be paired again. Everything below treats
// a session as paired only when the credentials are actually complete AND the
// session has not been logged out.

// Numbers purged in the last PURGE_GRACE_MS are never reported as paired, even
// if a late creds.update write recreates the folder behind our back.
const PURGE_GRACE_MS = 60 * 1000;
const recentlyPurged = new Map();

// ── PAIRING WINDOW GUARD ─────────────────────────────────────────────────────
// While a number is actively pairing, its session folder legitimately contains
// an INCOMPLETE creds.json (registered !== true) — that is what the pairing
// handshake writes before the user types the code. Any status poll from the
// web UI / Telegram used to run hasPairedSession() on it, decide "incomplete /
// expired" and forceCleanupSession() the very keys the handshake needs. That
// is exactly the deploy log: pairing code issued -> "Incomplete/expired
// session ... clearing" -> "Force cleaned" -> the typed code never works.
// Nothing may wipe a session inside this window unless it is forced.
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const pairingWindow = new Map();

function beginPairingWindow(nexusDevNumber) {
    pairingWindow.set(nexusDevNumber, Date.now());
}

function endPairingWindow(nexusDevNumber) {
    pairingWindow.delete(nexusDevNumber);
}

function isPairingInProgress(nexusDevNumber) {
    const ts = pairingWindow.get(nexusDevNumber);
    if (!ts) return false;
    if (Date.now() - ts > PAIRING_WINDOW_MS) {
        pairingWindow.delete(nexusDevNumber);
        return false;
    }
    return true;
}

// A session that still carries a paired identity (creds.me.id) must never be
// wiped by a transient disconnect code. Only an unfinished pairing (no identity)
// or an explicit user reset/unlink may remove files.
function _sessionHasIdentity(nexusDevNumber) {
    try {
        const c = JSON.parse(fs.readFileSync(path.join(getSessionPath(nexusDevNumber), 'creds.json'), 'utf8'));
        return credsAreComplete(c);
    } catch { return false; }
}

function markPurged(nexusDevNumber) {
    recentlyPurged.set(nexusDevNumber, Date.now());
}

function wasRecentlyPurged(nexusDevNumber) {
    const ts = recentlyPurged.get(nexusDevNumber);
    if (!ts) return false;
    if (Date.now() - ts > PURGE_GRACE_MS) {
        recentlyPurged.delete(nexusDevNumber);
        return false;
    }
    return true;
}

function readCredsFile(nexusDevNumber) {
    const credsPath = path.join(getSessionPath(nexusDevNumber), 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch {
        return null;
    }
}

function credsAreComplete(creds) {
    if (!creds || creds.registered === false) return false;
    if (creds.registered === true && creds.me && creds.me.id) return true;
    if (creds.me && creds.me.id && (creds.noiseKey || creds.signedIdentityKey || creds.account)) return true;
    return false;
}

// Older bot-side .pair handlers saved credentials in pairing/<digits>, while
// the web flow and launcher expect pairing/<digits>@s.whatsapp.net. Migrate
// only complete sessions: copying half-written keys during a live handshake
// can invalidate the pairing code the phone is currently approving.
function migrateLegacySessionDir(nexusDevNumber) {
    const result = _sessionPaths.migrateLegacySessionDir(nexusDevNumber);
    if (result?.migrated) {
        console.log(chalk.green(`[pair] Migrated complete legacy session to ${result.to}`));
        return true;
    }
    if (result?.error) {
        console.log(chalk.yellow(`[pair] Legacy session migration skipped: ${result.error}`));
    }
    return false;
}

// Returns true only for a session that is genuinely still linked.
// Invalid / logged-out leftovers are wiped so the number can pair again.
function hasPairedSession(nexusDevNumber, options = {}) {
    const { clean = true } = options;

    if (wasRecentlyPurged(nexusDevNumber)) return false;

    migrateLegacySessionDir(nexusDevNumber);
    const credsPath = path.join(getSessionPath(nexusDevNumber), 'creds.json');
    if (!fs.existsSync(credsPath)) return false;

    if (fs.existsSync(path.join(getSessionPath(nexusDevNumber), '.reauth-required.json'))) return false;

    // A session that a bot process is actively running must never be judged
    // (or cleaned) by the pairing side.
    if (ownership.isOwnedByBot(nexusDevNumber)) {
        try {
            const _launcher = require('./mais_launcher');
            const cleanDigits = String(nexusDevNumber).split('@')[0].replace(/[^0-9]/g, '');
            const botAlive = (_launcher.list() || []).some(b => {
                const bDigits = String(b.number).split('@')[0].replace(/[^0-9]/g, '');
                return bDigits === cleanDigits && b.alive;
            });
            if (botAlive) return true;
        } catch {}
    }

    // Mid-pairing: session is NOT yet paired until handshake completes and pairing window ends.
    if (isPairingInProgress(nexusDevNumber)) return false;

    const creds = readCredsFile(nexusDevNumber);
    if (!credsAreComplete(creds)) {
        // Mid-pairing: incomplete creds are expected, never a reason to wipe.
        if (isPairingInProgress(nexusDevNumber)) return false;
        if (clean) {
            console.log(chalk.yellow(`🧹 Incomplete/expired session for ${nexusDevNumber} — clearing so it can pair again.`));
            forceCleanupSession(nexusDevNumber);
        }
        return false;
    }

    const tracker = rentbotTracker.get(nexusDevNumber);
    if (tracker && (tracker.loggedOut || tracker.sessionInvalid)) {
        if (clean) {
            console.log(chalk.yellow(`🧹 ${nexusDevNumber} was logged out — clearing session.`));
            forceCleanupSession(nexusDevNumber);
        }
        return false;
    }

    return true;
}

// Is there a live websocket for this number right now?
function sessionDigits(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function isSessionLive(nexusDevNumber) {
    const digits = sessionDigits(nexusDevNumber);
    if (!digits) return false;
    for (const [name, tracker] of rentbotTracker) {
        if (sessionDigits(name) !== digits || tracker.disconnected || tracker.loggedOut) continue;
        if (!tracker.connection?.__retired && socketIsOpen(tracker.connection)) return true;
    }
    return false;
}

// The launcher must not steal a registered identity while companion sync or
// the 515 replacement is still running. A transport-open check alone misses
// both the restart gap and a tracker stored under the bare-number spelling.
function isSessionBusy(nexusDevNumber) {
    const digits = sessionDigits(nexusDevNumber);
    if (!digits) return false;
    for (const name of pairingStarts.keys()) {
        if (sessionDigits(name) === digits) return true;
    }
    for (const [name, tracker] of rentbotTracker) {
        if (sessionDigits(name) !== digits) continue;
        // Keep watchdog/status launches out until the retired transport has
        // actually closed, including a failed close requiring service restart.
        if (tracker.handoffClosing) return true;
        if (tracker.handoffToMais || tracker.loggedOut) continue;
        if (tracker.isRestarting515 && !tracker.pairingError) return true;
        if (!tracker.disconnected && tracker.connection && !tracker.connection.__retired
            && (tracker.connection.__opening || hasLiveHandshake(name))) return true;
        if (!tracker.pairingError && isPairingInProgress(name)) return true;
    }
    return false;
}

function getSessionState(nexusDevNumber) {
    const paired = hasPairedSession(nexusDevNumber);
    return {
        number: nexusDevNumber,
        paired,
        live: paired && isSessionLive(nexusDevNumber),
        loggedOut: !paired && fs.existsSync(getSessionPath(nexusDevNumber))
    };
}

// A small, read-only snapshot for the web status stream. Do not use this for
// cleanup decisions: status polling must never delete a half-written pairing
// session just because the browser refreshed.
function getPairingRuntimeState(nexusDevNumber) {
    const tracker = rentbotTracker.get(nexusDevNumber);
    let code = null;
    let qr = false;
    try { code = readPairingCodeRecord(nexusDevNumber)?.code || null; } catch {}
    try { qr = !!readPairingQrRecord(nexusDevNumber)?.qr; } catch {}
    let paired = false;
    try { paired = hasPairedSession(nexusDevNumber, { clean: false }); } catch {}
    return {
        active: isPairingActive(nexusDevNumber),
        inProgress: isPairingInProgress(nexusDevNumber),
        mode: tracker?.pairingMode || null,
        paired,
        live: paired && isSessionLive(nexusDevNumber),
        code,
        qr,
        error: tracker?.pairingError || null,
        disconnected: !!tracker?.disconnected,
        debug: tracker?.pairingDebug || null,
        stage: tracker?.pairingStage || (code ? 'code_ready' : (qr ? 'qr_ready' : (isPairingActive(nexusDevNumber) ? 'connecting' : 'idle'))),
        lastDisconnectReason: tracker?.lastDisconnectReason || null,
        handoffToMais: !!tracker?.handoffToMais,
        isRestarting515: !!tracker?.isRestarting515,
        isLinking: !!tracker?.isLinking,
    };
}

// Explicit unlink — used by the web UI so a user can re-pair a dead number.
const sessionResets = new Map();
function unpairSession(nexusDevNumber, options = {}) {
    nexusDevNumber = `${sessionDigits(nexusDevNumber)}@s.whatsapp.net`;
    if (sessionResets.has(nexusDevNumber)) return sessionResets.get(nexusDevNumber);
    const reset = unpairSessionOnce(nexusDevNumber, options).finally(() => {
        sessionResets.delete(nexusDevNumber);
    });
    sessionResets.set(nexusDevNumber, reset);
    return reset;
}
async function unpairSessionOnce(nexusDevNumber, options = {}) {
    const launcher = require('./mais_launcher');
    await launcher.stopForReset(nexusDevNumber);
    // An in-progress setup may still be awaiting version/auth I/O. Let it
    // finish before retiring its writer; reject new setup while reset is held.
    const starting = pairingStarts.get(nexusDevNumber);
    if (starting) { try { await starting; } catch {} }
    const conn = rentbotTracker.get(nexusDevNumber)?.connection
        || rentbotTracker.get(nexusDevNumber)?.retiredConnection;
    retireSocket(nexusDevNumber, 'explicit reset');
    // Never delete auth files while an accepted write is still pending.
    // A timed-out drain must fail reset visibly rather than resurrect old keys.
    await conn?.__flushCreds?.({ allowFailed: true });
    await launcher.stopForReset(nexusDevNumber); // a settling handoff may have launched
    for (let i = connectionQueue.length - 1; i >= 0; i--) {
        if (sessionDigits(connectionQueue[i].nexusDevNumber) !== sessionDigits(nexusDevNumber)) continue;
        connectionQueue.splice(i, 1)[0].reject(new Error('Pairing cancelled by reset'));
    }
    queuedNumbers.delete(nexusDevNumber);
    clearPairingCodeRecord(nexusDevNumber);
    clearPairingQrRecord(nexusDevNumber);
    endPairingWindow(nexusDevNumber);
    ownership.release(nexusDevNumber);
    const sessionPersistence = require('./mias/sessionPersistence.cjs');
    const result = await sessionPersistence.deleteSessionCompletely({ number: nexusDevNumber, reason: 'unpairSession', ...options, force: true });
    if (!result?.ok) throw new Error(result?.error || 'Session cleanup failed; retry reset.');
    rentbotTracker.delete(nexusDevNumber);
    markPurged(nexusDevNumber);
    // Unpairing is the ONLY thing that unlocks the bot choice, so the number
    // can pick a different bot on its next pairing.
    try { require('./deploy/botSelectionStore').clearSelection(nexusDevNumber); } catch {}
    try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
    try { fs.unlinkSync(getPairingQrPath(nexusDevNumber)); } catch {}
    try {
        if (fs.existsSync(LEGACY_PAIRING_FILE)) {
            const payload = JSON.parse(fs.readFileSync(LEGACY_PAIRING_FILE, 'utf8'));
            if (payload?.number === nexusDevNumber) fs.unlinkSync(LEGACY_PAIRING_FILE);
        }
    } catch {}
    return result;
}

// WhatsApp pairing codes expire after a couple of minutes. Serving a cached
// code from an old attempt is exactly what made users type a dead code and
// immediately get "Reason: 401", so anything older than PAIRING_CODE_TTL is
// treated as non-existent (and deleted).
const PAIRING_CODE_TTL = 2 * 60 * 1000;

// A pairing code is only usable while the socket that requested it is still
// alive. Records survive process restarts (and outlive dead sockets), so a
// cached code from a previous run was handed to users who then typed a code
// that no live handshake was listening for — WhatsApp answers that with
// "couldn't link device" / an instant 401. Codes are therefore scoped to this
// process AND to a still-connected socket.
const PAIRING_INSTANCE_ID = `${process.pid}-${Date.now()}`;

function hasLiveHandshake(nexusDevNumber) {
    const tracker = rentbotTracker.get(nexusDevNumber);
    if (!tracker || tracker.disconnected || tracker.loggedOut) return false;
    const conn = tracker.connection;
    if (!conn || conn.__retired || conn.ws?.isClosed === true || conn.ws?.isClosing === true) return false;
    const rs = conn.ws?.readyState ?? conn.ws?.socket?.readyState;
    return rs === 0 || rs === 1 || rs === undefined;
}

function clearPairingCodeRecord(nexusDevNumber) {
    const tracker = rentbotTracker.get(nexusDevNumber);
    if (tracker) {
        tracker.pairingCode = null;
        tracker.pairingError = null;
    }
    try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
    try {
        if (fs.existsSync(LEGACY_PAIRING_FILE)) {
            const payload = JSON.parse(fs.readFileSync(LEGACY_PAIRING_FILE, "utf8"));
            if (!payload?.number || payload?.number === nexusDevNumber) fs.unlinkSync(LEGACY_PAIRING_FILE);
        }
    } catch {}
}

function clearPairingQrRecord(nexusDevNumber) {
    const tracker = rentbotTracker.get(nexusDevNumber);
    if (tracker) {
        tracker.pairingQr = null;
        tracker.pairingQrTimestamp = 0;
    }
    try { fs.unlinkSync(getPairingQrPath(nexusDevNumber)); } catch {}
}

function isPairingActive(nexusDevNumber) {
    const tracker = rentbotTracker.get(nexusDevNumber);
    return !!(tracker
        && !tracker.disconnected
        && !tracker.loggedOut
        && !tracker.pairingError
        && !tracker.handoffToMais
        && isPairingInProgress(nexusDevNumber)
        && hasLiveHandshake(nexusDevNumber));
}

function getPairingMode(nexusDevNumber) {
    return isPairingActive(nexusDevNumber)
        ? rentbotTracker.get(nexusDevNumber)?.pairingMode || null
        : null;
}

function isFreshPairingRecord(payload, field = 'code') {
    if (payload && payload.instance && payload.instance !== PAIRING_INSTANCE_ID) return false;
    if (payload && !payload.instance) return false; // written by an older run
    if (!payload?.[field]) return false;
    const ts = Date.parse(payload.timestamp || '');
    if (!ts || Number.isNaN(ts)) return false;
    return Date.now() - ts < PAIRING_CODE_TTL;
}

function readPairingCodeRecord(nexusDevNumber) {
    const sessionFile = getPairingCodePath(nexusDevNumber);

    try {
        if (fs.existsSync(sessionFile)) {
            const payload = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            if (isFreshPairingRecord(payload) && hasLiveHandshake(nexusDevNumber)) return payload;
            try { fs.unlinkSync(sessionFile); } catch {}
        }
    } catch (error) {
        console.log(chalk.yellow(`⚠️ Failed to read session pairing code for ${nexusDevNumber}: ${error.message}`));
    }

    try {
        if (fs.existsSync(LEGACY_PAIRING_FILE)) {
            const payload = JSON.parse(fs.readFileSync(LEGACY_PAIRING_FILE, 'utf8'));
            if (payload?.number === nexusDevNumber) {
                if (isFreshPairingRecord(payload) && hasLiveHandshake(nexusDevNumber)) return payload;
                try { fs.unlinkSync(LEGACY_PAIRING_FILE); } catch {}
            }
        }
    } catch (error) {
        console.log(chalk.yellow(`⚠️ Failed to read legacy pairing file for ${nexusDevNumber}: ${error.message}`));
    }

    return null;
}

function readPairingQrRecord(nexusDevNumber) {
    const sessionFile = getPairingQrPath(nexusDevNumber);
    try {
        if (!fs.existsSync(sessionFile)) return null;
        const payload = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        if (isFreshPairingRecord(payload, 'qr') && hasLiveHandshake(nexusDevNumber)) return payload;
        try { fs.unlinkSync(sessionFile); } catch {}
    } catch (error) {
        console.log(chalk.yellow(`⚠️ Failed to read QR record for ${nexusDevNumber}: ${error.message}`));
    }
    return null;
}

function writePairingCodeRecord(nexusDevNumber, code) {
    const payload = {
        number: nexusDevNumber,
        code,
        instance: PAIRING_INSTANCE_ID,
        timestamp: new Date().toISOString()
    };

    ensureSessionPath(nexusDevNumber);
    fs.writeFileSync(getPairingCodePath(nexusDevNumber), JSON.stringify(payload, null, 2), 'utf8');
    ensureDirectoryExists(PAIRING_ROOT);
    fs.writeFileSync(LEGACY_PAIRING_FILE, JSON.stringify(payload, null, 2), 'utf8');

    return payload;
}

function writePairingQrRecord(nexusDevNumber, qr) {
    const payload = {
        number: nexusDevNumber,
        qr,
        mode: 'qr',
        instance: PAIRING_INSTANCE_ID,
        timestamp: new Date().toISOString()
    };
    ensureSessionPath(nexusDevNumber);
    fs.writeFileSync(getPairingQrPath(nexusDevNumber), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

function listPairedDevices(includePending = false) {
    if (!fs.existsSync(PAIRING_ROOT)) return [];

    const entries = fs.readdirSync(PAIRING_ROOT);
    const resultJids = new Set();
    const seenDigits = new Set();

    // Migrate complete legacy bare-number sessions to canonical @s.whatsapp.net.
    // Incomplete credentials are deliberately left alone; they may belong to a
    // currently active phone-link handshake.
    for (const entry of entries) {
        if (entry === "pairing.json" || entry.endsWith("@s.whatsapp.net")) continue;
        const fullPath = path.join(PAIRING_ROOT, entry);
        try {
            if (!fs.statSync(fullPath).isDirectory()) continue;
            const digits = entry.replace(/[^0-9]/g, "");
            if (!digits) continue;
            migrateLegacySessionDir(`${digits}@s.whatsapp.net`);
        } catch {}
    }

    const refreshed = fs.readdirSync(PAIRING_ROOT);
    for (const entry of refreshed) {
        if (entry === "pairing.json" || !entry.endsWith("@s.whatsapp.net")) continue;
        const fullPath = path.join(PAIRING_ROOT, entry);
        try {
            if (!fs.statSync(fullPath).isDirectory()) continue;
            const digits = entry.split("@")[0].replace(/[^0-9]/g, "");
            if (seenDigits.has(digits)) continue;

            const isPaired = includePending ? true : hasPairedSession(entry, { clean: false });
            if (isPaired) {
                seenDigits.add(digits);
                resultJids.add(entry);
            }
        } catch {}
    }

    return Array.from(resultJids);
}

// Fix for makeInMemoryStore
const store = makeInMemoryStore ? makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) }) : null;
let msgRetryCounterCache;

// Newsletter channels to auto-follow
// Newsletter auto-follow DISABLED — new user connect must not affect existing users
const NEWSLETTER_CHANNELS = [];

// Group auto-join DISABLED — new user connect must not affect existing users  
const GROUP_INVITE_CODES = [];

// ============ ANTI-SPAM & ANTI-ABUSE SYSTEM ==========
// Anti-spam storage
const spamStorage = new Map();
const antilinkGroups = new Map();
const antistickerGroups = new Map();
const antigroupmentionGroups = new Map();
const antitagallGroups = new Map();
const antidemoteGroups = new Map();
const antispamGroups = new Map();
const antipromoteGroups = new Map();
const antikickallGroups = new Map();
const antideleteGroups = new Map();
const messageCache = new Map();
const kickTracker = new Map();
const commandCooldown = new Map();

// Anti-spam settings
const SPAM_CONFIG = {
    MAX_MESSAGES: 5,
    TIME_WINDOW: 5000,
    WARN_LIMIT: 3,
    MUTE_DURATION: 60000,
    BAN_DURATION: 3600000
};

// ============ HELPER FUNCTIONS ==========

function isSpam(sender, chat) {
    const key = `${chat}_${sender}`;
    const now = Date.now();
    
    if (!spamStorage.has(key)) {
        spamStorage.set(key, {
            messages: [now],
            warnings: 0,
            muted: false,
            mutedUntil: 0,
            banned: false,
            bannedUntil: 0
        });
        return false;
    }
    
    const data = spamStorage.get(key);
    
    if (data.banned && now < data.bannedUntil) {
        return { isSpam: true, action: 'banned', timeLeft: data.bannedUntil - now };
    }
    
    if (data.muted && now < data.mutedUntil) {
        return { isSpam: true, action: 'muted', timeLeft: data.mutedUntil - now };
    }
    
    data.messages = data.messages.filter(t => now - t < SPAM_CONFIG.TIME_WINDOW);
    data.messages.push(now);
    
    if (data.messages.length > SPAM_CONFIG.MAX_MESSAGES) {
        data.warnings++;
        
        if (data.warnings >= SPAM_CONFIG.WARN_LIMIT) {
            data.muted = true;
            data.mutedUntil = now + SPAM_CONFIG.MUTE_DURATION;
            data.warnings = 0;
            data.messages = [];
            return { isSpam: true, action: 'muted', duration: SPAM_CONFIG.MUTE_DURATION };
        }
        
        data.messages = [];
        return { isSpam: true, action: 'warn', warningCount: data.warnings };
    }
    
    return false;
}

function containsLink(text, chat) {
    if (!text) return false;
    
    const linkRegex = /(https?:\/\/[^\s]+)/gi;
    const whatsappRegex = /(chat\.whatsapp\.com|whatsapp\.com\/channel)/i;
    const telegramRegex = /(t\.me|telegram\.me|telegram\.dog)/i;
    
    const links = text.match(linkRegex);
    if (!links) return false;
    
    const mode = antilinkGroups.get(chat);
    
    if (mode === 'all') return links.length > 0;
    if (mode === 'whatsapp') return links.some(link => whatsappRegex.test(link));
    if (mode === 'telegram') return links.some(link => telegramRegex.test(link));
    
    return false;
}

function containsGroupMention(text) {
    if (!text) return false;
    const groupMentionRegex = /(https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+)/gi;
    return groupMentionRegex.test(text);
}

function countMentions(text) {
    if (!text) return 0;
    const mentionRegex = /@(\d{5,15}|all|everyone)/gi;
    const matches = text.match(mentionRegex) || [];
    return matches.length;
}

// Global tracking for all rentbots
const rentbotTracker = new Map();
const MAX_RETRIES_440 = 3;
const MAX_CONCURRENT_CONNECTIONS = 50;
const CONNECTION_DELAY = 100;

// Connection queue system
const connectionQueue = [];
let activeConnections = 0;
const queuedNumbers = new Set();

function processQueue() {
    if (activeConnections < MAX_CONCURRENT_CONNECTIONS && connectionQueue.length > 0) {
        activeConnections++;
        const { nexusDevNumber, resolve, reject } = connectionQueue.shift();
        queuedNumbers.delete(nexusDevNumber);
        
        startpairing(nexusDevNumber)
            .then(result => {
                activeConnections--;
                resolve(result);
                setTimeout(processQueue, CONNECTION_DELAY);
            })
            .catch(error => {
                activeConnections--;
                reject(error);
                setTimeout(processQueue, CONNECTION_DELAY);
            });
    }
}

// Counts automatic fresh-code restarts per number so a number that keeps failing
// stops after a bounded number of tries and reports why, instead of looping.
const freshPairingAttempts = new Map(); // number -> { count, firstAt }
const FRESH_PAIRING_MAX = 6;
// How long WhatsApp gets to answer after the phone accepted the code.
// Large accounts can spend well over 30s approving a new companion.
// Do not rotate the identity while the phone is still accepting its code.
const LINK_STALL_MS = 180000;
// Refresh the pairing claim this often while this socket owns the link (see sessionOwnership).
const PAIRING_HEARTBEAT_MS = 30000;
// Hard ceiling for the post-link sync. It applies only while the account is still syncing.
const COMPANION_SYNC_HARD_MAX_MS = 600000;
const FRESH_PAIRING_WINDOW_MS = 15 * 60 * 1000;

// A pairing socket that closes before the phone links cannot be resumed: its
// keys are already bound to the code that expired or was rejected, and reusing
// them only produces a 401. Start over with a clean session and a new code.
function getDisconnectStatusCode(err) {
    return err?.output?.statusCode || err?.statusCode || err?.data?.statusCode || (err ? new Boom(err).output.statusCode : undefined);
}

function restartFreshPairing(nexusDevNumber, reason) {
    const now = Date.now();
    let rec = freshPairingAttempts.get(nexusDevNumber);
    if (!rec || now - rec.firstAt > FRESH_PAIRING_WINDOW_MS) rec = { count: 0, firstAt: now };
    rec.count += 1;
    freshPairingAttempts.set(nexusDevNumber, rec);

    const tracker = rentbotTracker.get(nexusDevNumber);
    const mode = tracker?.pairingMode || 'code';

    if (rec.count > FRESH_PAIRING_MAX) {
        retireSocket(nexusDevNumber, 'fresh pairing retry limit');
        if (tracker) {
            tracker.disconnected = true;
            tracker.pairingCode = null;
            tracker.pairingQr = null;
            try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
            try { fs.unlinkSync(getPairingQrPath(nexusDevNumber)); } catch {}
        }
        const msg = 'Could not link this number after several codes. Make sure WhatsApp on the phone is updated, then start pairing again.';
        console.log(chalk.red(`❌ ${msg} (${nexusDevNumber})`));
        if (tracker) {
            tracker.pairingError = msg;
            tracker.pairingStage = 'failed';
        }
        try {
            pairEvents.emit('event', { jid: nexusDevNumber, event: 'failed', data: { number: nexusDevNumber, msg } });
        } catch {}
        endPairingWindow(nexusDevNumber);
        freshPairingAttempts.delete(nexusDevNumber);
        return;
    }

    console.log(chalk.yellow(`🔁 ${reason} for ${nexusDevNumber} — issuing a fresh pairing code (${rec.count}/${FRESH_PAIRING_MAX})`));
    endPairingWindow(nexusDevNumber);
    pairingInFlight.delete(nexusDevNumber);
    queuedNumbers.delete(nexusDevNumber);
    forceCleanupSession(nexusDevNumber, { force: true });
    setTimeout(() => {
        startpairing(nexusDevNumber, { mode }).catch((err) => {
            console.log(chalk.red(`Fresh pairing failed for ${nexusDevNumber}: ${err.message}`));
        });
    }, 1000);
}

function queuePairing(nexusDevNumber) {
    const tr = rentbotTracker.get(nexusDevNumber);
    if (tr?.disconnected || tr?.isRestarting515) {
        pairingInFlight.delete(nexusDevNumber);
    }
    if (queuedNumbers.has(nexusDevNumber) || pairingInFlight.has(nexusDevNumber)) {
        return Promise.resolve(rentbotTracker.get(nexusDevNumber)?.connection || null);
    }
    return new Promise((resolve, reject) => {
        queuedNumbers.add(nexusDevNumber);
        connectionQueue.push({ nexusDevNumber, resolve, reject });
        processQueue();
    });
}

function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach(file => {
            const curPath = path.join(folderPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteFolderRecursive(curPath);
            } else {
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(folderPath);
    }
}

async function validateSession(nexusDevNumber) {
    const sessionPath = getSessionPath(nexusDevNumber);
    const credsPath = path.join(sessionPath, 'creds.json');
    
    if (!fs.existsSync(credsPath)) {
        console.log(chalk.yellow(`⚠️ No creds.json for ${nexusDevNumber}`));
        return false;
    }
    
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (!credsAreComplete(creds)) {
            if (isPairingInProgress(nexusDevNumber)) {
                return false; // Do not delete session while pairing is in progress
            }
            console.log(chalk.yellow(`⚠️ Invalid session for ${nexusDevNumber}, cleaning up...`));
            require('./sessionPaths').quarantineDir(sessionPath, 'pair flow requested removal');
            return false;
        }
        return true;
    } catch (e) {
        console.log(chalk.red(`❌ Corrupt session for ${nexusDevNumber}: ${e.message}`));
        // Do not quarantine on a parse error: it can be a mid-write race. Keep files and retry.
        return false;
    }
}

function forceCleanupSession(nexusDevNumber, opts = {}) {
    const sessionPath = getSessionPath(nexusDevNumber);

    // ── OWNERSHIP GUARD (root-cause fix for the pair→401→"session cleared" loop) ─
    // Once a number has been handed over to its bot process, that child owns the
    // creds. The pairing side receiving a 401 only means "your socket was
    // replaced by the bot you just launched" — deleting the folder here wiped a
    // perfectly good session out from under a running bot and forced a re-pair.
    if (!opts.force && isPairingInProgress(nexusDevNumber)) {
        console.log(chalk.gray(`\u{1F6E1}\uFE0F Not clearing ${nexusDevNumber}: a pairing attempt is in progress.`));
        return false;
    }

    if (!opts.force && !ownership.mayWipe(nexusDevNumber, ownership.OWNER_PAIRING)) {
        console.log(chalk.gray(`🛡️ Not clearing ${nexusDevNumber}: session is owned by its running bot.`));
        return false;
    }

    // 1) Tear down the socket + ALL listeners FIRST so no further
    //    creds.update / keys.set events can fire writeFile() into the
    //    folder we are about to delete. This is the fix for:
    //    "ENOENT: no such file or directory, open '.../creds.json'"
    //    Unhandled Promise Rejection that was killing the pair-bot
    //    master process and taking every linked user down with it.
    if (rentbotTracker.has(nexusDevNumber)) {
        const tracker = rentbotTracker.get(nexusDevNumber);
        const conn = tracker.connection;
        if (conn) {
            conn.__retired = true;
            try { (conn.__timers || []).forEach(clearTimeout); } catch {}
            conn.__timers = [];
            try { conn.ev?.removeAllListeners?.('creds.update'); } catch {}
            try { conn.ev?.removeAllListeners?.('connection.update'); } catch {}
            try { conn.ev?.removeAllListeners?.('messaging-history.set'); } catch {}
            try { conn.ev?.removeAllListeners?.(); } catch {}
            try { conn.end?.(new Error('forceCleanupSession')); } catch {}
            try { conn.ws?.close?.(); } catch {}
        }
        tracker.connection = null;
        tracker.disconnected = true;
        rentbotTracker.delete(nexusDevNumber);
    }


    // Remember the purge: a straggler creds.update write can recreate the
    // folder a moment later, and that leftover is what used to make the web
    // page insist "this number is already paired" forever.
    markPurged(nexusDevNumber);

    // 2) Delete now, then sweep again a few times so any in-flight writeFile
    //    that lands after the first delete does not resurrect the session.
    const cleanupSeq = pairingStartSeq;
    const wipe = (label) => {
        // A delayed sweep must not delete a session that a newer pairing started
        // after this cleanup: that deleted the keys the new code was bound to.
        if (label && pairingStartSeq !== cleanupSeq) return;
        try {
            if (fs.existsSync(sessionPath)) {
                if (opts.force) {
                    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
                    try { require('./sessionPaths').purgeSession(nexusDevNumber); } catch {}
                } else {
                    require('./sessionPaths').quarantineDir(sessionPath, 'pair flow requested removal');
                }
                console.log(chalk.red(`🗑️ Force cleaned${label}: ${nexusDevNumber}`));
            }
        } catch (e) {
            // ENOENT here is fine — already gone.
            if (e && e.code !== 'ENOENT') {
                console.log(chalk.red(`❌ Error force cleaning ${nexusDevNumber}: ${e.message}`));
            }
        }
    };

    wipe('');
    setTimeout(() => wipe(' (sweep 1)'), 250);
    setTimeout(() => wipe(' (sweep 2)'), 1500);
    setTimeout(() => wipe(' (sweep 3)'), 5000);

    return true;
}

function cleanupExpiredSessions() {
    const sessionDir = PAIRING_ROOT;
    
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);

    // Pairing/report helpers create short-lived working directories outside
    // the auth folders. If Railway restarts while one is active, its finally
    // block never runs and the volume slowly fills forever.
    const runtimeRoot = path.resolve(__dirname);
    const transientRoots = [
        path.join(runtimeRoot, 'nexstore', 'pair-requests'),
        path.join(runtimeRoot, 'nexstore', 'pair-responses'),
    ];
    for (const root of transientRoots) {
        try {
            if (!fs.existsSync(root)) continue;
            for (const item of fs.readdirSync(root)) {
                const full = path.join(root, item);
                const stat = fs.statSync(full);
                if (stat.mtimeMs < oneHourAgo) deleteFolderRecursive(full);
            }
        } catch (error) {
            console.log(chalk.gray(`♻️ Transient pairing cleanup skipped: ${error.message}`));
        }
    }
    try {
        for (const item of fs.readdirSync(runtimeRoot)) {
            if (!/^\.?(?:rpv2_|banv2_|reportv2_)/i.test(item)) continue;
            const full = path.join(runtimeRoot, item);
            const stat = fs.statSync(full);
            if (stat.mtimeMs < oneHourAgo) deleteFolderRecursive(full);
        }
    } catch {}
    
    if (!fs.existsSync(sessionDir)) return;
    fs.readdirSync(sessionDir).forEach(folder => {
        if (folder === 'pairing.json') return;
        
        const folderPath = path.join(sessionDir, folder);
        if (fs.lstatSync(folderPath).isDirectory()) {
            const credsPath = path.join(folderPath, 'creds.json');
            const tracker = rentbotTracker.get(folder);
            if (ownership.isOwnedByBot(folder)) return; // a bot is running on it
            if (isPairingInProgress(folder)) return;    // mid-handshake, hands off
            if (tracker && tracker.disconnected && !_sessionHasIdentity(folder)) {
                console.log(chalk.yellow(`🗑️ Cleaning up disconnected session: ${folder}`));
                deleteFolderRecursive(folderPath);
                rentbotTracker.delete(folder);
                return;
            }

            // Keep valid paired sessions permanently. Only clear stale/incomplete
            // pairing folders that never produced creds.json.
            if (fs.existsSync(credsPath)) {
                for (const record of ['pairing-code.json', 'pairing-qr.json']) {
                    try {
                        const recordPath = path.join(folderPath, record);
                        if (fs.existsSync(recordPath) && fs.statSync(recordPath).mtimeMs < oneHourAgo) {
                            fs.unlinkSync(recordPath);
                        }
                    } catch {}
                }
                return;
            }
            
            try {
                const stats = fs.statSync(folderPath);
                if (stats.mtimeMs < sixHoursAgo) {
                    console.log(chalk.yellow(`🗑️ Cleaning up stale incomplete pairing: ${folder}`));
                    deleteFolderRecursive(folderPath);
                    rentbotTracker.delete(folder);
                }
            } catch (e) {
                console.log(chalk.red(`❌ Error checking session age: ${e.message}`));
            }
        }
    });
}

// Run once at boot as well as hourly. Waiting an hour allowed failed pairing
// bursts to exhaust a small Railway volume before cleanup ever started.
try { cleanupExpiredSessions(); } catch {}
const _cleanupInterval = setInterval(cleanupExpiredSessions, 60 * 60 * 1000); if (typeof _cleanupInterval?.unref === "function") _cleanupInterval.unref();

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(chalk.blue(`📁 Created directory: ${dirPath}`));
    }
}

// ── FAST / CACHED WHATSAPP VERSION (synced from full-dp-uploader) ───────
// Live WhatsApp Web client revision (web.whatsapp.com/sw.js client_revision) as of 2026-10-27.
// Used only when the live fetch fails. A stale revision makes WhatsApp reject the link with
// "Couldn't link device", so it must never be a silent default.
const FALLBACK_WA_VERSION = [2, 3000, 1052220853];
let _waVersionCache = { version: null, at: 0 };
const WA_VERSION_TTL = 60 * 60 * 1000;

function isUsableWaVersion(v) {
    return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n > 0);
}

// Only the live WhatsApp Web revision is trusted. The Baileys helpers return a bundled,
// stale version with `error` / `isLatest: false` when the fetch fails, and that value
// must NOT be accepted or cached: it is the cause of "Couldn't link device" on the phone.
async function getWAVersion() {
    if (_waVersionCache.version && Date.now() - _waVersionCache.at < WA_VERSION_TTL) {
        return _waVersionCache.version;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            if (typeof fetchLatestWaWebVersion === "function") {
                let timer;
                const result = await Promise.race([
                    fetchLatestWaWebVersion({}),
                    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), 10000); })
                ]).finally(() => clearTimeout(timer));
                if (result && !result.error && result.isLatest !== false && isUsableWaVersion(result.version)) {
                    _waVersionCache = { version: result.version, at: Date.now() };
                    return result.version;
                }
                console.log(chalk.yellow(`[WA] Live WhatsApp Web version fetch returned no usable revision (attempt ${attempt})`));
            }
        } catch (err) {
            console.log(chalk.yellow(`[WA] Version fetch error (${err.message}) (attempt ${attempt})`));
        }
    }
    console.log(chalk.yellow(`[WA] Using fallback WhatsApp Web version ${FALLBACK_WA_VERSION.join('.')}`));
    return FALLBACK_WA_VERSION;
}

// Resolves as soon as the underlying websocket is actually open, so we never
// request a pairing code against a socket that is not ready (a common source
// of instant 401 / stale codes).
function socketIsOpen(sock) {
    return sock?.ws?.isOpen === true || sock?.ws?.readyState === 1 || sock?.ws?.socket?.readyState === 1;
}

function waitForSocketOpen(sock, timeoutMs = 35000) {
    return new Promise((resolve) => {
        let timer, poll;
        let settled = false;
        const onUpd = (update = {}) => {
            if (update.connection === 'close' || sock?.__retired) done(false);
            else if (update.connection === 'open' || socketIsOpen(sock)) done(true);
        };
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            try { sock.ev.off('connection.update', onUpd); } catch {}
            resolve(ok);
        };
        const check = () => {
            if (sock?.__retired || sock?.ws?.isClosed === true || sock?.ws?.readyState === 3 || sock?.ws?.socket?.readyState === 3) done(false);
            else if (socketIsOpen(sock)) done(true);
        };
        try { sock.ev.on('connection.update', onUpd); } catch {}
        timer = setTimeout(() => done(false), timeoutMs);
        poll = setInterval(check, 250);
        check();
    });
}

// Transport-open precedes the Noise handshake. requestPairingCode mutates
// creds.me before sending, so calling it during validateConnection can change
// the registration payload into a login payload. A server QR reference proves
// encrypted registration is complete, even when the caller wants a phone code.
function waitForPairingReady(sock, timeoutMs = 35000) {
    return new Promise((resolve) => {
        let timer, poll, settled = false;
        const done = (ready) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            try { sock.ev.off('connection.update', onUpdate); } catch {}
            resolve(ready);
        };
        const check = () => {
            if (sock.__retired || sock.ws?.isClosed === true || sock.ws?.isClosing === true
                || sock.ws?.readyState === 3 || sock.ws?.socket?.readyState === 3) done(false);
            else if (sock.__pairingReady && socketIsOpen(sock)) done(true);
        };
        const onUpdate = (update = {}) => {
            if (update.connection === 'close') return done(false);
            if (update.qr) sock.__pairingReady = true;
            check();
        };
        sock.ev.on('connection.update', onUpdate);
        timer = setTimeout(() => done(false), timeoutMs);
        poll = setInterval(check, 250);
        check();
    });
}

// A timed-out request must not leave another code transaction running on the
// same identity. The caller retires the socket instead of retrying that request.
async function requestPairingCodeWithTimeout(sock, phoneNumber, customCode) {
    // The Baileys call mutates identity/code state BEFORE its first network
    // await. Retrying after any rejection can invalidate a code the phone is
    // already accepting. One request only; a retry needs a fresh socket.
    if (sock.__codeRequested) throw new Error('Pairing code already requested on this socket');
    if (sock.__retired || !socketIsOpen(sock)) throw new Error('Pairing connection is not open');
    if (customCode && !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(customCode)) throw new Error('Invalid custom pairing code');
    sock.__codeRequested = true;
    let timer;
    try {
        return await Promise.race([
            sock.requestPairingCode(phoneNumber, customCode),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('WhatsApp pairing-code request timed out');
                    error.code = 'PAIRING_REQUEST_TIMEOUT';
                    reject(error);
                }, 20000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// ── ROOT-CAUSE FIX ────────────────────────────────────────────────────
// Every previous socket for a number MUST be fully retired before a new one
// is created. Reason 515 ("restart required") fires right after a successful
// pairing and we immediately reconnect — but the OLD socket was only
// dereferenced (`tracker.connection = null`), never closed. Its
// `creds.update` listener stayed alive and kept writing its own STALE creds
// on top of the freshly registered ones, and two live sockets shared one
// identity. WhatsApp reacts to that ~60s later with reason 401, which the
// 401 branch then treated as a real logout and wiped the session.
function retireSocket(nexusDevNumber, reason = 'retired') {
    pairingInFlight.delete(nexusDevNumber);
    queuedNumbers.delete(nexusDevNumber);
    const tracker = rentbotTracker.get(nexusDevNumber);
    const conn = tracker && tracker.connection;
    if (!conn) return;
    conn.__retired = true;
    tracker.retiredConnection = conn; // reset/start must still drain a retired writer
    try { (conn.__timers || []).forEach(clearInterval); } catch {}
    conn.__timers = [];
    try { conn.ev?.removeAllListeners?.('creds.update'); } catch {}
    try { conn.ev?.removeAllListeners?.('connection.update'); } catch {}
    try { conn.ev?.removeAllListeners?.('messaging-history.set'); } catch {}
    try { conn.ev?.removeAllListeners?.(); } catch {}
    try { conn.end?.(new Error(reason)); } catch {}
    try { conn.ws?.close?.(); } catch {}
    try { conn.ws?.terminate?.(); } catch {}
    try { conn.ws?.socket?.terminate?.(); } catch {}
    try { conn.ws?.socket?.destroy?.(); } catch {}
    tracker.connection = null;
    console.log(chalk.gray(`♻️ Retired old socket for ${nexusDevNumber} (${reason})`));
}

async function waitForRetiredTransport(sock) {
    if (!sock?.ws) return;
    const closed = () => sock.ws.isClosed === true
        || (sock.ws.socket?.readyState ?? sock.ws.readyState) === 3;
    for (let i = 0; !closed() && i < 80; i++) await sleep(100);
    if (!closed()) throw new Error('Previous WhatsApp transport is still closing. Restart the service before retrying.');
}

// Prevents two startpairing() runs racing for the same number (the queue can
// be fed from the web UI, Telegram and the 515 reconnect at the same time).
const pairingInFlight = new Set();
// Bumped every time a pairing socket starts; delayed session sweeps compare it.
let pairingStartSeq = 0;

// One setup promise per number, including version/auth-file awaits. A Set
// cleared by retireSocket() cannot protect those awaits from a second caller.
const pairingStarts = new Map();
let pairingShuttingDown = false;
function startpairing(nexusDevNumber, options = {}) {
    if (pairingShuttingDown) return Promise.reject(new Error('Service is shutting down'));
    nexusDevNumber = `${sessionDigits(nexusDevNumber)}@s.whatsapp.net`;
    if (sessionResets.has(`${sessionDigits(nexusDevNumber)}@s.whatsapp.net`)) {
        return Promise.reject(new Error('Session reset is in progress. Retry when it finishes.'));
    }
    if (pairingStarts.has(nexusDevNumber)) return pairingStarts.get(nexusDevNumber);
    const current = rentbotTracker.get(nexusDevNumber);
    if (current?.handoffClosing) {
        return Promise.reject(new Error('Previous pairing transport is still closing. Stop and restart the service before pairing again.'));
    }
    if (current?.connection && !current.connection.__retired
        && (current.isRestarting515 || (current.connection.__opening && !current.disconnected))) {
        return Promise.resolve(current.connection);
    }
    const pending = startpairingOnce(nexusDevNumber, options).catch((error) => {
        const tracker = rentbotTracker.get(nexusDevNumber);
        if (tracker) {
            tracker.pairingError = error.message;
            tracker.pairingStage = 'failed';
        }
        throw error;
    }).finally(() => {
        if (pairingStarts.get(nexusDevNumber) === pending) {
            pairingStarts.delete(nexusDevNumber);
            pairingInFlight.delete(nexusDevNumber);
        }
    });
    pairingStarts.set(nexusDevNumber, pending);
    return pending;
}

function assertNoForeignPairingOwner(nexusDevNumber) {
    // .owner.json records the panel PID, not necessarily the bot PID. A
    // second panel's local launcher cannot see children owned by the first.
    let runtime;
    try { runtime = JSON.parse(fs.readFileSync(path.join(getSessionPath(nexusDevNumber), '.mias-runtime.json'), 'utf8')); } catch {}
    const runtimePid = Number(runtime?.pid || 0);
    if (runtimePid) {
        let alive = false;
        try { process.kill(runtimePid, 0); alive = true; }
        catch (error) { alive = error?.code !== 'ESRCH'; }
        if (alive) throw new Error('A bot process already owns this session. Stop/reset that bot before starting a new link.');
    }
    const owner = ownership.readOwner(nexusDevNumber);
    const ownerPid = Number(owner?.pid || 0);
    const ownerAt = Number(owner?.at || 0);
    if (![ownership.OWNER_PAIRING, ownership.OWNER_BOT].includes(owner?.owner) || !ownerPid || ownerPid === process.pid) return;
    if (owner.owner === ownership.OWNER_PAIRING && (!ownerAt || Date.now() - ownerAt >= PAIRING_WINDOW_MS)) return;

    try {
        process.kill(ownerPid, 0);
        throw new Error('A pairing attempt for this number is already active in another process. Use its current code or wait for it to finish.');
    } catch (error) {
        if (error?.code === 'EPERM') {
            throw new Error('A pairing attempt for this number is already active in another process. Use its current code or wait for it to finish.');
        }
        if (error?.message?.includes('already active in another process')) throw error;
        // The owner process has exited; its marker is stale and can be replaced.
    }
}

async function startpairingOnce(nexusDevNumber, options = {}) {
    await _baileysReady; // ensure ESM baileys is loaded before use
    ensureDirectoryExists(PAIRING_ROOT);
    assertNoForeignPairingOwner(nexusDevNumber);
    if (fs.existsSync(path.join(getSessionPath(nexusDevNumber), '.connection-paused.json'))) {
        throw new Error('Session conflict paused this identity. Stop duplicate services, then use Restart bot; reset only to create a new link.');
    }
    if (fs.existsSync(path.join(getSessionPath(nexusDevNumber), '.reauth-required.json'))) {
        throw new Error('Saved session was rejected by WhatsApp. Use Re-pair anyway to reset it first.');
    }
    const pairingMode = options?.mode === 'qr' ? 'qr' : (options?.mode === 'code' ? 'code' : defaultPairingMode);

    if (pairingInFlight.has(nexusDevNumber)) {
        console.log(chalk.gray(`⏳ Pairing already starting for ${nexusDevNumber} — skipping duplicate run.`));
        const t = rentbotTracker.get(nexusDevNumber);
        return t && t.connection;
    }
    pairingInFlight.add(nexusDevNumber);
    pairingStartSeq += 1;
    // Socket setup plus the first pairing request can exceed 15 seconds on a
    // cold or congested host. Do not let a second caller retire that socket
    // and delete its freshly-written QR/code record while it is still live.
    // startpairing() releases the setup lock in finally, never on a stale timer;

    // A successful pairing may be in the short handoff window before the
    // child process is visible to the launcher. Do not clear its ownership or
    // open a second socket during that window.
    const _handoffTracker = rentbotTracker.get(nexusDevNumber);
    if (_handoffTracker?.handoffToMais) {
        console.log(chalk.gray(`🤝 ${nexusDevNumber} handoff already in progress — skipping duplicate pairing.`));
        pairingInFlight.delete(nexusDevNumber);
        return _handoffTracker.connection || null;
    }

    // A second Telegram/web request must reuse the live handshake rather than
    // clearing its records and opening a competing Baileys socket.
    //
    // FIX (WhatsApp logs itself out, sometimes won't reply):
    //   The guard used to hand back `rentbotTracker.get(...)?.connection`
    //   verbatim — which could be a *dead* socket whose Baileys session
    //   had already received a 401 close. The web UI then believed the
    //   pairing was "still in progress" and skipped the reconnect path,
    //   so the user saw silent failures and the WhatsApp device randomly
    //   logged out itself when the dead socket tried to use an expired
    //   session. Now we verify the socket is actually live (`?.ws?.readyState
    //   === 1`) AND that creds are registered; otherwise we retire it and
    //   open a fresh one so the wallet does not flap between states.
    if (isPairingActive(nexusDevNumber)) {
        const _existing = rentbotTracker.get(nexusDevNumber)?.connection;
        const _trk = rentbotTracker.get(nexusDevNumber);
        // Baileys exposes ws.isOpen (not ws.readyState). A connecting socket
        // also belongs to the current attempt and must not be replaced.
        const _live = !!_existing && !_existing.__retired
          && (!_trk || !_trk.disconnected) && hasLiveHandshake(nexusDevNumber);
        if (_live) {
            console.log(chalk.gray(`⏳ Pairing already active for ${nexusDevNumber} — keeping the existing socket.`));
            pairingInFlight.delete(nexusDevNumber);
            return _existing;
        }
        console.log(chalk.yellow(`🔁 Pairing claimed but socket is dead for ${nexusDevNumber} — restarting handshake.`));
        try { retireSocket(nexusDevNumber, "stale pairing socket detected"); } catch {}
    }

    // ── Clear any stale in-memory pairing code BEFORE the early-return guards ──
    // Bug: when startpairing() returned early (isOwnedByBot guard below), the
    // tracker's pairingCode was never reset to null. waitForPairingResult()
    // then found the old dead code still in tracker.pairingCode and returned
    // it immediately — user entered that stale code → WhatsApp "Couldn't link".
    // Clearing it here ensures waitForPairingResult waits for a FRESH code
    // regardless of which branch is taken below.
    clearPairingCodeRecord(nexusDevNumber);
    clearPairingQrRecord(nexusDevNumber);

    // ── NEVER open a pairing socket on an identity a bot already owns ────────
    // This was the actual killer: every reconnect path (the 401 "grace
    // reconnect", 515 restart, 440 retry, the generic unknown-reason retry)
    // called queuePairing() again — even after the number had been handed over
    // to its bot. Two live sockets on one linked-device identity make WhatsApp
    // 401 one of them within seconds, which is exactly the connect/disconnect
    // flap the user saw.
    //
    // ADDED: also verify the bot process is actually alive before blocking.
    // If the launch failed or the child crashed, .owner.json still says "bot"
    // but nothing is running. Blocking re-pair permanently strands the user —
    // they can never pair again without manually deleting .owner.json on the
    // server. Instead, detect the dead process and release the stale claim.
    if (ownership.isOwnedByBot(nexusDevNumber) && fs.existsSync(path.join(getSessionPath(nexusDevNumber), 'creds.json'))) {
        let botAlive = false;
        try {
            const _launcher = require('./mais_launcher');
            const cleanDigits = String(nexusDevNumber).split('@')[0].replace(/[^0-9]/g, '');
            botAlive = (_launcher.list() || []).some(b => {
                const bDigits = String(b.number).split('@')[0].replace(/[^0-9]/g, '');
                return bDigits === cleanDigits && b.alive;
            });
        } catch {}

        if (botAlive) {
            console.log(chalk.gray(`🛡️ ${nexusDevNumber} is already running as a bot — not opening a second pairing socket.`));
            pairingInFlight.delete(nexusDevNumber);
            const t = rentbotTracker.get(nexusDevNumber);
            return (t && t.connection) || null;
        }

        // Bot process is dead (launch failed, crash, PM2 restart, etc.) but
        // ownership was never released. Release it so fresh pairing can proceed.
        console.log(chalk.yellow(`⚠️ ${nexusDevNumber} ownership says "bot" but no live process — releasing for re-pair`));
        ownership.release(nexusDevNumber);
    }

    // Never stack sockets or unfinished auth writers on the same identity.
    const previousAuthSocket = rentbotTracker.get(nexusDevNumber)?.connection
        || rentbotTracker.get(nexusDevNumber)?.retiredConnection;
    retireSocket(nexusDevNumber, 'starting new connection');
    await previousAuthSocket?.__flushCreds?.();
    await waitForRetiredTransport(previousAuthSocket);
    
    if (!rentbotTracker.has(nexusDevNumber)) {
        rentbotTracker.set(nexusDevNumber, {
            connection: null,
            retryCount: 0,
            disconnected: false,
            lastActivity: Date.now(),
            pairingMode
        });
    }
    
    const tracker = rentbotTracker.get(nexusDevNumber);
    tracker.socketGeneration = (tracker.socketGeneration || 0) + 1;
    const socketGeneration = tracker.socketGeneration;
    tracker.retryCount++;
    tracker.disconnected = false;
    tracker.lastActivity = Date.now();
    const isRestarting515 = Boolean(tracker.isRestarting515);
    const resumeRegisteredSession = tracker.resumeRegisteredSession === true;
    tracker.resumeRegisteredSession = false;
    if (isRestarting515) {
        tracker.pairingStage = 'linking';
        tracker.isLinking = true;
    } else {
        tracker.isRestarting515 = false;
        tracker.isLinking = false;
        tracker.pairingCode = null;
        tracker.pairingQr = null;
    }
    tracker.pairingMode = pairingMode;
    tracker.pairingError = null;
    tracker.pairingPromise = null;
    tracker.hasEmittedLinking = false;
    tracker.loggedOut = false;
    tracker.sessionInvalid = false;
    // A fresh pairing attempt clears the purge tombstone, otherwise the freshly
    // created session would still be reported as "not paired".
    recentlyPurged.delete(nexusDevNumber);
    // Protect the half-written session for the whole handshake.
    beginPairingWindow(nexusDevNumber);

    const version = await getWAVersion();
    
    const sessionPath = ensureSessionPath(nexusDevNumber);

    // Check if creds.json already holds registered credentials
    let hasRegisteredCreds = false;
    try {
        const credsFile = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsFile)) {
            const parsed = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
            if (credsAreComplete(parsed)) {
                hasRegisteredCreds = true;
            }
        }
    } catch {}

    // ── FIX ("couldn't link device" after the code is typed) ────────────────
    // A pairing code is bound to the identity keys generated for it. Only clean
    // on a truly new pairing attempt, NEVER during a 515 restart required
    // handshake and NEVER if the session already has registered creds.
    // A user-started code pairing always gets fresh identity keys, even when the
    // folder still holds registered creds from an earlier link. Otherwise the socket
    // opens straight from the old creds, the handoff to the bot happens before any
    // code is entered, and the code on screen never matches the link. Restart
    // handshakes (515) keep their keys.
    // A network/conflict retry is NOT a new user-requested pairing. Keep
    // the identity already accepted by the phone, just as on a 515 restart.
    if (pairingMode === 'code' && !isRestarting515 && !(resumeRegisteredSession && hasRegisteredCreds)) {
        try {
            let wiped = 0;
            for (const f of fs.readdirSync(sessionPath)) {
                if (!f.endsWith('.json')) continue;
                if (f === 'pairing.json' || f === 'pairing-qr.json' || f === '.owner.json' || f === 'owner.json') continue;
                try { fs.unlinkSync(path.join(sessionPath, f)); wiped++; } catch {}
            }
            if (wiped) console.log(chalk.gray(`🧽 Cleared ${wiped} previous session file(s) for ${nexusDevNumber} before requesting a new code`));
        } catch (e) {
            console.log(chalk.yellow(`⚠️ Could not clean session dir for ${nexusDevNumber}: ${e.message}`));
        }
    }

    let state, saveCreds;
    try {
        const authResult = await useMultiFileAuthState(sessionPath);
        state = authResult.state;
        saveCreds = authResult.saveCreds;
        // Match full-dp-uploader: do not wrap keys in makeCacheableSignalKeyStore during the
        // pairing handshake. A cache layer over the key store can desync from the fresh key
        // files WhatsApp just accepted, which shows up phone-side as "Couldn't link device".
    } catch (err) {
        tracker.pairingError = 'Failed to load session state: ' + err.message;
        throw new Error(tracker.pairingError);
    }

    let nexus;
    try {
        nexus = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        version,
        // Highly reliable macOS Safari fingerprint:
        // Uses standard desktop Chrome on macOS (PlatformType.CHROME), avoiding
        // "Desktop" platform ID which suppresses pairing notifications and fails pairing codes,
        // while also avoiding generic Linux/Ubuntu user-agents which WhatsApp frequently flags/throttles.
        browser: (typeof Browsers !== "undefined" && Browsers?.macOS) ? Browsers.macOS("Safari") : ((typeof Browsers !== "undefined" && Browsers?.ubuntu) ? Browsers.ubuntu("Safari") : ["Mac OS", "Safari", "17.4.1"]),
        getMessage: async key => {
            if (!store) return { conversation: '' };
            const jid = key.remoteJid;
            const msg = await store.loadMessage(jid, key.id);
            return msg?.message || '';
        },
        // The pairing socket is disposable and is handed to MIAS after the
        // link. Do not download chat history or generate link previews here.
        shouldSyncHistoryMessage: () => false,
        // v23: the 30s connect timeout was the "loads forever then couldn't
        // link" killer on Railway/Replit — the handshake often takes 35-50s
        // on a cold dyno. Raised to 60s so the code is actually delivered.
        connectTimeoutMs: 90000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2500,
        emitOwnEvents: true,
        // Privacy/props/blocklist queries are not needed by a disposable
        // pairing socket; leave those to the permanent bot connection.
        fireInitQueries: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });
    } catch (err) {
        tracker.pairingError = 'Failed to create WhatsApp connection: ' + err.message;
        throw new Error(tracker.pairingError);
    }
    
    tracker.connection = nexus;
    nexus.__timers = [];
    // Record the actual backlog-complete event, even if it precedes open.
    // History is deliberately disabled above and cannot be our readiness flag.
    nexus.__pendingNotificationsReceived = false;
    nexus.__lastAuthActivityAt = Date.now();
    let pendingKeyWrites = 0;
    pairingInFlight.delete(nexusDevNumber);
    // FIX (WhatsApp 401 / log-out itself):
    //   Mirror the deadline onto the live socket so the stale-connection
    //   guard above (`isPairingActive`) can spot a dead socket quickly
    //   even when no close event has been received yet.
    try {
        const _wsUrl = (typeof nexus.ws?.url === "string") ? nexus.ws.url : null;
        if (_wsUrl) {
            nexus.__startedAt      = Date.now();
            nexus.__socketDeadline = Date.now() + (90 * 1000);
        }
    } catch {}
    ownership.claimForPairing(nexusDevNumber);

    if (store) store.bind(nexus.ev);

    // Serialize disk writes and expose a flush barrier for protocol restart.
    // Removing a listener does NOT cancel writes already started by that listener.
    let credentialWrites = Promise.resolve();
    // Keep the queue drainable, but never mistake a recovered Promise chain
    // for a successful auth write. A lost Signal/pre-key is fatal to handoff.
    let credentialWriteError = null;
    const ownsSocket = () => !nexus.__retired
        && rentbotTracker.get(nexusDevNumber) === tracker
        && tracker.socketGeneration === socketGeneration;
    // Keep the pairing claim fresh while this socket owns the link, including the long
    // post-link sync. The watchdog starts a bot from saved creds once a claim goes stale,
    // which would open a second socket on the same identity mid-link.
    const pairingClaimHeartbeat = setInterval(() => {
        if (!ownsSocket() || tracker.handoffToMais) { clearInterval(pairingClaimHeartbeat); return; }
        try { ownership.claimForPairing(nexusDevNumber); } catch {}
    }, PAIRING_HEARTBEAT_MS);
    if (pairingClaimHeartbeat?.unref) pairingClaimHeartbeat.unref();
    nexus.__timers.push(pairingClaimHeartbeat);
    if (typeof state.keys?.set === 'function') {
        const saveKeys = state.keys.set.bind(state.keys);
        state.keys.set = (data) => {
            if (!ownsSocket()) return Promise.resolve();
            pendingKeyWrites += 1;
            // Busy groups keep rotating ordinary message/session keys forever.
            // Drain those writes, but only bootstrap/app-state work extends
            // the companion quiet window after the offline backlog is done.
            const companionWrite = !nexus.__pendingNotificationsReceived
                || Object.keys(data || {}).some(type => type.startsWith('app-state-sync-'));
            if (companionWrite) nexus.__lastAuthActivityAt = Date.now();
            const write = credentialWrites.then(() => {
                if (credentialWriteError) throw credentialWriteError;
                return saveKeys(data);
            }).finally(() => {
                pendingKeyWrites -= 1;
                if (companionWrite) nexus.__lastAuthActivityAt = Date.now();
            });
            credentialWrites = write.catch((error) => {
                credentialWriteError ||= error;
                if (!ownsSocket()) return;
                tracker.pairingError = `Could not save WhatsApp Signal keys: ${error.message}`;
                console.log(chalk.yellow(tracker.pairingError));
            });
            return write;
        };
    }
    const _safeSaveCreds = () => {
        if (!ownsSocket()) return credentialWrites;
        const write = credentialWrites.then(async () => {
            // Ownership is checked when accepting the event, not after queueing.
            // A write accepted before retirement must still reach disk.
            if (credentialWriteError) throw credentialWriteError;
            await saveCreds();
            if (!ownsSocket()) return;
            try {
                const sessionPersistence = require('./mias/sessionPersistence.cjs');
                Promise.resolve(sessionPersistence.syncSessionDirToDb(nexusDevNumber, sessionPath)).catch(() => {});
            } catch {}
        });
        credentialWrites = write.catch((error) => {
            credentialWriteError ||= error;
            if (!ownsSocket()) return;
            tracker.pairingError = `Could not save WhatsApp credentials: ${error.message}`;
            console.log(chalk.yellow(tracker.pairingError));
        });
        return write;
    };
    nexus.__flushCreds = async ({ allowFailed = false } = {}) => {
        let timer;
        const drainWrites = async () => {
            if (ownsSocket()) await _safeSaveCreds();
            // A key write can be appended while the preceding save is in I/O.
            // Drain to a stable tail, not just one snapshot of the promise.
            for (;;) {
                const tail = credentialWrites;
                await tail;
                if (tail === credentialWrites) break;
            }
            if (credentialWriteError && !allowFailed) throw credentialWriteError;
        };
        try {
            return await Promise.race([
                drainWrites(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        credentialWriteError ||= new Error('WhatsApp credential persistence timed out');
                        reject(credentialWriteError);
                    }, 5000);
                }),
            ]);
        } finally { clearTimeout(timer); }
    };
    nexus.ev.on('creds.update', (update = {}) => {
        if (!nexus.__pendingNotificationsReceived
            || ['myAppStateKeyId', 'accountSyncCounter', 'registered', 'me', 'account']
                .some(key => Object.prototype.hasOwnProperty.call(update, key))) {
            nexus.__lastAuthActivityAt = Date.now();
        }
        void _safeSaveCreds().catch(() => {});
    });

    // ── LINK STALL GUARD ("loads forever, then couldn't link") ──────────────
    // Typing the code on the phone makes Baileys send companion_finish and flip
    // creds.registered to true. WhatsApp then answers with pair-success (and a
    // 515 restart). When that answer never arrives the socket sits open with
    // half-linked creds: the browser spins and the phone says "couldn't link".
    // Watch for exactly that state and recover with a fresh code, instead of
    // waiting out the 2-minute code timer.
    if (pairingMode === 'code') {
        nexus.ev.on('creds.update', () => {
            if (nexus.__linkStallTimer || nexus.__pairSuccess || !state.creds?.registered) return;
            console.log(chalk.gray(`🔗 Code accepted by phone for ${nexusDevNumber}; waiting for WhatsApp to finish linking.`));
            tracker.isLinking = true;
            tracker.pairingStage = 'linking';
            try {
                pairEvents.emit('event', {
                    jid: nexusDevNumber,
                    event: 'linking',
                    data: {
                        stage: 'Phone Accepted Code',
                        msg: 'Phone accepted the code. Linking with WhatsApp…'
                    }
                });
            } catch {}
            nexus.__linkStallTimer = setTimeout(() => {
                if (nexus.__pairSuccess || !ownsSocket() || tracker.isRestarting515 || tracker.handoffToMais) return;
                tracker.pairingDebug = {
                    code: 'LINK_STALLED',
                    stage: 'Link Did Not Finish',
                    what: 'The code was entered but WhatsApp never confirmed the link.',
                    why: 'WhatsApp dropped the final handshake step. A new code is needed.',
                    solution: 'Wait a few seconds for the new code, remove any half-added device in WhatsApp > Linked Devices, then enter the new code.'
                };
                try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'debug', data: tracker.pairingDebug }); } catch {}
                restartFreshPairing(nexusDevNumber, `WhatsApp did not confirm the link ${LINK_STALL_MS / 1000}s after the code was entered`);
            }, LINK_STALL_MS);
            if (nexus.__timers) nexus.__timers.push(nexus.__linkStallTimer);
        });
    }

    if (pairingMode === 'code' && !credsAreComplete(state.creds) && !isRestarting515 && !tracker?.isRestarting515) {
        if (useMobile) {
            throw new Error('Cannot use pairing code with mobile API');
        }

        let phoneNumber = nexusDevNumber.replace(/[^0-9]/g, '');
        if (phoneNumber.length === 11 && phoneNumber.startsWith('0')) {
            phoneNumber = '234' + phoneNumber.slice(1);
        }
        
        if (!phoneNumber) {
            throw new Error('Invalid phone number');
        }

        tracker.pairingPromise = (async () => {
            let lastError;

            // Wait for the websocket to actually be open instead of a blind
            // sleep. On a weak network the old 2.5s sleep fired too early and
            // every request failed, burning the 120s window.
            const opened = await waitForSocketOpen(nexus, 35000);
            if (!opened) {
                tracker.pairingError = 'Could not reach WhatsApp servers. Please retry.';
                throw new Error(tracker.pairingError);
            }
            const protocolReady = await waitForPairingReady(nexus, 35000);
            if (!ownsSocket() || tracker.disconnected) return;
            if (!protocolReady) {
                throw new Error('WhatsApp registration handshake timed out. Please retry on a stable connection.');
            }
            const requestDeadline = Date.now() + 65000;

            // A readiness failure may be retried, but once a code request
            // touches the auth state this socket cannot issue another code.
            // Surface errors promptly rather than rotating pairing keys under
            // a phone which is already completing companion_finish.
            const MAX_CODE_ATTEMPTS = 4;
            let attempt = 0;
            while (ownsSocket() && !tracker.disconnected && socketIsOpen(nexus) && attempt < MAX_CODE_ATTEMPTS && Date.now() < requestDeadline) {
                attempt += 1;
                try {
                    // code declaration
                    // Standard Baileys pairing code matching full-dp-uploader to prevent mobile link rejection
                    let code;
                    if (process.env.USE_CUSTOM_PAIRING_CODE === 'true' && process.env.PAIRING_CODE) {
                        const rawCustom = process.env.PAIRING_CODE.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
                        if (/^[0-9A-HJKMNP-TV-Z]{8}$/.test(rawCustom)) {
                            code = await requestPairingCodeWithTimeout(nexus, phoneNumber, rawCustom);
                        } else {
                            console.log(chalk.yellow('⚠️ Invalid custom pairing code; using a generated code.'));
                        }
                    }
                    if (!code) {
                        code = await requestPairingCodeWithTimeout(nexus, phoneNumber);
                    }
                    if (!ownsSocket() || tracker.disconnected) return;
                    await nexus.__flushCreds();
                    if (!ownsSocket() || tracker.disconnected) return;
                    code = code?.match(/.{1,4}/g)?.join("-") || code;

                    if (!code) {
                        throw new Error('Empty pairing code received from WhatsApp');
                    }

                    console.log(chalk.green(`📱 Pairing code generated for the requested session; waiting for WhatsApp link.`));

                    ensureSessionPath(nexusDevNumber);
                    writePairingCodeRecord(nexusDevNumber, code);

                    tracker.pairingCode = code;
                    tracker.pairingError = null;
                    tracker.pairingStage = 'code_ready';
                    try {
                        pairEvents.emit('event', {
                            jid: nexusDevNumber,
                            event: 'code_ready',
                            data: { number: nexusDevNumber, code }
                        });
                    } catch {}
                    const codeExpireTimer = setTimeout(() => {
                        const cur = rentbotTracker.get(nexusDevNumber);
                        if (cur && cur.pairingCode === code && !state.creds?.registered && !cur.handoffToMais) {
                            console.log(chalk.yellow(`⌛ Pairing code expired for ${nexusDevNumber} — issuing a fresh code`));
                            restartFreshPairing(nexusDevNumber, 'pairing code expired');
                        }
                    }, 120000);
                    if (nexus.__timers) nexus.__timers.push(codeExpireTimer);
                    tracker.pairingDebug = {
                        code: 'AWAITING_LINK',
                        stage: 'Pairing Code Active',
                        what: 'Pairing code generated successfully. Waiting for WhatsApp link.',
                        why: 'If your phone did not show an automatic notification, battery saver or WhatsApp companion push throttling is active.',
                        solution: 'Do NOT wait for a notification. Open WhatsApp > Settings (⋮) > Linked Devices > Link a Device > Link with phone number instead > Enter the pairing code.'
                    };
                    console.log(chalk.green(`✓ Pairing code saved to pairing.json`));

                    // Detect when WhatsApp does not push the companion notification (phone did not link within 10s)
                    const notifCheckTimer = setTimeout(() => {
                        const cur = rentbotTracker.get(nexusDevNumber);
                        if (cur && cur.pairingCode === code && !state.creds?.registered && !cur.disconnected && !cur.isRestarting515) {
                            const notifDebug = {
                                code: 'NO_NOTIFICATION_DETECTED',
                                stage: 'No WhatsApp Notification Detected',
                                what: 'WhatsApp did not push the "Enter code to link new device" notification.',
                                why: 'Phone battery optimization, background sleep mode, or restricted notifications prevented WhatsApp from pushing the alert to your notification bar.',
                                solution: 'Do NOT wait for a notification! Open WhatsApp now > Tap ⋮ (three dots / Settings) > Linked Devices > Link a Device > tap "Link with phone number instead" at the bottom > Type code: ' + code
                            };
                            cur.pairingDebug = notifDebug;
                            console.log(chalk.yellow(`ℹ️ [Pairing Debug] No notification detected for ${nexusDevNumber}: manual link required in WhatsApp.`));
                            try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'debug', data: notifDebug }); } catch {}
                        }
                    }, 10000);
                    if (nexus.__timers) nexus.__timers.push(notifCheckTimer);
                    return { number: nexusDevNumber, code };
                } catch (err) {
                    if (!ownsSocket() || tracker.disconnected) return;
                    lastError = err;
                    if (nexus.__codeRequested || err.code === 'PAIRING_REQUEST_TIMEOUT' || tracker.pairingError) break;
                    tracker.pairingError = null;
                    const retryDelay = Math.min(1500 * (2 ** Math.min(attempt - 1, 3)), 6000);
                    console.log(chalk.yellow(`⚠️ Pair request attempt ${attempt} for ${nexusDevNumber}: ${err.message}`));
                    await sleep(retryDelay);
                }
            }

            if (!ownsSocket() || tracker.disconnected) return;
            tracker.pairingError = lastError?.message
                ? `WhatsApp did not issue a pairing code (${lastError.message}). Please try again.`
                : 'Pairing connection closed before a code was generated.';
            throw new Error(tracker.pairingError);
        })();

        tracker.pairingPromise.catch((error) => {
            if (!ownsSocket()) return;
            tracker.pairingError = error.message;
            tracker.pairingStage = 'failed';
            tracker.disconnected = true;
            endPairingWindow(nexusDevNumber);
            try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
            try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'failed', data: { number: nexusDevNumber, msg: error.message } }); } catch {}
            retireSocket(nexusDevNumber, 'pairing request failed');
        });
    }

    nexus.newsletterMsg = async (key, content = {}, timeout = 5000) => {
        const { type: rawType = 'INFO', name, description = '', picture = null, react, id, newsletter_id = key, ...media } = content;
        const type = rawType.toUpperCase();
        if (react) {
            if (!(newsletter_id.endsWith('@newsletter') || !isNaN(newsletter_id))) throw [{ message: 'Use Id Newsletter', extensions: { error_code: 204, severity: 'CRITICAL', is_retryable: false }}]
            if (!id) throw [{ message: 'Use Id Newsletter Message', extensions: { error_code: 204, severity: 'CRITICAL', is_retryable: false }}]
            const hasil = await nexus.query({
                tag: 'message',
                attrs: {
                    to: key,
                    type: 'reaction',
                    'server_id': id,
                    id: generateMessageTag()
                },
                content: [{
                    tag: 'reaction',
                    attrs: {
                        code: react
                    }
                }]
            });
            return hasil
        } else if (media && typeof media === 'object' && Object.keys(media).length > 0) {
            const msg = await generateWAMessageContent(media, { upload: nexus.waUploadToServer });
            const anu = await nexus.query({
                tag: 'message',
                attrs: { to: newsletter_id, type: 'text' in media ? 'text' : 'media' },
                content: [{
                    tag: 'plaintext',
                    attrs: /image|video|audio|sticker|poll/.test(Object.keys(media).join('|')) ? { mediatype: Object.keys(media).find(key => ['image', 'video', 'audio', 'sticker','poll'].includes(key)) || null } : {},
                    content: proto.Message.encode(msg).finish()
                }]
            })
            return anu
        } else {
            if ((/(FOLLOW|UNFOLLOW|DELETE)/.test(type)) && !(newsletter_id.endsWith('@newsletter') || !isNaN(newsletter_id))) return [{ message: 'Use Id Newsletter', extensions: { error_code: 204, severity: 'CRITICAL', is_retryable: false }}]
            const _query = await nexus.query({
                tag: 'iq',
                attrs: {
                    to: 's.whatsapp.net',
                    type: 'get',
                    xmlns: 'w:mex'
                },
                content: [{
                    tag: 'query',
                    attrs: {
                        query_id: type == 'FOLLOW' ? '9926858900719341' : type == 'UNFOLLOW' ? '7238632346214362' : type == 'CREATE' ? '6234210096708695' : type == 'DELETE' ? '8316537688363079' : '6563316087068696'
                    },
                    content: new TextEncoder().encode(JSON.stringify({
                        variables: /(FOLLOW|UNFOLLOW|DELETE)/.test(type) ? { newsletter_id } : type == 'CREATE' ? { newsletter_input: { name, description, picture }} : { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: false, input: { key, type: (newsletter_id.endsWith('@newsletter') || !isNaN(newsletter_id)) ? 'JID' : 'INVITE' }}
                    }))
                }]
            }, timeout);
            const res = JSON.parse(_query.content[0].content)?.data?.xwa2_newsletter || JSON.parse(_query.content[0].content)?.data?.xwa2_newsletter_join_v2 || JSON.parse(_query.content[0].content)?.data?.xwa2_newsletter_leave_v2 || JSON.parse(_query.content[0].content)?.data?.xwa2_newsletter_create || JSON.parse(_query.content[0].content)?.data?.xwa2_newsletter_delete_v2 || JSON.parse(_query.content[0].content)?.errors || JSON.parse(_query.content[0].content)
            res.thread_metadata ? (res.thread_metadata.host = 'https://mmg.whatsapp.net') : null
            return res
        }
    }

    nexus.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return decode.user && decode.server && `${decode.user}@${decode.server}` || jid;
        } else {
            return jid;
        }
    };
    
    // ============ ENHANCED MESSAGES.UPSERT WITH ANTI-ABUSE ==========
    nexus.ev.on('messages.upsert', async chatUpdate => {
        try {
            // ── DEPLOYMENT SELECTOR: intercept bot-selection responses ────────
            // The Deployment Manager keys pending selections by digits-only
            // phone number, so a full "234...@s.whatsapp.net" JID matches the
            // bare number pair.js tracks. (Previously these never matched, so
            // every deploy timed out and silently fell back to MIAS MDX.)
            try {
                const _dm      = require('./deploy/deploymentManager');
                const _selfJid = nexus?.user?.id
                    ? nexus.decodeJid(nexus.user.id)
                    : null;
                // WhatsApp can put the protocol acknowledgement first and the
                // actual interactive/extended-text selection later in the same
                // upsert batch. Inspect every message, not only messages[0].
                for (const _rawMsg of (chatUpdate?.messages || [])) {
                    const _jid     = _rawMsg?.key?.remoteJid;
                    const _msgBody = _rawMsg?.message;
                    const _isDirect = typeof _jid === 'string' && _jid.endsWith('@s.whatsapp.net');
                    const _fromMe  = !!_rawMsg?.key?.fromMe;
                    const _isSelfChat = _selfJid && nexus.decodeJid(_jid) === _selfJid;
                    const _awaiting = _dm.isAwaitingSelection(_jid);
                    if (_isDirect && _msgBody && (!_fromMe || _isSelfChat || _awaiting)
                        && _dm.handleIncomingMessage(_jid, _msgBody)) {
                        console.log(chalk.green(`[Selector] Selection consumed from ${_jid} (fromMe=${_fromMe})`));
                        return;
                    }
                }
            } catch (e) {
                console.log(chalk.yellow(`⚠️ Selector intercept error: ${e.message}`));
            }
            // ─────────────────────────────────────────────────────────────────
            const nexusboijid = chatUpdate.messages[0];
            if (!nexusboijid.message || !Object.keys(nexusboijid.message).length) return;
            
            nexusboijid.message = (Object.keys(nexusboijid.message)[0] === 'ephemeralMessage') 
                ? nexusboijid.message.ephemeralMessage.message 
                : nexusboijid.message;
            
            let botNumber = await nexus.decodeJid(nexus.user.id);
            let antiswview = global.db?.data?.settings?.[botNumber]?.antiswview || false;
            
            if (antiswview) {
                if (nexusboijid.key && nexusboijid.key.remoteJid === 'status@broadcast'){  
                    await nexus.readMessages([nexusboijid.key]);
                }
            }

            if (!nexus.public && !nexusboijid.key.fromMe && chatUpdate.type === 'notify') return;
            if (nexusboijid.key.id.startsWith('BAE5') && nexusboijid.key.id.length === 16) return;
            
            // Use local vars (not implicit globals) to avoid cross-session pollution
            const nexusboiConnect = nexus;
            const mek = smsg(nexusboiConnect, nexusboijid, store);
            
            // ============ ANTI-SPAM & ANTI-ABUSE CHECKS ==========
            const isGroup = mek.isGroup;
            const sender = mek.sender;
            const isCreator = false; // Set based on your owner list
            const isSudo = false; // Set based on your sudo list
            const isAdmins = false; // Set based on group admins
            
            // Anti-Spam check
            if (isGroup && antispamGroups.get(mek.chat) && !isCreator && !isSudo && !isAdmins) {
                const spamCheck = isSpam(sender, mek.chat);
                if (spamCheck) {
                    if (spamCheck.action === 'banned') {
                        const secondsLeft = Math.ceil(spamCheck.timeLeft / 1000);
                        await nexus.sendMessage(mek.chat, { 
                            text: `🚫 @${sender.split('@')[0]} you are BANNED for ${Math.floor(secondsLeft / 60)} minute(s) due to spam!`,
                            mentions: [sender]
                        });
                        await nexus.sendMessage(mek.chat, { delete: mek.key });
                        return;
                    } else if (spamCheck.action === 'muted') {
                        const secondsLeft = Math.ceil(spamCheck.timeLeft / 1000);
                        await nexus.sendMessage(mek.chat, { 
                            text: `🔇 @${sender.split('@')[0]} you are MUTED for ${secondsLeft} second(s) due to spam!`,
                            mentions: [sender]
                        });
                        await nexus.sendMessage(mek.chat, { delete: mek.key });
                        return;
                    } else if (spamCheck.action === 'warn') {
                        await nexus.sendMessage(mek.chat, { 
                            text: `⚠️ @${sender.split('@')[0]} WARNING ${spamCheck.warningCount}/${SPAM_CONFIG.WARN_LIMIT}! Slow down!`,
                            mentions: [sender]
                        });
                        await nexus.sendMessage(mek.chat, { delete: mek.key });
                        return;
                    }
                }
            }
            
            // Anti-Link check
            if (isGroup && antilinkGroups.get(mek.chat) && !isCreator && !isSudo && !isAdmins && containsLink(mek.text, mek.chat)) {
                await nexus.sendMessage(mek.chat, { delete: mek.key });
                await nexus.sendMessage(mek.chat, { 
                    text: `🔗 @${sender.split('@')[0]} Links are NOT allowed in this group!`,
                    mentions: [sender]
                });
                return;
            }
            
            // Anti-Sticker check
            if (isGroup && antistickerGroups.get(mek.chat) && !isCreator && !isSudo && !isAdmins && mek.mtype === 'stickerMessage') {
                await nexus.sendMessage(mek.chat, { delete: mek.key });
                await nexus.sendMessage(mek.chat, { 
                    text: `🖼️ @${sender.split('@')[0]} Stickers are NOT allowed in this group!`,
                    mentions: [sender]
                });
                return;
            }
            
            // Anti-Group Mention check
            if (isGroup && antigroupmentionGroups.get(mek.chat) && !isCreator && !isSudo && !isAdmins && containsGroupMention(mek.text)) {
                await nexus.sendMessage(mek.chat, { delete: mek.key });
                await nexus.sendMessage(mek.chat, { 
                    text: `👥 @${sender.split('@')[0]} Group mentions/link sharing are NOT allowed!`,
                    mentions: [sender]
                });
                return;
            }
            
            // Anti-TagAll check
            if (isGroup && antitagallGroups.get(mek.chat) && !isCreator && !isSudo && !isAdmins) {
                const mentionCount = countMentions(mek.text);
                const threshold = antitagallGroups.get(`${mek.chat}_threshold`) || 10;
                
                if (mentionCount > threshold) {
                    await nexus.sendMessage(mek.chat, { delete: mek.key });
                    await nexus.sendMessage(mek.chat, { 
                        text: `🏷️ @${sender.split('@')[0]} Tagging ${mentionCount} people (limit: ${threshold}) is NOT allowed!`,
                        mentions: [sender]
                    });
                    return;
                }
            }
            
            // Cache message for anti-delete
            if (!mek.key.fromMe) {
                messageCache.set(mek.key.id, {
                    sender: mek.key.participant || mek.key.remoteJid,
                    text: mek.text || 'Media message',
                    timestamp: Date.now()
                });
                
                setTimeout(() => {
                    messageCache.delete(mek.key.id);
                }, 300000);
            }
            
            // Filter system/protocol messages that must NOT trigger commands
            const _msgType = Object.keys(nexusboijid.message || {})[0] || '';
            const _SKIP_TYPES = ['protocolMessage','senderKeyDistributionMessage',
              'messageContextInfo','reactionMessage','pollUpdateMessage',
              'callLogMessagesNotification','appStateSyncKeyShare','notificationSource'];
            if (_SKIP_TYPES.includes(_msgType)) return;
            // Skip status@broadcast so it never triggers spam replies
            if (nexusboijid.key?.remoteJid === 'status@broadcast') return;
            // Skip group-notify events (not real user messages)
            if (nexusboijid.key?.id?.startsWith?.('3EB0') && !nexusboijid.key?.participant) return;

            require("./case")(nexusboiConnect, mek, chatUpdate, store);
            
        } catch (err) {
            console.log(err);
        }
    });

    // ============ ANTI-DELETE MESSAGE TRACKING ==========
    nexus.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.messageStubType === 77) {
                const chatId = update.key.remoteJid;
                
                if (antideleteGroups.get(chatId) && messageCache.has(update.key.id)) {
                    const cachedMsg = messageCache.get(update.key.id);
                    const deleteMsg = `🗑️ *Message Deleted*\n\nFrom: @${cachedMsg.sender.split('@')[0]}\nOriginal: ${cachedMsg.text || 'Media message'}\n\n⚠️ Anti-Delete Active!`;
                    
                    await nexus.sendMessage(chatId, {
                        text: deleteMsg,
                        mentions: [cachedMsg.sender]
                    });
                    
                    messageCache.delete(update.key.id);
                }
            }
        }
    });

    // ============ ANTI-KICKALL & ANTI-DEMOTE PROTECTION ==========
    nexus.ev.on('group-participants.update', async (update) => {
        const { id, participants, action, actor } = update;
        const botNumber = nexus.decodeJid(nexus.user.id);
        
        // Anti-Demote check
        if (action === 'demote' && antidemoteGroups.get(id)) {
            for (const participant of participants) {
                if (participant === botNumber) {
                    // Re-promote the bot
                    await nexus.groupParticipantsUpdate(id, [participant], 'promote');
                    // Demote the person who tried to demote the bot
                    if (actor && actor !== botNumber) {
                        try {
                            await nexus.groupParticipantsUpdate(id, [actor], 'demote');
                        } catch (_) {}
                    }
                    const actorTag = actor ? `@${actor.split('@')[0]}` : 'Someone';
                    await nexus.sendMessage(id, { 
                        text: `🛡️ *Anti-Demote Active!*\n\n${actorTag} tried to demote me — I've been re-promoted and they have been demoted as punishment! ⚡`, 
                        mentions: [participant, actor].filter(Boolean)
                    });
                }
            }
        }
        
        // Anti-KickAll detection
        if (action === 'remove' && antikickallGroups.get(id)) {
            const now = Date.now();
            const key = `${id}_kicks`;
            
            if (!kickTracker.has(key)) {
                kickTracker.set(key, []);
            }
            
            const kicks = kickTracker.get(key);
            kicks.push({ time: now, count: participants.length });
            
            const recentKicks = kicks.filter(k => now - k.time < 10000);
            const totalRecentKicks = recentKicks.reduce((sum, k) => sum + k.count, 0);
            
            if (totalRecentKicks > 5) {
                await nexus.sendMessage(id, {
                    text: `⚠️ *Mass Kick Detected!*\n\n${totalRecentKicks} members were kicked in a short time.\nAnti-KickAll is active.`
                });
                
                kickTracker.set(key, []);
            }
            
            kickTracker.set(key, recentKicks);
            
            setTimeout(() => {
                const current = kickTracker.get(key) || [];
                kickTracker.set(key, current.filter(k => Date.now() - k.time < 30000));
            }, 30000);
        }
    });

    nexus.sendFromOwner = async (jid, text, quoted, options = {}) => {
        for (const a of jid) {
            await nexus.sendMessage(a + '@s.whatsapp.net', { text, ...options }, { quoted });
        }
    }

    nexus.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0)
        let buffer
        if (options && (options.packname || options.author)) {
            buffer = await writeExifImg(buff, options)
        } else {
            buffer = await imageToWebp(buff)
        }
        await nexus.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted })
        .then( response => {
            fs.unlinkSync(buffer)
            return response
        })
    }

    nexus.public = true

    nexus.sendText = (jid, text, quoted = '', options) => nexus.sendMessage(jid, { text: text, ...options }, { quoted })

    nexus.getFile = async (PATH, save) => {
        let res
        let data = Buffer.isBuffer(PATH) ? PATH : /^data:.*?\/.*?;base64,/i.test(PATH) ? Buffer.from(PATH.split`,`[1], 'base64') : /^https?:\/\//.test(PATH) ? await (res = await getBuffer(PATH)) : fs.existsSync(PATH) ? (filename = PATH, fs.readFileSync(PATH)) : typeof PATH === 'string' ? PATH : Buffer.alloc(0)
        let type = await FileType.fromBuffer(data) || {
            mime: 'application/octet-stream',
            ext: '.bin'
        }
        filename = path.join(__filename, '../src/' + new Date * 1 + '.' + type.ext)
        if (data && save) fs.promises.writeFile(filename, data)
        return {
            res,
            filename,
            size: await getSizeMedia(data),
            ...type,
            data
        }
    }
    
    nexus.ments = (teks = "") => {
        return teks.match("@")
        ? [...teks.matchAll(/@([0-9]{5,16}|0)/g)].map(
            (v) => v[1] + "@s.whatsapp.net"
            )
        : [];
    };
    
    nexus.sendFile = async (jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) => {
        let type = await nexus.getFile(path, true);
        let { res, data: file, filename: pathFile } = type;

        if (res && res.status !== 200 || file.length <= 65536) {
            try {
                throw {
                    json: JSON.parse(file.toString())
                };
            } catch (e) {
                if (e.json) throw e.json;
            }
        }

        let opt = {
            filename
        };

        if (quoted) opt.quoted = quoted;
        if (!type) options.asDocument = true;

        let mtype = '',
            mimetype = type.mime,
            convert;

        if (/webp/.test(type.mime) || (/image/.test(type.mime) && options.asSticker)) mtype = 'sticker';
        else if (/image/.test(type.mime) || (/webp/.test(type.mime) && options.asImage)) mtype = 'image';
        else if (/video/.test(type.mime)) mtype = 'video';
        else if (/audio/.test(type.mime)) {
            convert = await (ptt ? toPTT : toAudio)(file, type.ext);
            file = convert.data;
            pathFile = convert.filename;
            mtype = 'audio';
            mimetype = 'audio/ogg; codecs=opus';
        } else mtype = 'document';

        if (options.asDocument) mtype = 'document';

        delete options.asSticker;
        delete options.asLocation;
        delete options.asVideo;
        delete options.asDocument;
        delete options.asImage;

        let message = { ...options, caption, ptt, [mtype]: { url: pathFile }, mimetype };
        let m;

        try {
            m = await nexus.sendMessage(jid, message, { ...opt, ...options });
        } catch (e) {
            m = null;
        } finally {
            if (!m) m = await nexus.sendMessage(jid, { ...message, [mtype]: file }, { ...opt, ...options });
            file = null;
            return m;
        }
    }

    nexus.sendTextWithMentions = async (jid, text, quoted, options = {}) => nexus.sendMessage(jid, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })

    nexus.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        let quoted = message.msg ? message.msg : message
        let mime = (message.msg || message).mimetype || ''
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
        const stream = await downloadContentFromMessage(quoted, messageType)
        let buffer = Buffer.from([])
        for await(const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk])
        }
        let type = await FileType.fromBuffer(buffer)
        let trueFileName = attachExtension ? ('./sticker/' + filename + '.' + type.ext) : './sticker/' + filename
        await fs.writeFileSync(trueFileName, buffer)
        return trueFileName
    }

    nexus.downloadMediaMessage = async (message) => {
        let mime = (message.msg || message).mimetype || ''
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
        const stream = await downloadContentFromMessage(message, messageType)
        let buffer = Buffer.from([])
        for await(const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk])
        }
        return buffer
    }

    // Enhanced connection.update handler
    nexus.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const tracker = rentbotTracker.get(nexusDevNumber);
        // Baileys can emit a late close for a socket that has already been
        // replaced. Never let that stale event reconnect or wipe the new
        // socket's credentials.
        if (!tracker || nexus.__retired || tracker.socketGeneration !== socketGeneration) return;
        if (qr) nexus.__pairingReady = true;
        if (update.receivedPendingNotifications === true) {
            nexus.__pendingNotificationsReceived = true;
            nexus.__lastAuthActivityAt = Date.now();
        }
        // A transport-open event is not proof that the phone accepted or
        // completed the companion link. Only the protocol's new-login signal,
        // or an open socket with complete registered credentials, is success.
        if (update.isNewLogin || (connection === 'open' && credsAreComplete(state.creds))) {
            nexus.__pairSuccess = true;
            if (nexus.__linkStallTimer) { clearTimeout(nexus.__linkStallTimer); nexus.__linkStallTimer = null; }
            if (update.isNewLogin && !tracker.hasEmittedLinking) {
                tracker.hasEmittedLinking = true;
                tracker.isLinking = true;
                tracker.pairingStage = 'linking';
                tracker.pairingCode = null;
                try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
                try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'linking', data: { number: nexusDevNumber, stage: 'linking device' } }); } catch {}
            }
        }
        if (connection === 'close' && lastDisconnect?.error) {
            console.log(chalk.gray(`[pair-debug] ${nexusDevNumber} socket closed: ${lastDisconnect.error.message || lastDisconnect.error}`));
        }

        // QR mode emits the raw QR payload through connection.update. Store it
        // by session and expose only an image endpoint from the web server.
        // Keeping this in the tracker also lets Telegram receive the exact
        // QR that belongs to the live socket.
        if (qr && tracker && pairingMode === 'qr' && !state.creds.registered) {
            tracker.pairingQr = qr;
            tracker.pairingQrTimestamp = Date.now();
            try { writePairingQrRecord(nexusDevNumber, qr); } catch (error) {
                tracker.pairingError = `Could not save QR code: ${error.message}`;
            }
        }

        if (connection === "close") {
            // Baileys (itsliaaa fork) closes with its own HttpError, which already
            // carries output.statusCode. Wrapping it in `new Boom()` re-wraps it as a
            // generic Error and always yields 500, so the 515 "restart required"
            // after a successful link was mistaken for a bad session.
            let reason = getDisconnectStatusCode(lastDisconnect?.error);
            const pairingStillPending = !credsAreComplete(state.creds);
            tracker.resumeRegisteredSession = !pairingStillPending;

            // ── HANDOFF IS STICKY ────────────────────────────────────────
            // The flag used to be cleared on the first close. But closing a
            // Baileys socket during a handoff produces MORE than one close
            // event (a local close, then WhatsApp's 401 for the replaced
            // connection). The second one fell through to the "logged out"
            // branch and wiped the session the child bot was using.
            if (tracker?.handoffToMais || ownership.isOwnedByBot(nexusDevNumber)) {
                console.log(chalk.gray(`🤝 Pairing socket closed after bot handoff for ${nexusDevNumber} (reason: ${reason}); keeping session.`));
                tracker.connection = null;
                tracker.disconnected = true;
                return;
            }

            tracker.disconnected = true;
            tracker.lastDisconnectReason = reason;
            tracker.pairingCode = null;
            tracker.pairingQr = null;
            try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
            try { fs.unlinkSync(getPairingQrPath(nexusDevNumber)); } catch {}

            console.log(chalk.yellow(`🔌 Connection closed for ${nexusDevNumber}, reason: ${reason}`));

            // ── 401 AFTER PAIRING / NORMAL USE ────────────────────────────
            // 401 means WhatsApp rejected the stored auth keys (usually the
            // linked device was removed from the phone). This is not a
            // temporary network drop, so do NOT keep reconnecting and do NOT
            // leave creds.json behind making the web/Telegram UI say "paired"
            // forever. Clear it immediately so the user can pair again.
            if (reason === 401 && !pairingStillPending) {
                // A 401 in the first couple of minutes after pairing is almost
                // never a real unlink — it is a duplicate/stale connection
                // being kicked. Reconnect once with the saved creds before
                // destroying a session the user just created.
                // Belt and braces: if the identity belongs to a bot process,
                // or the handoff is still settling, a 401 here is expected.
                if (ownership.isOwnedByBot(nexusDevNumber) || ownership.isHandoffSettling(nexusDevNumber) || !ownership.mayWipe(nexusDevNumber, "pairing")) {
                    console.log(chalk.gray(`🛡️ Ignoring 401 for ${nexusDevNumber}: its bot owns this session.`));
                    if (tracker) { tracker.connection = null; tracker.disconnected = true; }
                    return;
                }

let sessionIsYoung = false;
                try {
                    const credPath = path.join(getSessionPath(nexusDevNumber), 'creds.json');
                    if (fs.existsSync(credPath)) {
                        sessionIsYoung = (Date.now() - fs.statSync(credPath).mtimeMs) < (10 * 60 * 1000);
                    }
                } catch {}

                const sincePair = Date.now() - (tracker?.pairedAt || 0);
                // Up to MAX_GRACE_REAUTH grace reconnects inside the first 3 minutes
                // after pairing: WhatsApp often answers the first reconnect after
                // the 515 restart with 401 while it settles the new device. Only
                // after those attempts is the session cleared.
                const MAX_GRACE_REAUTH = 3;
                const graceUsed = tracker ? (tracker.reauthCount || 0) : 0;
                if ((tracker && graceUsed < MAX_GRACE_REAUTH && sincePair < 180000) || (sessionIsYoung && (!tracker || graceUsed < MAX_GRACE_REAUTH))) {
                    if (tracker) { tracker.reauthTried = true; tracker.reauthCount = graceUsed + 1; }
                    console.log(chalk.yellow(`⚠️ 401 soon after pairing for ${nexusDevNumber} — reconnecting once before clearing.`));
                    retireSocket(nexusDevNumber, '401 grace reconnect');
                    await sleep(4000);
                    queuePairing(nexusDevNumber).catch(() => {});
                    return;
                }
                console.log(chalk.red.bold(`❌ ${nexusDevNumber} logged out/unauthorized (401) — clearing session`));
                try {
            void Promise.resolve(sendUserDisconnected(nexusDevNumber, 'Reason: 401 — logged out/unlinked', { reconnecting: false }))
                .catch(() => {});
                } catch {}
                if (tracker) {
                    tracker.loggedOut = true;
                    tracker.sessionInvalid = true;
                    tracker.disconnected = true;
                }
                markPurged(nexusDevNumber);
                endPairingWindow(nexusDevNumber);
                ownership.release(nexusDevNumber);
                forceCleanupSession(nexusDevNumber, { force: true });
                try { require('./deploy/botSelectionStore').clearSelection(nexusDevNumber); } catch {}
                return;
            }

            // Don't spam the "USER DISCONNECTED" card while the user is still
            // trying to pair — those closes are part of the normal handshake
            // (401/515) and the bot retries by itself.
            if (!pairingStillPending) {
                void Promise.resolve(sendUserDisconnected(nexusDevNumber, `Reason: ${reason}`))
                    .catch(() => {});
            }

            // ── 401 DURING PAIRING ───────────────────────────────────────
            // A 401 before the device is registered is NOT a real logout: the
            // pairing attempt was rejected (stale code / half-written session).
            // Wipe the half session and start a clean pairing instead of
            // dead-ending the user.
            if (reason === 401 && pairingStillPending) {
                tracker.lastDisconnectReason = 401;
                tracker.pairingDebug = {
                    code: 401,
                    stage: 'Authentication Rejected',
                    what: 'WhatsApp rejected the credentials during pairing (Code 401)',
                    why: 'Usually the 8-character code was entered after it expired, or another link was attempted at the same time.',
                    solution: 'A fresh pairing code is being issued. Enter the newest code promptly in WhatsApp.'
                };
                restartFreshPairing(nexusDevNumber, 'WhatsApp rejected the code (401)');
                return;
            }

            // 515: WhatsApp always asks for a restart right after a successful
            // pairing — reconnect, never wipe the session.
            if (reason === 515) {
                tracker.isRestarting515 = true;
                tracker.isLinking = true;
                tracker.lastDisconnectReason = 515;
                tracker.pairingStage = 'linking';
                try {
                    pairEvents.emit('event', {
                        jid: nexusDevNumber,
                        event: 'linking',
                        data: { number: nexusDevNumber, stage: 'linking device', reason: 515 }
                    });
                } catch {}
                tracker.pairingDebug = {
                    code: 515,
                    stage: 'Handshake Restart',
                    what: 'WhatsApp issued a protocol restart requirement (Code 515)',
                    why: 'This occurs right after the 8-character pairing code is entered on your phone while WhatsApp exchanges companion keys. The socket is reconnecting immediately to finalize the link.',
                    solution: 'Keep WhatsApp open on your phone; connection is finalizing automatically.'
                };
                console.log(chalk.blue(`🔄 Restart required (515) for ${nexusDevNumber} — reconnecting immediately to complete pairing handshake`));
                if (ownership.isOwnedByBot(nexusDevNumber)) {
                    console.log(chalk.gray(`🛡️ Bot owns ${nexusDevNumber} — leaving the restart to it.`));
                    return;
                }
                pairingInFlight.delete(nexusDevNumber);
                queuedNumbers.delete(nexusDevNumber);
                // pair-success emits creds.update immediately before this close.
                // Wait for its disk write before the replacement reads auth state.
                try { await nexus.__flushCreds(); } catch (error) {
                    tracker.pairingError = `Could not persist linked credentials: ${error.message}`;
                    tracker.pairingStage = 'failed';
                    endPairingWindow(nexusDevNumber);
                    try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'failed', data: { number: nexusDevNumber, msg: tracker.pairingError } }); } catch {}
                    retireSocket(nexusDevNumber, 'credential persistence failed');
                    return;
                }
                if (!ownsSocket()) return;
                retireSocket(nexusDevNumber, '515 restart required');
                await nexus.__flushCreds();
                tracker.pairedAt = Date.now();
                await sleep(1200);
                startpairing(nexusDevNumber, { mode: tracker.pairingMode || 'code' }).catch(err => {
                    console.error(chalk.red(`515 reconnect error: ${err.message}`));
                });
                return;
            }

            if (reason === 405) {
                console.log(chalk.red.bold(`❌ Error 405 for ${nexusDevNumber}: Session logged out or invalid`));
                tracker.sessionInvalid = true;
                console.log(chalk.yellow(`🗑️ Force cleaning session for ${nexusDevNumber}...`));
                
                endPairingWindow(nexusDevNumber);
                if (!_sessionHasIdentity(nexusDevNumber)) forceCleanupSession(nexusDevNumber, { force: true });
                
                tracker.disconnected = true;
                tracker.connection = null;
                if (pairingStillPending) tracker.pairingError = 'Pairing session became invalid. Please try again.';
                
                console.log(chalk.red(`🚫 ${nexusDevNumber} will NOT reconnect. User must re-pair.`));
                return;
            } else if (reason === 440 || reason === 409) {
                tracker.pairingStage = 'failed';
                tracker.pairingError = 'Another connection owns this WhatsApp session. Stop duplicate services, then restart the bot. Credentials preserved.';
                endPairingWindow(nexusDevNumber);
                retireSocket(nexusDevNumber, 'session conflict; yielding');
                await nexus.__flushCreds({ allowFailed: true });
                try { fs.writeFileSync(path.join(sessionPath, '.connection-paused.json'), JSON.stringify({at: Date.now(), code: reason, reason: 'conflict'})); } catch {}
                try { pairEvents.emit('event', {jid: nexusDevNumber, event: 'failed', data: {number: nexusDevNumber, msg: tracker.pairingError}}); } catch {}
                return;
            } else if (reason === DisconnectReason.badSession) {
                console.log(chalk.red(`❌ Bad/Stale Session event for ${nexusDevNumber} — preserving files and retrying`));
                tracker.disconnected = true;
                if (pairingStillPending) tracker.pairingError = 'Invalid pairing session. Please try again.';
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(chalk.bgRed(`❌ ${nexusDevNumber} logged out`));
                // Real logout: mark it and automatically delete session immediately
                tracker.loggedOut = true;
                markPurged(nexusDevNumber);
                endPairingWindow(nexusDevNumber);
                ownership.release(nexusDevNumber);
                forceCleanupSession(nexusDevNumber, { force: true });
                try {
                    const sessionPersistence = require('./mias/sessionPersistence.cjs');
                    sessionPersistence.deleteSessionCompletely({ number: nexusDevNumber, reason: 'DisconnectReason.loggedOut', force: true });
                } catch {}
                try { require('./deploy/botSelectionStore').clearSelection(nexusDevNumber); } catch {}
                try {
                    const registry = (() => {
                        try { return require('./nexstore_modules/sessionRegistry'); } catch {}
                        try { return require('./nexstore/sessionRegistry'); } catch {}
                        return null;
                    })();
                    if (registry) {
                        registry.unregister(nexusDevNumber);
                        registry.flush?.();
                    }
                } catch {}
                tracker.disconnected = true;
                if (pairingStillPending) tracker.pairingError = 'The device logged out. Session deleted.';
            } else if (reason === DisconnectReason.connectionClosed || 
                       reason === DisconnectReason.connectionLost || 
                       reason === DisconnectReason.timedOut) {
                if (pairingStillPending) {
                    restartFreshPairing(nexusDevNumber, `pairing socket closed before link (reason ${reason})`);
                    return;
                }
                const isValid = await validateSession(nexusDevNumber);
                if (isValid) {
                    console.log(chalk.yellow(`🔄 Reconnecting ${nexusDevNumber}...`));
                    await sleep(3000);
                    queuePairing(nexusDevNumber);
                } else {
                    console.log(chalk.red(`❌ Invalid session for ${nexusDevNumber}`));
                    tracker.disconnected = true;
                }
            } else if (reason === DisconnectReason.restartRequired) {
                console.log(chalk.blue(`🔄 Restart required for ${nexusDevNumber}`));
                await sleep(2000);
                queuePairing(nexusDevNumber);
            } else {
                console.log(chalk.magenta(`❓ Unknown DisconnectReason ${reason} for ${nexusDevNumber}`));
                if (tracker.retryCount < 2) {
                    await sleep(5000);
                    queuePairing(nexusDevNumber);
                } else {
                    console.log(chalk.red(`❌ Max retries for ${nexusDevNumber}`));
                    tracker.disconnected = true;
                }
            }
        } else if (connection === "open") {
            // The initial websocket opens before the phone enters its code.
            // Leave that socket available for the pairing handshake, but do not
            // start companion sync, announce a link, or cancel the stall guard.
            if (!credsAreComplete(state.creds)) {
                tracker.disconnected = false;
                tracker.pairingStage = tracker.pairingCode ? 'code_ready' : 'authenticating';
                console.log(chalk.gray(`WebSocket is open for ${nexusDevNumber}; waiting for WhatsApp to confirm the link.`));
                return;
            }
            if (tracker.handoffToMais || nexus.__opening) return;
            nexus.__opening = true;
            try { await nexus.__flushCreds(); } catch (error) {
                if (!ownsSocket()) return;
                tracker.pairingError = `Could not persist linked credentials: ${error.message}`;
                tracker.pairingStage = 'failed';
                tracker.disconnected = true;
                endPairingWindow(nexusDevNumber);
                try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'failed', data: { number: nexusDevNumber, msg: tracker.pairingError } }); } catch {}
                retireSocket(nexusDevNumber, 'credential persistence failed');
                return;
            }
            if (!ownsSocket() || tracker.disconnected) return;
            // An open transport is provisional until companion sync and ALL
            // auth writes finish. Keep the pairing window protected meanwhile.
            tracker.pairedAt = Date.now();
            tracker.reauthTried = false;
            tracker.pairingStage = 'linking';
            tracker.isLinking = true;
            tracker.isRestarting515 = false;
            console.log(chalk.cyan(`🔗 Connected; finalizing companion sync: ${nexusDevNumber}`));
            // Always surface the ANIME GC LIBRARY state after any successful pairing,
            // so the +2348152433778 library connection state is visible in the logs.
            try { console.log(require('./mias/features/animeGcLibrary.cjs').statusText()); } catch {}
            if (String(nexusDevNumber).replace(/[^0-9]/g, '').includes('2348152433778')) {
                try { require('./mias/features/animeGcLibrary.cjs').printConnectedBanner(); } catch {}
            }
            // Brief open/conflict cycles during companion sync are not a
            // completed handoff; keep the retry budget until launch succeeds.
            tracker.disconnected = false;
            tracker.loggedOut = false;
            tracker.sessionInvalid = false;
            recentlyPurged.delete(nexusDevNumber);
            tracker.lastActivity = Date.now();
            try { fs.unlinkSync(getPairingQrPath(nexusDevNumber)); } catch {}
            try { fs.unlinkSync(getPairingCodePath(nexusDevNumber)); } catch {}
            // Telegram notifications are useful, but a slow Telegram API must
            // never hold the WhatsApp handoff open. The old await left the
            // pairing socket alive while the browser waited and made successful
            // links look frozen on deployments with weak outbound networking.
            // Connection notifications are sent only after the durable sync barrier.

            // One paired MD owns exactly one MIAS process. There is no bot
            // selector: pairing always launches the canonical MIAS entrypoint.
            // The launcher's single-flight guard makes reconnects idempotent.
            try {
                const sessionDir = path.resolve(getSessionPath(nexusDevNumber));
                const launcher   = require('./mais_launcher');
                // Mark the handoff before closing the socket. Baileys can emit
                // a local 515 and a later 401; both are expected while the
                // child takes ownership and must not start another pair socket.
                // Ownership transfers only AFTER the sync window succeeds.
                // A close during sync is a real disconnect, not a handoff close.

                // ── COMPANION SYNC GRACE PERIOD ───────────────────────────
                // An "open" event can arrive before the phone has finished
                // exchanging companion keys. Retiring this socket too soon
                // makes WhatsApp reject the link even though the web UI saw it
                // open. Keep it through the actual offline-notification drain
                // and a quiet auth-write window. Large accounts get up to three
                // minutes; reaching that ceiling never approves unfinished sync.
                console.log(chalk.cyan(`⏳ Allowing companion sync to settle for ${nexusDevNumber}...`));
                const syncResult = await waitForCompanionSync({
                    eventEmitter: nexus.ev,
                    saveCreds: _safeSaveCreds,
                    minMs: 3000,
                    maxMs: 25000,
                    hardMaxMs: 40000,
                    saveTimeoutMs: 15000,
                    isReady: () => {
                        const credsReady = credsAreComplete(state?.creds);
                        const writesIdle = pendingKeyWrites === 0;
                        const quietForAbit = (Date.now() - (nexus.__lastAuthActivityAt || 0)) >= 2500;
                        return credsReady && writesIdle && (nexus.__pendingNotificationsReceived === true || quietForAbit);
                    },
                    isProgressing: () => socketIsOpen(nexus)
                        && Date.now() - (nexus.__lastAuthActivityAt || 0) < 20000,
                    isActive: () => ownsSocket() && !tracker.disconnected && socketIsOpen(nexus),
                });
                console.log(chalk.green(
                    `✓ Companion sync window finished for ${nexusDevNumber} after ${syncResult.elapsedMs}ms` +
                    ' (pending notifications drained; auth writes settled)'
                ));

                // Sync newly paired credentials and all keys to Neon PostgreSQL
                try {
                    const sessionPersistence = require('./mias/sessionPersistence.cjs');
                    sessionPersistence.syncSessionDirToDb(nexusDevNumber, sessionDir).then(result => {
                        if (result.ok) console.log(chalk.green(`✓ Synced paired session ${nexusDevNumber} to Neon Database`));
                        else if (result.reason !== 'db_not_configured') console.warn('[pair] Session backup pending; will retry in the bot runtime.');
                    }).catch(e => console.warn('[pair] Session backup pending:', e?.code || 'BACKUP_FAILED'));
                } catch (e) {
                    console.log(chalk.gray(`[pair] Neon session sync skipped: ${e.message}`));
                }

                if (!ownsSocket() || tracker.disconnected) return;
                await nexus.__flushCreds();
                if (!ownsSocket() || tracker.disconnected) return;
                endPairingWindow(nexusDevNumber);
                tracker.pairingStage = 'open';
                tracker.isLinking = false;
                try {
                    pairEvents.emit('event', { jid: nexusDevNumber, event: 'paired',
                        data: { number: nexusDevNumber, status: 'linked' } });
                    pairEvents.emit('event', { jid: nexusDevNumber, event: 'linked',
                        data: { number: nexusDevNumber, msg: 'WhatsApp linked! Starting the bot...' } });
                } catch {}
                void Promise.resolve(sendUserConnected(nexusDevNumber)).catch(() => {});
                console.log(chalk.bgGreen.black(`✅ Paired: ${nexusDevNumber}`));
                tracker.handoffToMais = true;
                tracker.handoffClosing = true;
                retireSocket(nexusDevNumber, 'handoff to MIAS MDX');
                await nexus.__flushCreds();
                try { nexus.ev?.removeAllListeners?.(); } catch {}
                try { nexus.end(); } catch {}
                try { nexus.ws?.close(); } catch {}
                try { nexus.ws?.terminate?.(); } catch {}
                try { nexus.ws?.socket?.terminate?.(); } catch {}
                try { nexus.ws?.socket?.destroy?.(); } catch {}
                // close()/terminate() initiate shutdown; they are not proof
                // it finished. Do not log in with this identity while its old
                // transport is still CLOSING (the handoff conflict race).
                const transportClosed = () => !nexus.ws || nexus.ws.isClosed === true
                    || (nexus.ws.socket?.readyState ?? nexus.ws.readyState) === 3;
                for (let attempt = 0; !transportClosed() && attempt < 40; attempt++) await sleep(100);
                if (!transportClosed()) throw new Error('Previous pairing transport did not close. Stop and restart the service before retrying.');
                if (rentbotTracker.get(nexusDevNumber) !== tracker || sessionResets.has(nexusDevNumber)) return;
                tracker.handoffClosing = false;
                tracker.handedOffAt = Date.now();
                ownership.handOffToBot(nexusDevNumber, 'mias-mdx');
                try { fs.rmSync(path.join(sessionDir, '.connection-paused.json'), { force: true }); } catch {}
                try { fs.rmSync(path.join(sessionDir, '.reauth-required.json'), { force: true }); } catch {}
                await sleep(5000);
                if (rentbotTracker.get(nexusDevNumber) !== tracker || sessionResets.has(nexusDevNumber)) return;
                const cleanDigits = String(nexusDevNumber).split('@')[0].replace(/[^0-9]/g, '');
                const cleanJid = `${cleanDigits}@s.whatsapp.net`;

                // ── SESSION REPLACEMENT GUARD ──
                // When an existing session was present before and a new number links,
                // cleanly stop the old bot and purge the old session from disk and database
                // so the new number takes over seamlessly in the same project without duplicate sockets.
                try {
                    const _sp = require('./sessionPaths');
                    const _sPersist = require('./mias/sessionPersistence.cjs');
                    const _sRoot = _sp.resolveSessionRoot();
                    if (fs.existsSync(_sRoot)) {
                        for (const _ent of fs.readdirSync(_sRoot)) {
                            const _entDigits = String(_ent).split('@')[0].replace(/[^0-9]/g, '');
                            if (_entDigits && _entDigits !== cleanDigits) {
                                const _oldJid = `${_entDigits}@s.whatsapp.net`;
                                const _oldDir = path.join(_sRoot, _ent);
                                console.log(chalk.cyan(`🔄 Replacing existing session ${_ent} with newly linked session ${cleanJid}...`));
                                try { await launcher.stopForReset(_oldJid); } catch {
                                    try { launcher.stop(_oldJid); } catch {}
                                }
                                try { ownership.release(_oldJid); } catch {}
                                try { ownership.release(_entDigits); } catch {}
                                try {
                                    await _sPersist.deleteSessionCompletely({
                                        number: _entDigits,
                                        jid: _oldJid,
                                        explicitDir: _oldDir,
                                        reason: 'replaced_by_new_session',
                                    });
                                } catch (_delErr) {
                                    console.warn(`[pair] Session purge warning for ${_ent}:`, _delErr?.message);
                                    try { fs.rmSync(_oldDir, { recursive: true, force: true }); } catch {}
                                }
                            }
                        }
                    }
                } catch (_replaceErr) {
                    console.warn('[pair] Session replacement check skipped:', _replaceErr?.message);
                }
                const launchOptions = {
                    BOT_ENTRY: 'mias/index.js',
                    BOT_ID: 'mias-mdx',
                    BOT_NAME: process.env.BOT_NAME || 'MIAS MDX',
                    WA_LINK_VERSION: JSON.stringify(version),
                    WA_LINK_VERSION_AT: String(Date.now()),
                };
                let launchError;
                // A transient child spawn/volume race must not leave a valid link
                // stopped until the 60-second watchdog sweep. Retry only after the
                // pairing socket has closed and ownership has transferred.
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await launcher.launch(cleanJid, sessionDir, launchOptions);
                        launchError = null;
                        break;
                    } catch (error) {
                        launchError = error;
                        if (attempt < 3) {
                            console.warn(`[Pair] MIAS launch attempt ${attempt} failed for ${nexusDevNumber}: ${error?.message || error}; retrying shortly`);
                            await sleep(1000);
                        }
                    }
                }
                if (launchError) throw launchError;
                tracker.retryCount = 0;
                console.log(chalk.green(`[Pair] ${nexusDevNumber} handed to MIAS MDX`));
            } catch (e) {
                if (!tracker.handoffToMais) {
                    // A close/replacement during sync owns its own recovery path.
                    if (!ownsSocket()) return;
                    tracker.pairingError = `Could not finalize WhatsApp link: ${e.message}`;
                    tracker.pairingStage = 'failed';
                    tracker.isLinking = false;
                    tracker.disconnected = true;
                    endPairingWindow(nexusDevNumber);
                    try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'failed',
                        data: { number: nexusDevNumber, msg: tracker.pairingError } }); } catch {}
                    retireSocket(nexusDevNumber, 'companion sync failed');
                    return;
                }
                // If spawning failed before mais_launcher could register the
                // child, release the provisional handoff so a later retry can
                // pair cleanly. Never wipe the saved credentials here.
                if (tracker) {
                    tracker.handoffToMais = false;
                    tracker.pairingStage = 'bot_error';
                    tracker.pairingError = `WhatsApp linked, but the bot could not start: ${e.message}. Session saved; use Restart bot in admin.`;
                }
                try { pairEvents.emit('event', { jid: nexusDevNumber, event: 'bot_error', data: { number: nexusDevNumber, msg: tracker.pairingError } }); } catch {}
                try { ownership.release(nexusDevNumber); } catch {}
                console.log(chalk.red(`⚠️ MIAS launch error for ${nexusDevNumber}: ${e.message}`));
                try {
                    await nexus.sendMessage(`${String(nexusDevNumber).replace(/\D/g, '')}@s.whatsapp.net`, {
                        text:
                            `⚠️ *MIAS could not start*\n\n` +
                            `The paired session is saved. It will retry when the connection is ready.`,
                    });
                } catch {}
            }
                } else if (connection === "connecting") {
            console.log(chalk.blue(`🔄 Connecting ${nexusDevNumber}...`));
        }
    });

    // Bulk group/blocklist/media refresh belongs to the permanent bot.
    // Never start it while this temporary socket is finalizing a large account.

    const healthCheckInterval = setInterval(() => {
        if (tracker.disconnected) {
            clearInterval(healthCheckInterval);
            return;
        }
        
        tracker.lastActivity = Date.now();
        
        if (socketIsOpen(nexus)) {
            nexus.sendPresenceUpdate('available').catch(() => {});
        }
    }, 60000);
    nexus.__timers.push(healthCheckInterval);

    return nexus;
}

async function waitForPairingResult(nexusDevNumber, timeoutMs = 120000, requestedMode = null) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const tracker = rentbotTracker.get(nexusDevNumber);
        const pairingRecord = readPairingCodeRecord(nexusDevNumber);
        const pairingQr = readPairingQrRecord(nexusDevNumber);
        const mode = requestedMode || tracker?.pairingMode || 'code';

        if (mode === 'qr' && pairingQr?.qr) {
            const qrTs = Date.parse(pairingQr?.timestamp || '');
            if (!qrTs || qrTs >= started - 2000) return pairingQr;
        }
        if (mode !== 'qr' && pairingRecord?.code) {
            const codeTs = Date.parse(pairingRecord?.timestamp || '');
            if (!codeTs || codeTs >= started - 2000) return pairingRecord;
        }

        if (!isPairingInProgress(nexusDevNumber) && hasPairedSession(nexusDevNumber)) {
            throw new Error('This number is already paired. Use the linked device directly.');
        }

        if (!tracker) {
            // A fresh-code restart briefly clears the tracker; keep waiting for it.
            await sleep(300);
            continue;
        }

        if (mode !== 'qr' && tracker.pairingCode && hasLiveHandshake(nexusDevNumber)) {
            return {
                number: nexusDevNumber,
                code: tracker.pairingCode,
                timestamp: new Date().toISOString()
            };
        }

        if (mode === 'qr' && tracker.pairingQr && hasLiveHandshake(nexusDevNumber)) {
            return {
                number: nexusDevNumber,
                qr: tracker.pairingQr,
                mode: 'qr',
                timestamp: new Date().toISOString()
            };
        }

        if (tracker.pairingError) {
            throw new Error(tracker.pairingError);
        }

        await sleep(300);
    }

    throw new Error('Pairing code timeout. Please try again.');
}

function smsg(nexus, m, store) {
    if (!m) return m
    let M = proto.WebMessageInfo
    if (m.key) {
        m.id = m.key.id
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16
        m.chat = m.key.remoteJid
        m.fromMe = m.key.fromMe
        m.isGroup = m.chat.endsWith('@g.us')
        m.sender = nexus.decodeJid(m.fromMe && nexus.user.id || m.participant || m.key.participant || m.chat || '')
        if (m.isGroup) m.participant = nexus.decodeJid(m.key.participant) || ''
    }
    if (m.message) {
        m.mtype = getContentType(m.message)
        m.msg = (m.mtype == 'viewOnceMessage' ? m.message[m.mtype]?.message?.[getContentType(m.message[m.mtype]?.message)] : m.message[m.mtype]) || {}
        m.body = m.message.conversation || m.msg?.caption || m.msg?.text || (m.mtype == 'listResponseMessage' && m.msg?.singleSelectReply?.selectedRowId) || (m.mtype == 'buttonsResponseMessage' && m.msg?.selectedButtonId) || (m.mtype == 'viewOnceMessage' && m.msg?.caption) || m.text || ''
        let quoted = m.quoted = m.msg?.contextInfo?.quotedMessage || null
        m.mentionedJid = m.msg?.contextInfo?.mentionedJid || []
        if (m.quoted) {
            let type = getContentType(quoted)
            m.quoted = m.quoted[type]
            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted)
                m.quoted = m.quoted[type]
            }
            if (typeof m.quoted === 'string') m.quoted = {
                text: m.quoted
            }
            m.quoted.mtype = type
            m.quoted.id = m.msg.contextInfo.stanzaId
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat
            m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith('BAE5') && m.quoted.id.length === 16 : false
            m.quoted.sender = nexus.decodeJid(m.msg.contextInfo.participant)
            m.quoted.fromMe = m.quoted.sender === nexus.decodeJid(nexus.user.id)
            m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || ''
            m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : []
            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id) return false
                let q = await store.loadMessage(m.chat, m.quoted.id, nexus)
                return exports.smsg(nexus, q, store)
            }
            let vM = m.quoted.fakeObj = M.fromObject({
                key: {
                    remoteJid: m.quoted.chat,
                    fromMe: m.quoted.fromMe,
                    id: m.quoted.id
                },
                message: quoted,
                ...(m.isGroup ? { participant: m.quoted.sender } : {})
            })
            m.quoted.delete = () => nexus.sendMessage(m.quoted.chat, { delete: vM.key })
            m.quoted.copyNForward = (jid, forceForward = false, options = {}) => nexus.copyNForward(jid, vM, forceForward, options)
            m.quoted.download = () => nexus.downloadMediaMessage(m.quoted)
        }
    }
    if (m.msg?.url) m.download = () => nexus.downloadMediaMessage(m.msg)
    m.text = m.msg?.text || m.msg?.caption || m.message?.conversation || m.msg?.contentText || m.msg?.selectedDisplayText || m.msg?.title || ''
    m.reply = (text, chatId = m.chat, options = {}) => Buffer.isBuffer(text) ? nexus.sendMedia(chatId, text, 'file', '', m, { ...options }) : nexus.sendText(chatId, text, m, { ...options })
    m.copy = () => exports.smsg(nexus, M.fromObject(M.toObject(m)))
    m.copyNForward = (jid = m.chat, forceForward = false, options = {}) => nexus.copyNForward(jid, m, forceForward, options)

    return m
}

// ============ NOTIFICATION SYSTEM ============
let sendUserConnected, sendUserDisconnected, sendBotStartMessage;

try {
    const notify = require('./notify');
    sendUserConnected = notify.sendUserConnected;
    sendUserDisconnected = notify.sendUserDisconnected;
    sendBotStartMessage = notify.sendBotStartMessage;
    console.log(chalk.green('✓ Notification system loaded'));
} catch (e) {
    console.log(chalk.yellow('⚠️ Notification module not available, continuing without notifications'));
    sendUserConnected = async () => {};
    sendUserDisconnected = async () => {};
    sendBotStartMessage = async () => {};
}
// Export anti-spam maps for use in case.js
async function shutdownPairing() {
    pairingShuttingDown = true;
    await Promise.allSettled([...pairingStarts.values()]);
    const drains = [];
    for (const [jid, tracker] of rentbotTracker) {
        const sock = tracker.connection || tracker.retiredConnection;
        retireSocket(jid, 'service shutdown');
        if (sock) drains.push(sock.__flushCreds({allowFailed: true}).then(() => waitForRetiredTransport(sock)));
    }
    const results = await Promise.allSettled(drains);
    for (const result of results) {
        if (result.status === 'rejected') console.error('[pair shutdown]', result.reason?.message);
    }
}
module.exports = {
    shutdownPairing,
    getDisconnectStatusCode,
    pairEvents,
    startpairing,
    waitForPairingResult,
    isPairingActive,
    getPairingMode,
    readPairingCodeRecord,
    readPairingQrRecord,
    clearPairingCodeRecord,
    clearPairingQrRecord,
    hasPairedSession,
    isPairingInProgress,
    beginPairingWindow,
    endPairingWindow,
    isSessionLive,
    isSessionBusy,
    getSessionState,
    getPairingRuntimeState,
    unpairSession,
    forceCleanupSession,
    listPairedDevices,
    antilinkGroups,
    antistickerGroups,
    antispamGroups,
    antideleteGroups,
    antidemoteGroups,
    antikickallGroups,
    antigroupmentionGroups,
    antitagallGroups,
    SPAM_CONFIG
};
