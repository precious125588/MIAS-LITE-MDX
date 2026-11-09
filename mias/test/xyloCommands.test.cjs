'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handlePinCommand,
  handleMessagePinCommand,
  handleUnpinCommand,
  handlePinChatCommand,
  handleUnpinChatCommand,
} = require('../../lib/pinCommand.cjs');
const { handleSetBio } = require('../../lib/bioCommand.cjs');

function createMockSocket(options = {}) {
  const sent = [];
  const modified = [];
  const statusUpdates = [];

  return {
    user: { id: '2348000000001@s.whatsapp.net', lid: '11111111111111@lid' },
    sent,
    modified,
    statusUpdates,
    async sendMessage(to, content, opts) {
      sent.push({ to, content, opts });
      return { key: { id: 'sent_' + sent.length } };
    },
    async chatModify(mod, jid) {
      modified.push({ mod, jid });
      if (options.chatModifyThrows) throw new Error(options.chatModifyThrows);
      return true;
    },
    async updateProfileStatus(text) {
      statusUpdates.push(text);
      if (options.updateStatusThrows) throw new Error(options.updateStatusThrows);
      return true;
    },
    async groupMetadata(jid) {
      return {
        id: jid,
        participants: [
          { id: '2348000000002@s.whatsapp.net', admin: 'admin' },
          { id: '2348000000003@s.whatsapp.net', admin: null },
        ],
      };
    },
  };
}

test('setbio: prompts when bio is missing', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };
  await handleSetBio(sock, msg, []);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✏️ Please provide a bio to set.');
});

test('setbio: rejects bio exceeding 139 characters', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };
  const longBio = 'a'.repeat(140);
  await handleSetBio(sock, msg, [longBio]);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '❌ Bio too long (max 139 characters).');
});

test('setbio: successfully updates bio and replies with success message', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };
  await handleSetBio(sock, msg, ['MIAS', 'IS', 'ONLINE']);
  assert.deepEqual(sock.statusUpdates, ['MIAS IS ONLINE']);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✅ Bio updated successfully!');
});

test('setbio: handles errors gracefully', async () => {
  const sock = createMockSocket({ updateStatusThrows: 'Network error' });
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };
  await handleSetBio(sock, msg, ['Hello']);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '❌ Failed to update bio: Network error');
});

test('pin: prompts when no message is quoted', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'pin' } };
  await handleMessagePinCommand(sock, msg, []);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✖ Reply to a message to pin it.');
});

test('pin: group non-admin receives Admin only', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123456@g.us', participant: '2348000000003@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.pin',
        contextInfo: { stanzaId: 'msg_to_pin_01', participant: '2348000000004@s.whatsapp.net' },
      },
    },
  };
  await handleMessagePinCommand(sock, msg, []);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✖ Admin only.');
});

test('pin: group admin successfully pins message with Baileys pin payload', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123456@g.us', participant: '2348000000002@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.pin',
        contextInfo: { stanzaId: 'msg_to_pin_02', participant: '2348000000004@s.whatsapp.net' },
      },
    },
  };
  const res = await handleMessagePinCommand(sock, msg, []);
  assert.equal(res.ok, true);
  assert.equal(sock.sent.length, 2);
  assert.deepEqual(sock.sent[0].content, {
    pin: {
      remoteJid: '123456@g.us',
      fromMe: false,
      id: 'msg_to_pin_02',
      participant: '2348000000004@s.whatsapp.net',
    },
    type: 1,
  });
  assert.equal(sock.sent[1].content.text, '✔ Message pinned.');
});

test('unpin: prompts when no message is quoted', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'unpin' } };
  await handleUnpinCommand(sock, msg, []);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✖ Reply to a pinned message to unpin it.');
});

test('unpin: group admin unpins message with type 2', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123456@g.us', participant: '2348000000002@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.unpin',
        contextInfo: { stanzaId: 'msg_to_unpin_01', participant: '2348000000004@s.whatsapp.net' },
      },
    },
  };
  const res = await handleUnpinCommand(sock, msg, []);
  assert.equal(res.ok, true);
  assert.equal(sock.sent.length, 2);
  assert.deepEqual(sock.sent[0].content, {
    pin: {
      remoteJid: '123456@g.us',
      fromMe: false,
      id: 'msg_to_unpin_01',
      participant: '2348000000004@s.whatsapp.net',
    },
    type: 2,
  });
  assert.equal(sock.sent[1].content.text, '✔ Message unpinned.');
});

test('pinchat: non-owner receives Only owners can pin', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net', fromMe: false },
  };
  await handlePinChatCommand(sock, msg, []);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '✖ Only owners can pin.');
});

test('pinchat: owner pins chat successfully', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net', fromMe: true },
  };
  const res = await handlePinChatCommand(sock, msg, []);
  assert.equal(res.ok, true);
  assert.deepEqual(sock.modified, [{ mod: { pin: true }, jid: '123@s.whatsapp.net' }]);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '◆ Chat pinned.');
});

test('unpinchat: owner unpins chat successfully', async () => {
  const sock = createMockSocket();
  const msg = {
    key: { remoteJid: '123@s.whatsapp.net', fromMe: true },
  };
  const res = await handleUnpinChatCommand(sock, msg, []);
  assert.equal(res.ok, true);
  assert.deepEqual(sock.modified, [{ mod: { pin: false }, jid: '123@s.whatsapp.net' }]);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.text, '◆ Chat unpinned.');
});
