const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const edits = require('../precious-anime-edits.cjs');

test('edits/freefire.txt contains valid entries with direct CDN play links', () => {
  const filePath = path.join(__dirname, '..', '..', 'edits', 'freefire.txt');
  assert.ok(fs.existsSync(filePath), 'edits/freefire.txt should exist');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  assert.ok(lines.length > 20, `expected at least 20 freefire entries, got ${lines.length}`);
  const header = lines[0].split('\t');
  assert.strictEqual(header[5], 'video_url');
  assert.strictEqual(header[6], 'play_url');

  const row = lines[1].split('\t');
  assert.ok(row[5].startsWith('https://www.tiktok.com/'), 'video_url should be TikTok link');
  assert.ok(row[6].startsWith('http'), 'play_url should be http(s) direct link');
});

test('bot audio asset exists and is non-empty MP3', async () => {
  const buf = await edits.getBotAudioBuffer();
  assert.ok(buf && buf.length > 50000, `expected bot audio buffer > 50KB, got ${buf ? buf.length : 0}`);
  // Check MP3 header (ID3 or frame sync)
  const isId3 = buf.subarray(0, 3).toString('ascii') === 'ID3';
  const isSync = (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0);
  assert.ok(isId3 || isSync, 'expected valid MP3 header');
});

test('owner identification detects fromMe and owner.json JIDs, rejects strangers', () => {
  const selfMsg = { key: { fromMe: true } };
  const ownerMsg = { key: { fromMe: false, remoteJid: '2347032259096@s.whatsapp.net' } };
  const strangerMsg = { key: { fromMe: false, remoteJid: '123456789012@s.whatsapp.net' } };

  assert.strictEqual(edits.isOwnerMessage(null, selfMsg), true);
  assert.strictEqual(edits.isOwnerMessage(null, ownerMsg), true);
  assert.strictEqual(edits.isOwnerMessage(null, strangerMsg), false);
});

test('bot audio handler sends 🌀 -> audio -> ✅ with auto reaction clear', async () => {
  const reactions = [];
  const sent = [];
  const mockSock = {
    async sendMessage(jid, content) {
      if (content.react) {
        reactions.push(content.react.text);
      } else {
        sent.push({ jid, content });
      }
      return { key: { id: 'sent-1' } };
    }
  };

  const msg = { key: { remoteJid: '123@s.whatsapp.net', id: 'unit-test-1' } };
  await edits.handleBotAudio(mockSock, msg);

  assert.deepStrictEqual(reactions, ['🌀', '✅']);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].content.audio);
  assert.strictEqual(sent[0].content.mimetype, 'audio/mpeg');
});

test('attachSocket suppresses hi for owner, triggers for stranger, triggers .bot for both', async () => {
  const events = {};
  let reactions = [];
  let sent = [];
  const mockSock = {
    ev: {
      on(name, fn) { events[name] = fn; }
    },
    async sendMessage(jid, content) {
      if (content.react) reactions.push(content.react.text);
      else sent.push({ jid, content });
      return { key: { id: 'sent-2' } };
    }
  };

  edits.attachSocket(mockSock);
  const upsert = events['messages.upsert'];
  assert.strictEqual(typeof upsert, 'function');

  // 1. Owner says 'hi' -> silence
  await upsert({
    messages: [{
      key: { remoteJid: '2347032259096@s.whatsapp.net', id: 'm-owner-hi' },
      message: { conversation: 'hi' }
    }]
  });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(reactions.length, 0);

  // 2. Stranger says 'hi' -> triggers audio
  await upsert({
    messages: [{
      key: { remoteJid: '999888@s.whatsapp.net', id: 'm-stranger-hi' },
      message: { conversation: 'hi' }
    }]
  });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(reactions, ['🌀', '✅']);

  // 3. Owner says '.bot' -> triggers audio
  reactions = [];
  sent = [];
  await upsert({
    messages: [{
      key: { remoteJid: '2347032259096@s.whatsapp.net', id: 'm-owner-bot' },
      message: { conversation: '.bot' }
    }]
  });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(reactions, ['🌀', '✅']);
});
