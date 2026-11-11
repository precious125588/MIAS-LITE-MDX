'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractQuotedMessage,
  resolveViewOnceMedia,
  handleViewOnceCommand,
} = require('../../lib/viewOnceCommand.cjs');
const installV41 = require('../precious-fixes-v41.cjs');

function createMockSocket() {
  const sent = [];
  const reactions = [];

  return {
    sent,
    reactions,
    async sendMessage(to, content, opts) {
      sent.push({ to, content, opts });
      if (content?.react) {
        reactions.push({ to, text: content.react.text });
      }
      return { key: { id: 'sent_' + sent.length, remoteJid: to } };
    },
  };
}

test('extractQuotedMessage: extracts from standard contextInfo', () => {
  const msg = {
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          quotedMessage: { conversation: 'hello' },
        },
      },
    },
  };
  const quoted = extractQuotedMessage(msg);
  assert.deepEqual(quoted, { conversation: 'hello' });
});

test('extractQuotedMessage: extracts from ephemeral wrapper', () => {
  const msg = {
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: '.vv',
            contextInfo: {
              quotedMessage: { conversation: 'secret' },
            },
          },
        },
      },
    },
  };
  const quoted = extractQuotedMessage(msg);
  assert.deepEqual(quoted, { conversation: 'secret' });
});

test('resolveViewOnceMedia: resolves imageMessage inside viewOnceMessageV2', () => {
  const quoted = {
    viewOnceMessageV2: {
      message: {
        imageMessage: {
          url: 'https://wa.net/img',
          mimetype: 'image/jpeg',
          caption: 'test caption',
          viewOnce: true,
        },
      },
    },
  };
  const media = resolveViewOnceMedia(quoted);
  assert.equal(media?.type, 'image');
  assert.equal(media?.caption, 'test caption');
});

test('resolveViewOnceMedia: resolves videoMessage inside viewOnceMessage', () => {
  const quoted = {
    viewOnceMessage: {
      message: {
        videoMessage: {
          url: 'https://wa.net/vid',
          mimetype: 'video/mp4',
          caption: 'video caption',
          viewOnce: true,
        },
      },
    },
  };
  const media = resolveViewOnceMedia(quoted);
  assert.equal(media?.type, 'video');
  assert.equal(media?.caption, 'video caption');
});

test('resolveViewOnceMedia: resolves audioMessage inside viewOnceMessageV2Extension', () => {
  const quoted = {
    viewOnceMessageV2Extension: {
      message: {
        audioMessage: {
          url: 'https://wa.net/audio',
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        },
      },
    },
  };
  const media = resolveViewOnceMedia(quoted);
  assert.equal(media?.type, 'audio');
  assert.equal(media?.ptt, true);
});

test('handleViewOnceCommand: rejects when no message is quoted with clear error', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };

  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: { conversation: '.vv' },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv' }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_quoted_message');
  assert.equal(reactions.includes('❌'), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Reply Required/i);
});

test('handleViewOnceCommand: rejects when quoted message has no media with clear error', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    CONFIG: { PREFIX: '.' },
  };

  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          quotedMessage: { conversation: 'just some text' },
        },
      },
    },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv' }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_media_found');
  assert.equal(reactions.includes('❌'), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /No Media Found/i);
});

test('handleViewOnceCommand: downloads and reveals view-once image in chat', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];

  const fakeImageBytes = Buffer.from('fake-jpeg-bytes');
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async (node, type) => {
      assert.equal(type, 'image');
      return (async function* () {
        yield fakeImageBytes;
      })();
    },
    CONFIG: { PREFIX: '.' },
  };

  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          quotedMessage: {
            viewOnceMessageV2: {
              message: {
                imageMessage: {
                  url: 'https://wa.net/img',
                  caption: 'my secret pic',
                },
              },
            },
          },
        },
      },
    },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv', sendToDm: false }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.type, 'image');
  assert.equal(reactions.includes('🌀'), true);
  assert.equal(reactions.includes('✅'), true);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].to, '123@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content.image, fakeImageBytes);
  assert.equal(sock.sent[0].content.caption, 'my secret pic');
});

test('handleViewOnceCommand: reports download failure with clear error', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];

  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async () => {
      throw new Error('410 Gone (Media Expired)');
    },
    CONFIG: { PREFIX: '.' },
  };

  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          quotedMessage: {
            viewOnceMessageV2: {
              message: {
                videoMessage: { url: 'https://wa.net/vid' },
              },
            },
          },
        },
      },
    },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv' }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'download_failed');
  assert.equal(reactions.includes('❌'), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Download Failed/i);
  assert.match(replies[0], /410 Gone/i);
});

test('handleViewOnceCommand (.vv2): delivers to sender DM in group chat', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];

  const fakeVideoBytes = Buffer.from('fake-mp4-bytes');
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async (node, type) => {
      assert.equal(type, 'video');
      return (async function* () {
        yield fakeVideoBytes;
      })();
    },
    isGroup: () => true,
    getSender: () => '2348011112222:1@s.whatsapp.net',
    CONFIG: { PREFIX: '.' },
  };

  const msg = {
    key: { remoteJid: 'group123@g.us', participant: '2348011112222:1@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv2',
        contextInfo: {
          quotedMessage: {
            viewOnceMessage: {
              message: {
                videoMessage: { url: 'https://wa.net/vid' },
              },
            },
          },
        },
      },
    },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv2', sendToDm: true, silent: true }, deps);
  assert.equal(res.ok, true);
  assert.equal(reactions.length, 0, 'vv2 must not react');

  // Delivered media to sender DM
  const dmMsg = sock.sent.find(s => s.to === '2348011112222@s.whatsapp.net');
  assert.ok(dmMsg, 'Media must be sent to sender DM');
  assert.deepEqual(dmMsg.content.video, fakeVideoBytes);

  // vv2 is silent: no confirmation text in the chat
  assert.equal(replies.length, 0, 'vv2 must not send chat text');
});

test('v41 Fix Pack: installs vv, viewonce, vv2 and aliases into registry', () => {
  const commands = new Map();
  const aliases = new Map();

  const ctx = {
    commands,
    aliases,
  };

  const result = installV41(ctx);
  assert.equal(result.v41, true);
  assert.equal(commands.has('vv'), true);
  assert.equal(commands.has('viewonce'), true);
  assert.equal(commands.has('vv2'), true);

  const vvEntry = commands.get('vv');
  assert.equal(vvEntry.__v41vv, true);
  assert.equal(typeof vvEntry.handler, 'function');

  const vv2Entry = commands.get('vv2');
  assert.equal(vv2Entry.__v41vv2, true);
  assert.equal(typeof vv2Entry.handler, 'function');

  assert.equal(aliases.get('viewonce'), 'vv');
  assert.equal(aliases.get('lol'), 'vv2');
  assert.equal(aliases.get('wow'), 'vv2');
});

test('handleViewOnceCommand: re-uploads media when WhatsApp drops its link', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const freshBytes = Buffer.from('fresh-jpeg-bytes');
  const reuploadCalls = [];
  sock.updateMediaMessage = async (waMsg) => {
    reuploadCalls.push(waMsg);
    waMsg.message.imageMessage.url = 'https://mmg.whatsapp.net/fresh';
    waMsg.message.imageMessage.directPath = '/v/fresh';
    return waMsg;
  };
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async () => {},
    downloadContentFromMessage: async (node) => {
      if (!node.url && !node.directPath) {
        throw new Error('No valid media URL or directPath present in message');
      }
      return (async function* () { yield freshBytes; })();
    },
    CONFIG: { PREFIX: '.' },
  };
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'ABC123',
          quotedMessage: {
            viewOnceMessageV2: { message: { imageMessage: { mediaKey: 'k', caption: 'pic' } } },
          },
        },
      },
    },
  };

  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv' }, deps);
  assert.equal(res.ok, true);
  assert.equal(reuploadCalls.length, 1);
  assert.equal(reuploadCalls[0].key.id, 'ABC123');
  assert.deepEqual(sock.sent[0].content.image, freshBytes);
  assert.equal(reactions.includes('✅'), true);
});

test('handleViewOnceCommand (.vv2): stays completely silent when the download fails', async () => {
  const sock = createMockSocket();
  const reactions = [];
  const replies = [];
  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async () => { throw new Error('410 Gone'); },
    CONFIG: { PREFIX: '.' },
  };
  const msg = {
    key: { remoteJid: 'group123@g.us', participant: '2348011112222@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv2',
        contextInfo: {
          quotedMessage: {
            viewOnceMessage: { message: { videoMessage: { url: 'https://wa.net/vid' } } },
          },
        },
      },
    },
  };
  const res = await handleViewOnceCommand(sock, msg, [], { cmdName: 'vv2', sendToDm: true, silent: true }, deps);
  assert.equal(res.ok, false);
  assert.equal(reactions.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(sock.sent.length, 0);
});
