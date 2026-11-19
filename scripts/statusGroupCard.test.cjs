'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../lib/statusGroupCard.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cards-'));
mod._setStoreDir(dir);

function fakeSock() {
  const sent = [];
  let n = 0;
  return {
    sent,
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, opts });
      n += 1;
      return { key: { id: `CARD${n}`, remoteJid: jid } };
    },
  };
}

async function* chunksOf(buf) { yield buf; }

const statusWithGroup = {
  key: { remoteJid: 'status@broadcast', id: 'STATUS1', participant: '2348000000000@s.whatsapp.net', fromMe: false },
  pushName: 'Alice',
  message: {
    imageMessage: {
      mimetype: 'image/jpeg',
      caption: 'hello',
      contextInfo: { groupMentions: [{ groupJid: '120363000000000001@g.us', groupSubject: 'Friends' }] },
    },
  },
};

(async () => {
  // Group mentions are read from contextInfo
  assert.deepStrictEqual(mod.extractGroupMentions(statusWithGroup.message), [
    { groupJid: '120363000000000001@g.us', groupSubject: 'Friends' },
  ]);
  assert.deepStrictEqual(mod.extractGroupMentions({ conversation: 'hi' }), []);

  // A status with no group tag does nothing
  const plain = { ...statusWithGroup, key: { ...statusWithGroup.key, id: 'PLAIN' }, message: { conversation: 'no tag' } };
  const sock = fakeSock();
  assert.strictEqual(await mod.handleStatusMessage(sock, plain, {}), false);
  assert.strictEqual(sock.sent.length, 0);

  // A tagged image status posts one card and keeps the media
  const download = async () => chunksOf(Buffer.from('IMAGE-BYTES'));
  assert.strictEqual(await mod.handleStatusMessage(sock, statusWithGroup, { download }), true);
  assert.strictEqual(sock.sent.length, 1);
  assert.strictEqual(sock.sent[0].jid, '120363000000000001@g.us');
  assert.strictEqual(sock.sent[0].content.text, '📢 *Alice* mentioned this group in a status');
  assert.ok(fs.existsSync(path.join(dir, 'STATUS1.jpg')));

  // Seeing the same status again posts nothing new
  assert.strictEqual(await mod.handleStatusMessage(sock, statusWithGroup, { download }), false);
  assert.strictEqual(sock.sent.length, 1);

  // Replying .fetch to the card sends the media back, quoting the reply
  const fetchMsg = {
    key: { remoteJid: '120363000000000001@g.us', id: 'FETCH1', participant: '2349000000000@s.whatsapp.net' },
    message: { extendedTextMessage: { text: '.fetch', contextInfo: { stanzaId: 'CARD1' } } },
  };
  const fetchSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(fetchSock, fetchMsg), true);
  assert.strictEqual(fetchSock.sent.length, 1);
  assert.ok(Buffer.isBuffer(fetchSock.sent[0].content.image));
  assert.strictEqual(fetchSock.sent[0].content.caption, 'hello');

  // Replying .fetch to the status itself (WhatsApp's native group-mention card) also works
  const statusReply = {
    key: { remoteJid: '120363000000000001@g.us', id: 'FETCH2', participant: '2349000000000@s.whatsapp.net' },
    message: { extendedTextMessage: { text: '.fetch', contextInfo: { stanzaId: 'STATUS1' } } },
  };
  const statusReplySock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(statusReplySock, statusReply), true);
  assert.ok(Buffer.isBuffer(statusReplySock.sent[0].content.image));

  // Replying .fetch to WhatsApp's native group-mention card sends the status media it carries
  mod._setDownloader(async () => chunksOf(Buffer.from('CARD-STATUS-IMAGE')));
  const nativeFetch = {
    key: { remoteJid: '120363000000000003@g.us', id: 'FETCH4', participant: '2349000000000@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.fetch',
        contextInfo: {
          stanzaId: 'NATIVE1',
          quotedMessage: { statusMentionMessage: { quotedStatus: { imageMessage: { mimetype: 'image/jpeg', caption: 'from card' } } } },
        },
      },
    },
  };
  const nativeSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(nativeSock, nativeFetch), true);
  assert.ok(Buffer.isBuffer(nativeSock.sent[0].content.image));
  assert.strictEqual(nativeSock.sent[0].content.caption, 'from card');

  // WhatsApp's groupStatusMentionMessage card only points at the status by id (protocol message).
  // The bot's stored copy of that status is sent back.
  const pointerFetch = (stanza, statusId, id) => ({
    key: { remoteJid: '120363000000000003@g.us', id, participant: '2349000000000@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.fetch',
        contextInfo: {
          stanzaId: stanza,
          quotedMessage: {
            groupStatusMentionMessage: {
              message: { protocolMessage: { type: 25, key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false } } },
            },
          },
        },
      },
    },
  });
  const pointerSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(pointerSock, pointerFetch('NATIVE2', 'STATUS1', 'FETCH5')), true);
  assert.ok(Buffer.isBuffer(pointerSock.sent[0].content.image));
  assert.strictEqual(pointerSock.sent[0].content.caption, 'hello');

  // A pointer to a status the bot never stored says it is unavailable; it never shows usage
  const goneSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(goneSock, pointerFetch('NATIVE3', 'GONE-STATUS', 'FETCH6')), true);
  assert.strictEqual(goneSock.sent[0].content.text, '⌛ Status expired or unavailable.');

  // The statusMentionMessage wrapper with a protocol pointer is also recognised
  const legacyPointer = pointerFetch('NATIVE4', 'STATUS1', 'FETCH7');
  legacyPointer.message.extendedTextMessage.contextInfo.quotedMessage = {
    statusMentionMessage: { message: { protocolMessage: { type: 25, key: { remoteJid: 'status@broadcast', id: 'STATUS1' } } } },
  };
  const legacySock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(legacySock, legacyPointer), true);
  assert.ok(Buffer.isBuffer(legacySock.sent[0].content.image));

  // A .fetch that is not a card reply falls through to the normal flow
  const plainFetch = { key: { remoteJid: 'x@g.us', id: 'F2' }, message: { extendedTextMessage: { text: '.fetch https://a.b' } } };
  assert.strictEqual(await mod.handleFetchReply(fetchSock, plainFetch), false);
  assert.strictEqual(fetchSock.sent.length, 1);

  // After 24 hours the card says the status expired and the media is removed
  const indexPath = path.join(dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  idx.CARD1.postedAt = Date.now() - mod.STATUS_TTL_MS - 1000;
  fs.writeFileSync(indexPath, JSON.stringify(idx));
  const expiredSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(expiredSock, fetchMsg), true);
  assert.strictEqual(expiredSock.sent[0].content.text, '⌛ Status expired.');
  assert.ok(!fs.existsSync(path.join(dir, 'STATUS1.jpg')));

  // A text-only tagged status is sent back as text
  const textStatus = {
    key: { remoteJid: 'status@broadcast', id: 'TEXT1', participant: '2348000000000@s.whatsapp.net' },
    pushName: 'Bob',
    message: { extendedTextMessage: { text: 'Party tonight', contextInfo: { groupMentions: [{ groupJid: '120363000000000002@g.us' }] } } },
  };
  const textSock = fakeSock();
  assert.strictEqual(await mod.handleStatusMessage(textSock, textStatus, {}), true);
  const textFetch = { key: { remoteJid: '120363000000000002@g.us', id: 'F3' }, message: { extendedTextMessage: { text: '.fetch', contextInfo: { stanzaId: 'CARD1' } } } };
  const textFetchSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(textFetchSock, textFetch), true);
  assert.strictEqual(textFetchSock.sent[0].content.text, 'Party tonight');

  console.log('statusGroupCard: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
