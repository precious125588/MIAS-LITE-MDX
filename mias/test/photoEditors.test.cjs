const test = require('node:test');
const assert = require('node:assert');

test('Levanter photo editor commands and background removal registration and usage constraints', async (t) => {
  const registered = new Map();
  const mockCmd = (aliases, meta, handler) => {
    const names = Array.isArray(aliases) ? aliases : [aliases];
    for (const n of names) {
      registered.set(n, { meta, handler, primary: names[0] });
    }
  };

  const mockConfig = { PREFIX: '.' };
  const mockSendReply = async (sock, msg, text) => {
    msg.__replies = msg.__replies || [];
    msg.__replies.push(text);
  };
  const mockReact = async (sock, msg, emoji) => {
    msg.__reacts = msg.__reacts || [];
    msg.__reacts.push(emoji);
  };
  const mockDl = async () => null;
  const mockAxios = { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  const mockNx = { tools: {} };

  const initNexray = require('../mias_bot.cjs');
  initNexray(mockCmd, mockConfig, mockSendReply, mockReact, mockDl, mockAxios, mockNx);

  const requiredPhotoEditors = [
    'enhance', 'sketch', 'pencil', 'color', 'kiss',
    'bokeh', 'wanted', 'look', 'gandm', 'dark',
    'makeup', 'cartoon', 'demon', 'bloody', 'zombie',
    'horned', 'skull'
  ];

  await t.test('all 17 Levanter photo editor commands are registered', () => {
    for (const name of requiredPhotoEditors) {
      assert(registered.has(name), `Missing required photo editor command: ${name}`);
      const entry = registered.get(name);
      assert(typeof entry.handler === 'function', `Handler for ${name} must be a function`);
    }
  });

  await t.test('background removal aliases (rmbg, removebg, rmwbg, bgremove) are registered', () => {
    const bgCommands = ['rmbg', 'removebg', 'rmwbg', 'bgremove'];
    for (const name of bgCommands) {
      assert(registered.has(name), `Missing background removal command: ${name}`);
      const entry = registered.get(name);
      assert(typeof entry.handler === 'function', `Handler for ${name} must be a function`);
    }
  });

  await t.test('all command usages are at most two lines', async () => {
    const mockSock = { sendMessage: async () => {} };
    const allToTest = [...requiredPhotoEditors, 'rmbg', 'removebg', 'rmwbg'];
    for (const name of allToTest) {
      const entry = registered.get(name);
      const mockMsg = { key: { remoteJid: 'test@s.whatsapp.net' } };
      await entry.handler(mockSock, mockMsg, []);
      assert(mockMsg.__replies && mockMsg.__replies.length > 0, `Command ${name} sent no usage reply`);
      const reply = mockMsg.__replies[0];
      const lines = reply.trim().split('\n');
      assert(lines.length <= 2, `Command ${name} usage exceeded 2 lines: ${lines.length} lines -> ${reply}`);
    }
  });
});
