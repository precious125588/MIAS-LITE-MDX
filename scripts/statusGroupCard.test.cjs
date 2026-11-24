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

  // Mentioned group JID in mentionedJid array is also recognized
  const mentionJidStatus = {
    message: {
      imageMessage: {
        contextInfo: { mentionedJid: ['120363999999999999@g.us', '2348000000000@s.whatsapp.net'] },
      },
    },
  };
  assert.deepStrictEqual(mod.extractGroupMentions(mentionJidStatus.message), [
    { groupJid: '120363999999999999@g.us', groupSubject: '' },
  ]);

  // statusMentionMessageInfo with statusId pointer
  const infoPointerFetch = {
    key: { remoteJid: '120363000000000003@g.us', id: 'FETCH_INFO_1', participant: '2349000000000@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.fetch',
        contextInfo: {
          stanzaId: 'NATIVE_INFO',
          quotedMessage: {
            statusMentionMessageInfo: { statusId: 'STATUS1' },
          },
        },
      },
    },
  };
  const infoSock = fakeSock();
  assert.strictEqual(await mod.handleFetchReply(infoSock, infoPointerFetch), true);
  assert.ok(Buffer.isBuffer(infoSock.sent[0].content.image));

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


  // --- Target status fetch tests (.fetch <target_number>) ---
  console.log('running target status fetch tests...');

  // 1. Target extraction tests
  assert.strictEqual(mod.extractTarget(null, ['2349068551055']).phone, '2349068551055');
  assert.strictEqual(mod.extractTarget(null, ['+2349068551055']).phone, '2349068551055');
  assert.strictEqual(mod.extractTarget(null, ['@2349068551055']).phone, '2349068551055');
  assert.strictEqual(mod.extractTarget(null, ['234', '906', '855', '1055']).phone, '2349068551055');
  assert.strictEqual(mod.extractTarget(null, ['09068551055']).phone, '09068551055');
  assert.strictEqual(mod.extractTarget(null, ['https://catbox.moe/file.mp4']), null);
  assert.strictEqual(mod.extractTarget(null, ['tmpfiles.org/dl/12345']), null);
  assert.strictEqual(mod.extractTarget(null, ['example.com']), null);

  // 2. Incoming statuses from target 2349068551055
  const targetSock = fakeSock();
  const downloadMock = async (content, kind) => (async function* () { yield Buffer.from('TARGET_MEDIA_' + kind); })();

  // Status 1: Photo
  const targetStatus1 = {
    key: { remoteJid: 'status@broadcast', id: 'TSTAT_1', participant: '2349068551055@s.whatsapp.net' },
    pushName: 'Mercy',
    message: { imageMessage: { caption: 'Sunset view', mimetype: 'image/jpeg' } },
  };
  await mod.handleStatusMessage(targetSock, targetStatus1, { download: downloadMock });

  // Status 2: Text status
  const targetStatus2 = {
    key: { remoteJid: 'status@broadcast', id: 'TSTAT_2', participant: '2349068551055@s.whatsapp.net' },
    pushName: 'Mercy',
    message: { extendedTextMessage: { text: 'Coding all day' } },
  };
  await mod.handleStatusMessage(targetSock, targetStatus2, { download: downloadMock });

  // Status 3: Video
  const targetStatus3 = {
    key: { remoteJid: 'status@broadcast', id: 'TSTAT_3', participant: '2349068551055@s.whatsapp.net' },
    pushName: 'Mercy',
    message: { videoMessage: { caption: 'Check this out', mimetype: 'video/mp4' } },
  };
  await mod.handleStatusMessage(targetSock, targetStatus3, { download: downloadMock });

  // Test findStatusesByTarget
  const currentIdx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const found = mod.findStatusesByTarget(currentIdx, '2349068551055');
  assert.strictEqual(found.length, 3, 'Should find all 3 statuses for 2349068551055');
  assert.strictEqual(found[0].statusId, 'TSTAT_1');
  assert.strictEqual(found[1].statusId, 'TSTAT_2');
  assert.strictEqual(found[2].statusId, 'TSTAT_3');

  // Test local format (09068551055) finding international format (2349068551055)
  const foundLocal = mod.findStatusesByTarget(currentIdx, '09068551055');
  assert.strictEqual(foundLocal.length, 3, 'Local 09068551055 should find statuses of 2349068551055');

  // A status may arrive under an opaque LID; match it to the saved contact name.
  const lidStatusIndex = {
    LID_STATUS: {
      statusId: 'LID_STATUS',
      postedAt: Date.now(),
      senderPhone: '123456789012345',
      senderJid: '123456789012345@lid',
      poster: 'Just Xavier',
      kind: 'text',
      rawContent: 'LID status'
    }
  };
  const savedContacts = new Map([['2349068551055', 'Just Xavier']]);
  assert.strictEqual(
    mod.findStatusesByTarget(lidStatusIndex, '2349068551055', { contacts: savedContacts }).length,
    1,
    'Saved contact name should match status posted with an opaque LID'
  );

  // Test handleFetchTargetStatus
  const userFetchCmdMsg = {
    key: { remoteJid: '120363000000000001@g.us', id: 'USER_FETCH_MSG' },
    message: { conversation: '.fetch 2349068551055' },
  };
  const execSock = fakeSock();
  const handled = await mod.handleFetchTargetStatus(execSock, userFetchCmdMsg, ['2349068551055'], { download: downloadMock });
  assert.strictEqual(handled, true, 'handleFetchTargetStatus should return true for target number');

  // Verify delivery:
  // sent[0]: Initial header notice ('Fetching 3 status updates from Mercy...')
  // sent[1]: Status 1 (image)
  // sent[2]: Status 2 (text)
  // sent[3]: Status 3 (video)
  // Filter out react messages to check delivered content
  const contentMessages = execSock.sent.filter(s => !s.content.react);
  assert.ok(contentMessages.length >= 4, 'Should deliver header + all 3 statuses');
  assert.ok(contentMessages[0].content.text.includes('Fetching 3 status updates'), 'Header should mention 3 statuses');
  assert.ok(Buffer.isBuffer(contentMessages[1].content.image), 'Status 1 should be an image buffer');
  assert.ok(contentMessages[1].content.caption.includes('Sunset view'), 'Status 1 should have caption');
  assert.ok(contentMessages[2].content.text.includes('Coding all day'), 'Status 2 should have text body');
  assert.ok(Buffer.isBuffer(contentMessages[3].content.video), 'Status 3 should be a video buffer');
  assert.ok(contentMessages[3].content.caption.includes('Check this out'), 'Status 3 should have caption');

  // Test URL fetch returns false (so URL flow runs unchanged)
  const urlMsg = {
    key: { remoteJid: '120363000000000001@g.us', id: 'URL_MSG' },
    message: { conversation: '.fetch https://catbox.moe/abc.mp4' },
  };
  const urlHandled = await mod.handleFetchTargetStatus(execSock, urlMsg, ['https://catbox.moe/abc.mp4'], {});
  assert.strictEqual(urlHandled, false, 'handleFetchTargetStatus should return false for URLs');

  // Test unknown target returns clean not found message
  const notFoundSock = fakeSock();
  const notFoundMsg = {
    key: { remoteJid: '120363000000000001@g.us', id: 'NF_MSG' },
    message: { conversation: '.fetch 1112223334444' },
  };
  const nfHandled = await mod.handleFetchTargetStatus(notFoundSock, notFoundMsg, ['1112223334444'], {});
  assert.strictEqual(nfHandled, true, 'handleFetchTargetStatus handles target even if not found');
  const nfTextMsg = notFoundSock.sent.find(s => s.content.text);
  assert.ok(nfTextMsg && nfTextMsg.content.text.includes('No active status found'), 'Should report no active status found');

  console.log('target status fetch tests passed!');

  
  // Test name-based target extraction (e.g. "@⁨Just Xavier...⁩" or "Just Xavier")
  console.log('running name-based target extraction tests...');
  const nameTarget = mod.extractTarget(null, ['@⁨Just Xavier...⁩'], {
    contacts: new Map([['2349068551055', 'Just Xavier']])
  });
  assert.ok(nameTarget, 'Should resolve target from contact name mention');
  assert.strictEqual(nameTarget.phone, '2349068551055', 'Resolved phone should match contact');

  // Test plain name argument
  const plainNameTarget = mod.extractTarget(null, ['Just', 'Xavier'], {
    contacts: new Map([['2349068551055', 'Just Xavier']])
  });
  assert.ok(plainNameTarget, 'Should resolve target from plain name argument');
  assert.strictEqual(plainNameTarget.phone, '2349068551055');

  console.log('statusGroupCard: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Test matching when target has matchedName (e.g. from VCF or contacts map)
{
  const card = require('../lib/statusGroupCard.cjs');
  const index = {
    s1: {
      statusId: 'status-lid-1',
      postedAt: Date.now() - 1000,
      kind: 'text',
      caption: 'Hello from Just Xavier',
      poster: 'Just Xavier...',
      senderPhone: '123456789012345', // opaque LID digits
      senderJid: '123456789012345@lid',
    }
  };

  const target = {
    phone: '2348123456789',
    jid: '2348123456789@s.whatsapp.net',
    matchedName: 'Just Xavier...'
  };

  const results = card.findStatusesByTarget(index, target, {});
  assert.strictEqual(results.length, 1, 'Should match status by target.matchedName against poster');
  assert.strictEqual(results[0].statusId, 'status-lid-1');
  console.log('target.matchedName LID matching test passed!');
}
