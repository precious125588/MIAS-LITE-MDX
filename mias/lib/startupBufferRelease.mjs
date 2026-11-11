/**
 * Releases Baileys' startup event buffer once the WhatsApp connection opens.
 *
 * On a saved session Baileys buffers incoming events while it drains the offline
 * queue. A command that arrives in that window is held until the queue finishes,
 * or until Baileys' 30-second safety timeout, so the bot looks silent right after it
 * comes online. Calling flush() on open lets new messages through at once.
 * flush() does nothing when nothing is buffered, so it is safe to call repeatedly.
 */
export function releaseBufferOnOpen(sock) {
  const ev = sock?.ev;
  if (!ev || typeof ev.on !== 'function' || typeof ev.flush !== 'function') return false;
  ev.on('connection.update', (update) => {
    const state = update || {};
    if (state.connection === 'open' || state.receivedPendingNotifications === true) {
      try { ev.flush(); } catch (_) { /* a flush problem must never break the connection */ }
    }
  });
  return true;
}
