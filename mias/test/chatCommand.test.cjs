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

test('.chat sends quoted image with messageText as caption', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const fakeImgBuf = Buffer.from([1, 2, 3, 4]);
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.chat 2349068551055 Check this out',
        contextInfo: {
          quotedMessage: {
            imageMessage: {
              caption: 'old caption',
              download: async () => fakeImgBuf,
            },
          },
        },
      },
    },
  };

  await handleChatCommand(sock, msg, ['2349068551055', 'Check', 'this', 'out'], {}, deps);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].to, '2349068551055@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content, { image: fakeImgBuf, caption: 'Check this out' });
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'chat sent ✅');
});

test('.chat sends quoted video with messageText as caption', async () => {
  const sock = createMockSocket();
  const replies = [];
  const deps = {
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };
  const fakeVidBuf = Buffer.from([5, 6, 7, 8]);
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.chat 2349068551055 Watch this',
        contextInfo: {
          quotedMessage: {
            videoMessage: {
              caption: 'vid caption',
              mimetype: 'video/mp4',
              download: async () => fakeVidBuf,
            },
          },
        },
      },
    },
  };

  await handleChatCommand(sock, msg, ['2349068551055', 'Watch', 'this'], {}, deps);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].to, '2349068551055@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content, {
    video: fakeVidBuf,
    caption: 'Watch this',
    mimetype: 'video/mp4',
    gifPlayback: false
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0], 'chat sent ✅');
});

test('.chat cleans up temporary disk file on success and on error', async () => {
  const os = require('os');
  const tmpBefore = require('fs').readdirSync(os.tmpdir()).filter(f => f.startsWith('chat_'));
  
  const sock = createMockSocket();
  const deps = {
    sendReply: async () => {},
    CONFIG: { PREFIX: '.' },
  };
  const fakeImgBuf = Buffer.from([1, 2, 3]);
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.chat 2349068551055 Hi',
        contextInfo: {
          quotedMessage: {
            imageMessage: {
              download: async () => fakeImgBuf,
            },
          },
        },
      },
    },
  };

  await handleChatCommand(sock, msg, ['2349068551055', 'Hi'], {}, deps);
  const tmpAfterSuccess = require('fs').readdirSync(os.tmpdir()).filter(f => f.startsWith('chat_'));
  assert.equal(tmpAfterSuccess.length, tmpBefore.length);

  // Now test on send error
  sock.sendMessage = async () => { throw new Error('Send failed'); };
  await handleChatCommand(sock, msg, ['2349068551055', 'Hi'], {}, deps);
  const tmpAfterError = require('fs').readdirSync(os.tmpdir()).filter(f => f.startsWith('chat_'));
  assert.equal(tmpAfterError.length, tmpBefore.length);
});
