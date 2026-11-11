import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { releaseBufferOnOpen } from '../lib/startupBufferRelease.mjs';

function fakeSock() {
  const ev = new EventEmitter();
  ev.flushCalls = 0;
  ev.flush = () => { ev.flushCalls++; return true; };
  return { ev };
}

test('flushes the buffer when the connection opens', () => {
  const sock = fakeSock();
  assert.equal(releaseBufferOnOpen(sock), true);
  sock.ev.emit('connection.update', { connection: 'connecting' });
  assert.equal(sock.ev.flushCalls, 0);
  sock.ev.emit('connection.update', { connection: 'open' });
  assert.equal(sock.ev.flushCalls, 1);
});

test('also flushes when offline notifications are handled', () => {
  const sock = fakeSock();
  releaseBufferOnOpen(sock);
  sock.ev.emit('connection.update', { receivedPendingNotifications: true });
  assert.equal(sock.ev.flushCalls, 1);
});

test('a flush error does not reach the connection events', () => {
  const sock = fakeSock();
  sock.ev.flush = () => { throw new Error('boom'); };
  releaseBufferOnOpen(sock);
  assert.doesNotThrow(() => sock.ev.emit('connection.update', { connection: 'open' }));
});

test('does nothing for a socket without a buffer', () => {
  assert.equal(releaseBufferOnOpen({}), false);
  assert.equal(releaseBufferOnOpen(null), false);
});
