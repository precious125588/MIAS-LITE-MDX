import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startWatchdog, stopWatchdog, _testing } from '../lib/sessionWatchdog.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSocket({ readyState = 1, pingOk = true } = {}) {
  const sock = {
    ev: new EventEmitter(),
    ws: { readyState },
    sendPresenceUpdate: async () => {},
    query: async () => {
      if (!pingOk) throw new Error('Connection Closed');
      return { tag: 'iq', attrs: { type: 'result' } };
    },
  };
  return sock;
}

function setup(sock) {
  _testing.reset();
  stopWatchdog();
  const reasons = [];
  startWatchdog(sock, '/tmp/session-liveness', (reason) => reasons.push(reason));
  return reasons;
}

test('a dead-but-open socket that fails the server ping is reconnected from the tick', async () => {
  const sock = makeSocket({ readyState: 1, pingOk: false });
  const reasons = setup(sock);
  // 25 minutes of silence on an open socket is a zombie signature; the tick must confirm it with a ping.
  _testing.setLastMessageAgo(25 * 60_000);
  await _testing.tick();
  await wait(3_200);
  assert.deepEqual(reasons, ['watchdog-silent-zombie']);
  stopWatchdog();
});

test('a healthy socket that answers the ping is not reconnected', async () => {
  const sock = makeSocket({ readyState: 1, pingOk: true });
  const reasons = setup(sock);
  _testing.setLastMessageAgo(13 * 60_000);
  await _testing.tick();
  await wait(3_200);
  assert.deepEqual(reasons, []);
  stopWatchdog();
});

test('a closed socket is healed even after its close event', async () => {
  const sock = makeSocket({ readyState: 3, pingOk: false });
  const reasons = setup(sock);
  sock.ev.emit('connection.update', { connection: 'close' });
  _testing.setLastMessageAgo(25 * 60_000);
  await _testing.tick();
  await wait(3_200);
  assert.ok(reasons.length >= 1, 'closed socket must trigger a reconnect');
  stopWatchdog();
});

test('a long silence on a zombie socket triggers a ping-only reconnect', async () => {
  const sock = makeSocket({ readyState: 1, pingOk: false });
  const reasons = setup(sock);
  _testing.setLastMessageAgo(25 * 60_000);
  await _testing.probeOnly();
  await wait(3_200);
  assert.deepEqual(reasons, ['watchdog-silent-zombie']);
  stopWatchdog();
});

test('a quiet but live socket is not reconnected for silence alone', async () => {
  const sock = makeSocket({ readyState: 1, pingOk: true });
  const reasons = setup(sock);
  _testing.setLastMessageAgo(25 * 60_000);
  await _testing.probeOnly();
  await wait(3_200);
  assert.deepEqual(reasons, []);
  stopWatchdog();
});
