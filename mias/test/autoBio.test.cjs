'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ONLINE_BIO, attach } = require('../lib/autoBio.cjs');

function mockSocket(open = false) {
  const ev = new EventEmitter();
  const updates = [];
  return {
    ev,
    ws: { readyState: open ? 1 : 0 },
    updates,
    updateProfileStatus: async (text) => { updates.push(text); },
  };
}

test('autobio writes the exact online About when the socket opens', async () => {
  const sock = mockSocket();
  assert.equal(attach(sock, { intervalMs: 60_000 }), true);
  sock.ws.readyState = 1;
  sock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sock.updates, ['MIAS IS ONLINE']);
  sock.ws.readyState = 3;
  sock.ev.emit('connection.update', { connection: 'close' });
});

test('autobio does not duplicate listeners when attached twice', async () => {
  const sock = mockSocket(true);
  assert.equal(attach(sock, { intervalMs: 60_000 }), true);
  assert.equal(attach(sock, { intervalMs: 60_000 }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sock.updates, [ONLINE_BIO]);
  sock.ws.readyState = 3;
  sock.ev.emit('connection.update', { connection: 'close' });
});

test('autobio refreshes again after a reconnect', async () => {
  const sock = mockSocket();
  attach(sock, { intervalMs: 60_000 });
  sock.ws.readyState = 1;
  sock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((resolve) => setImmediate(resolve));
  sock.ev.emit('connection.update', { connection: 'close' });
  sock.ws.readyState = 1;
  sock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sock.updates, [ONLINE_BIO, ONLINE_BIO]);
  sock.ws.readyState = 3;
  sock.ev.emit('connection.update', { connection: 'close' });
});
