/**
 * MIAS — Event Bus
 *
 * Internal event system so modules communicate through events
 * instead of tightly coupling to each other.
 *
 * Usage:
 *   import { on, emit, off, once } from "./EventBus.js";
 *   on("command:success", ({ cmd, jid }) => { ... });
 *   emit("command:success", { cmd: "play", jid: "..." });
 *
 * Architecture: Module A → EventBus → Module B (decoupled)
 */

const _handlers = new Map();  // event → Set<handler>
const _onceKeys = new WeakSet(); // handlers registered with once()

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Subscribe to an event.
 * @param {string}   event
 * @param {Function} handler
 * @returns {Function} unsubscribe function
 */
export function on(event, handler) {
  if (typeof handler !== "function") throw new TypeError("EventBus.on: handler must be a function");
  if (!_handlers.has(event)) _handlers.set(event, new Set());
  _handlers.get(event).add(handler);
  return () => off(event, handler);
}

/**
 * Subscribe to an event, but only fire once.
 * @param {string}   event
 * @param {Function} handler
 * @returns {Function} unsubscribe function
 */
export function once(event, handler) {
  const wrapped = async (data) => {
    off(event, wrapped);
    await handler(data);
  };
  _onceKeys.add(wrapped);
  return on(event, wrapped);
}

/**
 * Unsubscribe a handler from an event.
 * @param {string}   event
 * @param {Function} handler
 */
export function off(event, handler) {
  _handlers.get(event)?.delete(handler);
}

/**
 * Emit an event, calling all subscribers in parallel.
 * Errors in handlers are caught and logged; they don't block other handlers.
 *
 * @param {string} event
 * @param {any}    [data]
 * @returns {Promise<void>}
 */
export async function emit(event, data) {
  const handlers = _handlers.get(event);
  if (!handlers || handlers.size === 0) return;

  const promises = [];
  for (const h of handlers) {
    promises.push(
      Promise.resolve().then(() => h(data)).catch((err) => {
        console.error(`[EventBus] Error in handler for "${event}":`, err?.message || err);
      })
    );
  }
  await Promise.allSettled(promises);
}

/**
 * Emit synchronously (fire-and-forget, no await).
 * @param {string} event
 * @param {any}    [data]
 */
export function emitSync(event, data) {
  void emit(event, data);
}

/**
 * Remove all handlers for an event, or all handlers for all events.
 * @param {string} [event]
 */
export function removeAll(event) {
  if (event) _handlers.delete(event);
  else _handlers.clear();
}

/**
 * List all registered event names.
 * @returns {string[]}
 */
export function listEvents() {
  return [..._handlers.keys()];
}

/**
 * Get the number of handlers for an event.
 * @param {string} event
 * @returns {number}
 */
export function listenerCount(event) {
  return _handlers.get(event)?.size ?? 0;
}

// ─── Standard MIAS events ─────────────────────────────────────────────────────

export const EVENTS = Object.freeze({
  // Command lifecycle
  COMMAND_START:   "command:start",
  COMMAND_SUCCESS: "command:success",
  COMMAND_FAIL:    "command:fail",
  COMMAND_BLOCKED: "command:blocked",
  // Media events
  MEDIA_DOWNLOAD:  "media:download",
  MEDIA_UPLOAD:    "media:upload",
  MEDIA_PROCESS:   "media:process",
  // Connection events
  BOT_CONNECT:     "bot:connect",
  BOT_DISCONNECT:  "bot:disconnect",
  BOT_RECONNECT:   "bot:reconnect",
  // Session events
  SESSION_READY:   "session:ready",
  SESSION_CLOSED:  "session:closed",
  // Message events
  MESSAGE_IN:      "message:in",
  MESSAGE_OUT:     "message:out",
  // Cache events
  CACHE_HIT:       "cache:hit",
  CACHE_MISS:      "cache:miss",
  // System events
  STARTUP:         "system:startup",
  SHUTDOWN:        "system:shutdown",
  ERROR:           "system:error",
});

export default { on, off, once, emit, emitSync, removeAll, listEvents, listenerCount, EVENTS };
