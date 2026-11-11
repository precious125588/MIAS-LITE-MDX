'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isGroupJid,
  canExecuteLeave,
  handleLeaveCommand,
} = require('../../lib/leaveCommand.cjs');
const installV40 = require('../precious-fixes-v40.cjs');

function createMockSocket(options = {}) {
  const sent = [];
  const modified = [];
  const leftGroups = [];
  const revokedInvites = [];
  const settingUpdates = [];
  const participantUpdates = [];
  const reactions = [];

  return {
    user: { id: options.botId || '2348000000001@s.whatsapp.net', lid: '11111111111111@lid' },
    sent,
    modified,
    leftGroups,
    revokedInvites,
    settingUpdates,
    participantUpdates,
    reactions,
    async sendMessage(to, content, opts) {
      sent.push({ to, content, opts });
      if (content?.react) {
        reactions.push({ to, text: content.react.text });
      }
      return { key: { id: 'sent_' + sent.length, remoteJid: to } };
    },
    async chatModify(mod, jid) {
      modified.push({ mod, jid });
      if (options.chatModifyThrows) throw new Error(options.chatModifyThrows);
      return true;
    },
    async groupLeave(jid) {
      leftGroups.push(jid);
      if (options.groupLeaveThrows) throw new Error(options.groupLeaveThrows);
      return true;
    },
    async groupRevokeInvite(jid) {
      revokedInvites.push(jid);
      return 'newcode123';
    },
    async groupSettingUpdate(jid, setting) {
      settingUpdates.push({ jid, setting });
      return true;
    },
    async groupParticipantsUpdate(jid, participants, action) {
      participantUpdates.push({ jid, participants, action });
      return true;
    },
    async groupMetadata(jid) {
      if (options.groupMeta) return options.groupMeta;
      return {
        id: jid,
        subject: 'Test Squad',
        participants: options.participants || [
          { id: '2348000000001@s.whatsapp.net', admin: options.botIsAdmin ? 'admin' : null },
          { id: '2348000000002@s.whatsapp.net', admin: 'admin' },
          { id: '2348000000003@s.whatsapp.net', admin: null },
        ],
      };
    },
  };
}

test('isGroupJid: correctly identifies group and non-group JIDs', () => {
  assert.equal(isGroupJid('123456789-987654@g.us'), true);
  assert.equal(isGroupJid('2348000000001@s.whatsapp.net'), false);
  assert.equal(isGroupJid('11111111111111@lid'), false);
  assert.equal(isGroupJid(''), false);
  assert.equal(isGroupJid(null), false);
});

test('canExecuteLeave: allows bot itself (fromMe)', async () => {
  const sock = createMockSocket();
  const msg = { key: { fromMe: true, remoteJid: '123@g.us' } };
  const allowed = await canExecuteLeave(sock, msg, '123@g.us', '2348000000001@s.whatsapp.net');
  assert.equal(allowed, true);
});

test('canExecuteLeave: allows owner number from config', async () => {
  const sock = createMockSocket();
  const msg = { key: { fromMe: false, remoteJid: '123@g.us' } };
  const deps = { CONFIG: { OWNER_NUMBER: '2348123456789' } };
  const allowed = await canExecuteLeave(sock, msg, '123@g.us', '2348123456789@s.whatsapp.net', deps);
  assert.equal(allowed, true);
});

test('canExecuteLeave: allows sudo user from deps.isSudo', async () => {
  const sock = createMockSocket();
  const msg = { key: { fromMe: false, remoteJid: '123@g.us' } };
  const deps = { isSudo: jid => jid.includes('99999') };
  const allowed = await canExecuteLeave(sock, msg, '123@g.us', '99999@s.whatsapp.net', deps);
  assert.equal(allowed, true);
});

test('canExecuteLeave: allows group admin', async () => {
  const sock = createMockSocket({
    participants: [
      { id: '2348000000002@s.whatsapp.net', admin: 'admin' },
      { id: '2348000000003@s.whatsapp.net', admin: null },
    ],
  });
  const msg = { key: { fromMe: false, remoteJid: '123@g.us' } };
  const allowed = await canExecuteLeave(sock, msg, '123@g.us', '2348000000002@s.whatsapp.net');
  assert.equal(allowed, true);
});

test('canExecuteLeave: denies regular non-admin member', async () => {
  const sock = createMockSocket({
    participants: [
      { id: '2348000000002@s.whatsapp.net', admin: 'admin' },
      { id: '2348000000003@s.whatsapp.net', admin: null },
    ],
  });
  const msg = { key: { fromMe: false, remoteJid: '123@g.us' } };
  const allowed = await canExecuteLeave(sock, msg, '123@g.us', '2348000000003@s.whatsapp.net');
  assert.equal(allowed, false);
});

test('handleLeaveCommand: rejects non-group chat', async () => {
  const sock = createMockSocket();
  const msg = { key: { remoteJid: '2348000000002@s.whatsapp.net' } };
  const res = await handleLeaveCommand(sock, msg, []);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_a_group');
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].content.text, /only be used in groups/i);
});

test('handleLeaveCommand: rejects unauthorized user with clear denial', async () => {
  const sock = createMockSocket({
    participants: [
      { id: '2348000000002@s.whatsapp.net', admin: 'admin' },
      { id: '2348000000003@s.whatsapp.net', admin: null },
    ],
  });
  const msg = {
    key: { remoteJid: '12345@g.us', participant: '2348000000003@s.whatsapp.net' },
  };
  const res = await handleLeaveCommand(sock, msg, []);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unauthorized');
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].content.text, /Access Denied/i);
  assert.equal(sock.leftGroups.length, 0);
});

test('handleLeaveCommand (non-admin bot): leaves group and deletes chat immediately', async () => {
  const sock = createMockSocket({ botIsAdmin: false });
  const msg = {
    key: { remoteJid: '12345@g.us', participant: '2348000000002@s.whatsapp.net', id: 'M1' },
    messageTimestamp: 1700000000,
  };
  const reactions = [];
  const deps = {
    react: async (s, m, r) => reactions.push(r),
  };

  const res = await handleLeaveCommand(sock, msg, [], deps);
  assert.equal(res.ok, true);
  assert.equal(res.isGroup, true);
  assert.equal(res.isBotAdmin, false);
  assert.equal(res.left, true);
  assert.equal(res.deleted, true);

  // Verifications
  assert.equal(reactions.includes('👋'), true);
  assert.equal(sock.leftGroups.includes('12345@g.us'), true);
  assert.equal(sock.modified.some(m => m.mod?.delete === true && m.jid === '12345@g.us'), true);

  // Private confirmation sent to the admin who called the command
  assert.equal(sock.sent.some(s => s.to === '2348000000002@s.whatsapp.net' && /Group Left & Deleted/i.test(s.content?.text)), true);
});

test('handleLeaveCommand (admin bot): disbands group, revokes invite, removes members, leaves & deletes chat', async () => {
  const sock = createMockSocket({
    botIsAdmin: true,
    participants: [
      { id: '2348000000001@s.whatsapp.net', admin: 'admin' }, // bot
      { id: '2348000000002@s.whatsapp.net', admin: 'admin' }, // issuer
      { id: '2348000000003@s.whatsapp.net', admin: null },    // regular
    ],
  });
  const msg = {
    key: { remoteJid: '99999@g.us', participant: '2348000000002@s.whatsapp.net', id: 'M2' },
    messageTimestamp: 1700000000,
  };

  const res = await handleLeaveCommand(sock, msg, []);
  assert.equal(res.ok, true);
  assert.equal(res.isBotAdmin, true);
  assert.equal(res.left, true);
  assert.equal(res.deleted, true);

  // Revoked invite
  assert.equal(sock.revokedInvites.includes('99999@g.us'), true);

  // Locked settings
  assert.equal(sock.settingUpdates.some(u => u.setting === 'announcement'), true);
  assert.equal(sock.settingUpdates.some(u => u.setting === 'locked'), true);

  // Removed other participants
  assert.equal(sock.participantUpdates.some(u => u.action === 'remove' && u.participants.includes('2348000000003@s.whatsapp.net')), true);

  // Left group and deleted chat
  assert.equal(sock.leftGroups.includes('99999@g.us'), true);
  assert.equal(sock.modified.some(m => m.mod?.delete === true && m.jid === '99999@g.us'), true);
});

test('v40 Fix Pack: installs leave command and all aliases into registry', () => {
  const commands = new Map();
  const aliases = new Map();
  const registeredCmds = [];

  const ctx = {
    commands,
    aliases,
    cmd: (names, meta, handler) => registeredCmds.push({ names, meta, handler }),
  };

  const result = installV40(ctx);
  assert.equal(result.v40, true);
  assert.deepEqual(result.installed, ['leave', 'leavegc', 'deletegc', 'out', 'left']);

  // Check commands map
  for (const name of ['leave', 'leavegc', 'deletegc', 'out', 'left']) {
    assert.equal(commands.has(name), true);
    const entry = commands.get(name);
    assert.equal(entry.__v40leave, true);
    assert.equal(typeof entry.handler, 'function');
  }

  // Check aliases map
  for (const name of ['leavegc', 'deletegc', 'out', 'left']) {
    assert.equal(aliases.get(name), 'leave');
  }
});
