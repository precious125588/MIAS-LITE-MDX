const test = require('node:test');
const assert = require('node:assert/strict');
const installV38 = require('../precious-fixes-v38.cjs');

function setup() {
  const calls = [];
  const commands = new Map([['sudo', { handler: async () => calls.push('ran') }]]);
  const ctx = {
    commands,
    CONFIG: { OWNER_NUMBER: '15550000000', OWNER_JID: '15550000000@s.whatsapp.net' },
    isSudo: (jid) => jid === '15551111111@s.whatsapp.net',
  };
  globalThis.__PRECIOUS__ = ctx;
  globalThis.__MIAS_COMMANDS__ = commands;
  globalThis.__V38_INSTALLED__ = false;
  globalThis.__miasGetSender = (msg) => msg.key.participant || msg.key.remoteJid;
  installV38(ctx);
  return { handler: commands.get('sudo').handler, calls };
}

test('sudo command allows owner but blocks a sudo user from granting access', async () => {
  const { handler, calls } = setup();
  const replies = [];
  const sock = { sendMessage: async (_jid, message) => replies.push(message.text) };

  await handler(sock, { key: { remoteJid: '15550000000@s.whatsapp.net', participant: '15550000000@s.whatsapp.net' } }, []);
  assert.deepEqual(calls, ['ran']);

  await handler(sock, { key: { remoteJid: '15551111111@s.whatsapp.net', participant: '15551111111@s.whatsapp.net' } }, []);
  assert.deepEqual(calls, ['ran']);
  assert.match(replies.at(-1), /Owner only/);
});
