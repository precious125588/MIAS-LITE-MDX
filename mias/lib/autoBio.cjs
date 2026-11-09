'use strict';

/**
 * Keep the bot's WhatsApp About set to the requested online status while its
 * primary socket is connected. The connection event listener is attached once
 * per socket; reconnects restart the timer and closing a socket clears it.
 */
const ONLINE_BIO = 'MIAS IS ONLINE';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const attachedSockets = new WeakSet();

function socketIsOpen(sock) {
  return Boolean(sock && !sock.__retired && sock.ws && sock.ws.readyState === 1);
}

function updateBio(sock) {
  if (!socketIsOpen(sock) || typeof sock.updateProfileStatus !== 'function') return Promise.resolve(false);
  if (sock.__miasAutoBioUpdate) return sock.__miasAutoBioUpdate;

  const update = Promise.resolve()
    .then(() => sock.updateProfileStatus(ONLINE_BIO))
    .then(() => true)
    .catch((error) => {
      console.error('[autobio] Could not update WhatsApp About:', error?.message || error);
      return false;
    })
    .finally(() => { sock.__miasAutoBioUpdate = null; });
  sock.__miasAutoBioUpdate = update;
  return update;
}

function attach(sock, options = {}) {
  if (!sock || !sock.ev || typeof sock.ev.on !== 'function' || attachedSockets.has(sock)) return false;
  attachedSockets.add(sock);

  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : REFRESH_INTERVAL_MS;
  let refreshTimer = null;
  let active = false;

  const stopRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    active = false;
  };

  const startRefresh = () => {
    if (active || !socketIsOpen(sock)) return;
    active = true;
    void updateBio(sock);
    refreshTimer = setInterval(() => {
      if (!socketIsOpen(sock)) return stopRefresh();
      void updateBio(sock);
    }, intervalMs);
    refreshTimer.unref?.();
  };

  sock.ev.on('connection.update', ({ connection } = {}) => {
    if (connection === 'open') startRefresh();
    else if (connection === 'close') stopRefresh();
  });

  // Handles a socket that was already open when this helper was attached.
  startRefresh();
  return true;
}

module.exports = { ONLINE_BIO, REFRESH_INTERVAL_MS, attach, updateBio };
