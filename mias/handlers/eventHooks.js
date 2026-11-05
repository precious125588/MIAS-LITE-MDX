/**
 * MIAS — Event Hook System  v1
 *
 * Publish/subscribe lifecycle hooks for command, send, download, upload,
 * interactive, and reaction events.
 *
 * Future logging, analytics, metrics, and plugin systems attach here.
 * Commands NEVER need modification to benefit from hooks.
 *
 * Supported events:
 *   beforeCommand   afterCommand
 *   beforeSend      afterSend
 *   beforeDownload  afterDownload
 *   beforeUpload    afterUpload
 *   beforeInteractive afterInteractive
 *   beforeReaction  afterReaction
 *   onError
 *
 * Usage:
 *   import { onHook, emitHook } from "./eventHooks.js";
 *
 *   // Register a listener
 *   onHook("afterCommand", async (ctx) => {
 *     console.log(`[HOOK] Command "${ctx.command}" finished in ${ctx.duration}ms`);
 *   });
 *
 *   // Emit (called internally by handlers — not by commands)
 *   await emitHook("beforeCommand", { command: "play", jid, msg });
 *
 * Architecture:  Handlers → eventHooks → Registered Listeners
 */

// ─── Supported hook names ─────────────────────────────────────────────────────

export const HOOK_EVENTS = /** @type {const} */ ([
  "beforeCommand",
  "afterCommand",
  "beforeSend",
  "afterSend",
  "beforeDownload",
  "afterDownload",
  "beforeUpload",
  "afterUpload",
  "beforeInteractive",
  "afterInteractive",
  "beforeReaction",
  "afterReaction",
  "onError",
]);

// ─── Internal registry ─────────────────────────────────────────────────────────
// Map<eventName, Set<Function>>

const _hooks = new Map(HOOK_EVENTS.map(e => [e, new Set()]));

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a hook listener for an event.
 * Listeners are called in registration order.
 * Safe to call multiple times — duplicate functions are ignored.
 *
 * @param {string}   event  - One of HOOK_EVENTS
 * @param {Function} fn     - async (context) => void
 * @returns {Function}      - The same fn, for easy unregistration
 */
export function onHook(event, fn) {
  if (!_hooks.has(event)) {
    console.warn(`[eventHooks] Unknown event: "${event}". Registered anyway.`);
    _hooks.set(event, new Set());
  }
  _hooks.get(event).add(fn);
  return fn;
}

/**
 * Alias for onHook — attach a lifecycle listener.
 * @param {string}   event
 * @param {Function} fn
 * @returns {Function}
 */
export const registerHook = onHook;

/**
 * Remove a previously registered hook listener.
 *
 * @param {string}   event
 * @param {Function} fn   - Exact function reference passed to onHook()
 * @returns {boolean}     - true if the listener was found and removed
 */
export function offHook(event, fn) {
  const set = _hooks.get(event);
  if (!set) return false;
  return set.delete(fn);
}

/**
 * Alias for offHook.
 * @param {string}   event
 * @param {Function} fn
 * @returns {boolean}
 */
export const unregisterHook = offHook;

/**
 * Remove all listeners for one event, or all events if no event is specified.
 *
 * @param {string} [event]
 */
export function clearHooks(event) {
  if (event) {
    _hooks.get(event)?.clear();
  } else {
    for (const set of _hooks.values()) set.clear();
  }
}

/**
 * Emit an event, calling all registered listeners in order.
 * Listener errors are caught and logged — they never crash the caller.
 *
 * @param {string} event    - One of HOOK_EVENTS
 * @param {object} [context] - Event payload (varies per event — see below)
 * @returns {Promise<void>}
 *
 * Context shapes by event:
 *
 *   beforeCommand / afterCommand:
 *     { command, jid, msg, args, duration? (afterCommand only), error? }
 *
 *   beforeSend / afterSend:
 *     { type, jid, content, opts, result? (afterSend only) }
 *
 *   beforeDownload / afterDownload:
 *     { source, type, jid, msg, buffer? (afterDownload only) }
 *
 *   beforeUpload / afterUpload:
 *     { buffer, filename, mimetype, url? (afterUpload only) }
 *
 *   beforeInteractive / afterInteractive:
 *     { jid, buttons, body, footer, result? (afterInteractive only) }
 *
 *   beforeReaction / afterReaction:
 *     { emoji, jid, msgKey }
 *
 *   onError:
 *     { error, context, command?, jid? }
 */
export async function emitHook(event, context = {}) {
  const set = _hooks.get(event);
  if (!set || set.size === 0) return;

  for (const fn of set) {
    try {
      await fn(context);
    } catch (err) {
      // Never let a hook crash the main flow
      try {
        console.error(`[eventHooks] Listener error in "${event}":`, err?.message || err);
      } catch {}
    }
  }
}

/**
 * Wrap an async function with beforeCommand / afterCommand hooks.
 * Measures duration and emits both events automatically.
 *
 * @param {string}   command  - Command name
 * @param {string}   jid
 * @param {object}   msg
 * @param {string[]} args
 * @param {Function} fn       - async () => any
 * @returns {Promise<any>}
 */
export async function withCommandHooks(command, jid, msg, args, fn) {
  const ctx = { command, jid, msg, args };
  await emitHook("beforeCommand", ctx);
  const start = Date.now();
  let error = null;
  let result;
  try {
    result = await fn();
  } catch (err) {
    error = err;
    await emitHook("onError", { error: err, context: "command", command, jid });
    throw err;
  } finally {
    const duration = Date.now() - start;
    await emitHook("afterCommand", { ...ctx, duration, error });
  }
  return result;
}

/**
 * List all registered listeners for an event (or all events).
 * Useful for debugging / diagnostics.
 *
 * @param {string} [event]
 * @returns {object}
 */
export function listHooks(event) {
  if (event) {
    return { [event]: [...(_hooks.get(event) || [])].length };
  }
  const out = {};
  for (const [k, v] of _hooks.entries()) out[k] = v.size;
  return out;
}
