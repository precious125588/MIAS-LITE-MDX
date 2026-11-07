import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startWatchdog, stopWatchdog } from '../lib/sessionWatchdog.js';

function makeSocket() {
  return { ev: new EventEmitter(), ws: { readyState: 1 } };
}

test('replacing the watchdog socket detaches observers from the old socket', () => {
  const oldSocket = makeSocket();
  const newSocket = makeSocket();

  startWatchdog(oldSocket, '/tmp/session-old', () => {});
  assert.equal(oldSocket.ev.listenerCount('messages.upsert'), 1);
  assert.equal(oldSocket.ev.listenerCount('connection.update'), 1);

  startWatchdog(newSocket, '/tmp/session-new', () => {});
  assert.equal(oldSocket.ev.listenerCount('messages.upsert'), 0);
  assert.equal(oldSocket.ev.listenerCount('connection.update'), 0);
  assert.equal(newSocket.ev.listenerCount('messages.upsert'), 1);
  assert.equal(newSocket.ev.listenerCount('connection.update'), 1);

  stopWatchdog();
  assert.equal(newSocket.ev.listenerCount('messages.upsert'), 0);
  assert.equal(newSocket.ev.listenerCount('connection.update'), 0);
});
