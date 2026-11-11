/**
 * Busy tracking for safe auto-updates and non-blocking commands.
 *
 * - Commands run detached: the message loop no longer waits for one command to
 *   finish before reading the next message, so a slow command cannot hold up `.ping`.
 * - The bot counts as idle only when no command is running, it has produced no
 *   output recently, and the owner has not run a command recently. Code updates wait
 *   for that state. MAX_DEFER_MS caps the wait so an always-busy bot still updates.
 */

const QUIET_COMMAND_MS = 20 * 1000;   // after a command starts or ends
const QUIET_OUTBOUND_MS = 60 * 1000;  // after the bot last sent a message
const QUIET_OWNER_MS = 120 * 1000;    // after the owner last ran a command
export const MAX_DEFER_MS = 2 * 60 * 60 * 1000;

const state = {
  active: 0,
  lastCommandAt: 0,
  lastOutboundAt: 0,
  lastOwnerCommandAt: 0,
};

export function markOutbound(now = Date.now()) {
  state.lastOutboundAt = now;
}

export function isBotIdle(now = Date.now()) {
  if (state.active > 0) return false;
  if (now - state.lastCommandAt < QUIET_COMMAND_MS) return false;
  if (now - state.lastOutboundAt < QUIET_OUTBOUND_MS) return false;
  if (now - state.lastOwnerCommandAt < QUIET_OWNER_MS) return false;
  return true;
}

export function getBusyStatus(now = Date.now()) {
  return { active: state.active, idle: isBotIdle(now) };
}

/**
 * Starts a command without awaiting it, so the caller can read the next message.
 * A failure is logged and reported once in the chat, as before.
 */
export function runCommandDetached(sock, msg, name, isOwnerish, fn) {
  const now = Date.now();
  state.active++;
  state.lastCommandAt = now;
  if (isOwnerish) state.lastOwnerCommandAt = now;

  return Promise.resolve()
    .then(fn)
    .catch(async (err) => {
      const text = err?.message || String(err);
      console.error(`[command] ${name} failed:`, text);
      try {
        const jid = msg?.key?.remoteJid;
        if (sock && typeof sock.sendMessage === "function" && jid) {
          await sock.sendMessage(jid, { text: `❌ Error running *${name}*: ${text}` }, { quoted: msg });
        }
      } catch {}
    })
    .finally(() => {
      state.active--;
      state.lastCommandAt = Date.now();
    });
}

/** Counts every message the bot sends as output, so updates wait for a quiet gap. */
export function wrapOutbound(sock) {
  if (!sock || sock.__miasOutboundWrapped || typeof sock.sendMessage !== "function") return false;
  const original = sock.sendMessage;
  sock.sendMessage = function (...args) {
    markOutbound();
    return original.apply(this, args);
  };
  sock.__miasOutboundWrapped = true;
  return true;
}

export function _resetBusyForTests() {
  state.active = 0;
  state.lastCommandAt = 0;
  state.lastOutboundAt = 0;
  state.lastOwnerCommandAt = 0;
}

// Read by the minified message loop in mias/index.js, which cannot import this module.
if (!globalThis.__miasRunCommand) {
  globalThis.__miasRunCommand = (sock, msg, name, isOwnerish, fn) =>
    runCommandDetached(sock, msg, name, isOwnerish, fn);
}
