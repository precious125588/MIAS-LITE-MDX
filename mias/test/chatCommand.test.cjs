'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleChatCommand } = require('../../lib/chatCommand.cjs');

function createMockSocket() {
  const sent = [];
  return {
    sent,
    async sendMessage(to, content, opts) {
      sent.push({ to, content, opts });
      return { key: { id: 'sent_' + sent.length, remoteJid: to } };
    },
  };
}

test('.chat usage output is strictly one line when no args are provided', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const msg = { key: { remoteJid: 'user@s.whatsapp.net' } };

  await handleChatCommand(sock, msg, [], {}, deps);
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'Usage: .chat 2349068551055 hello');
  assert.equal(replies[0].includes('\n'), false, 'Usage output must not pass one line');
  assert.equal(sock.sent.length, 0);
});

test('.chat usage output is strictly one line when message text is missing', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const msg = { key: { remoteJid: 'user@s.whatsapp.net' } };

  await handleChatCommand(sock, msg, ['2349068551055'], {}, deps);
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'Usage: .chat 2349068551055 hello');
  assert.equal(replies[0].includes('\n'), false, 'Usage output must not pass one line');
  assert.equal(sock.sent.length, 0);
});

test('.chat sends message to recipient and replies with exact "chat sent ✅"', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };

  await handleChatCommand(sock, msg, ['2349068551055', 'hello', 'world'], {}, deps);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].to, '2349068551055@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content, { text: 'hello world' });
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'chat sent ✅');
});

test('.chat uses quoted message text when only recipient is in args', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.chat 2349068551055',
        contextInfo: {
          quotedMessage: {
            conversation: 'quoted hello',
          },
        },
      },
    },
  };

  await handleChatCommand(sock, msg, ['2349068551055'], {}, deps);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].to, '2349068551055@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content, { text: 'quoted hello' });
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'chat sent ✅');
});

test('.chat reports send failure gracefully', async () => {
  const sock = {
    async sendMessage() {
      throw new Error('Network timeout');
    },
  };
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };

  await handleChatCommand(sock, msg, ['2349068551055', 'hello'], {}, deps);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Failed to send chat: Network timeout/);
});
