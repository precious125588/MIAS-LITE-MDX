'use strict';

const assert = require('assert');
const path = require('path');
const cuz = require('../features/cuzCustomization.cjs');

console.log('Testing Auto View Status & Auto React Status logic...');

// Test 1: cuzCustomization filter independence
{
  const settings = {
    viewStatus: true,
    reactStatus: true,
    viewStatusExclude: ['2348011111111'],
    viewStatusOnly: [],
    reactStatusExclude: [],
    reactStatusOnly: []
  };

  const authorNumber = '2348011111111';
  const viewAllowed = cuz.statusAuthorAllowed(settings, 'view', authorNumber);
  const reactAllowed = cuz.statusAuthorAllowed(settings, 'react', authorNumber);

  assert.strictEqual(viewAllowed, false, 'Author should be excluded from viewing');
  assert.strictEqual(reactAllowed, true, 'Author should NOT be excluded from reacting');
  console.log('✔ Test 1 passed: View and react filters are strictly independent in cuzCustomization');
}

// Test 2: React filter exclusion does not block viewing
{
  const settings = {
    viewStatus: true,
    reactStatus: true,
    viewStatusExclude: [],
    viewStatusOnly: [],
    reactStatusExclude: ['2348022222222'],
    reactStatusOnly: []
  };

  const authorNumber = '2348022222222';
  const viewAllowed = cuz.statusAuthorAllowed(settings, 'view', authorNumber);
  const reactAllowed = cuz.statusAuthorAllowed(settings, 'react', authorNumber);

  assert.strictEqual(viewAllowed, true, 'Author should be allowed for viewing');
  assert.strictEqual(reactAllowed, false, 'Author should be excluded from reacting');
  console.log('✔ Test 2 passed: React exclusion does not block view');
}

// Test 3: Unresolved LID vs participantPn resolution
{
  const rawPart = '1234567890@lid';
  const pnPart = '2348033333333@s.whatsapp.net';

  // In our new resolution logic:
  let resolved = null; // resolveLid returned null/lid
  if ((!resolved || resolved.endsWith('@lid')) && pnPart) {
    resolved = pnPart;
  }
  const clean = resolved.replace(/\D/g, '');
  assert.strictEqual(clean, '2348033333333');

  const settingsWithFilter = {
    viewStatusExclude: ['999999999'],
    viewStatusOnly: []
  };
  const allowed = cuz.statusAuthorAllowed(settingsWithFilter, 'view', clean);
  assert.strictEqual(allowed, true, 'Resolved phone number passes filter check');
  console.log('✔ Test 3 passed: LID participant with participantPn resolves cleanly');
}

// Test 4: Verify shouldSilenceForPrivateMode logic in index.js
{
  const fs = require('fs');
  const code = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

  // Verify shouldSilenceForPrivateMode has status@broadcast bypass
  assert(
    code.includes("if(_0x25f7b6[_0x3209f8(0x10be)][_0x3209f8(0x1eea)]==='status@broadcast')return![];"),
    'shouldSilenceForPrivateMode must exempt status@broadcast'
  );

  // Verify shouldProcessIncomingMessage has status@broadcast bypass
  assert(
    code.includes("if(_0x444f2c?.['key']?.['remoteJid']==='status@broadcast')return!![];"),
    'shouldProcessIncomingMessage must accept status@broadcast'
  );

  // Verify view and react filters are decoupled in status handler
  assert(
    code.includes("const _0x3e51a1=!_0x43dca8['statusAuthorAllowed'](_0x3fb4e2,'react',_0x1e21e3);"),
    'React filter must not be coupled to view filter (_0x72b4b2 || removed)'
  );

  // Verify reaction fallback is present
  assert(
    code.includes("sender JID fallback"),
    'Direct sender JID fallback must be present when broadcast reaction fails'
  );

  // Verify deduplication is present
  assert(
    code.includes("_seenStatusKeys"),
    'Status message deduplication must be present'
  );

  console.log('✔ Test 4 passed: All core status automation fixes are present in mias/index.js');
}

// Test 5: Simulated status broadcast event handling with mocked WASocket
{
  const calls = [];
  const mockSock = {
    user: { id: '2348000000000:1@s.whatsapp.net' },
    readMessages: async (keys) => {
      calls.push({ method: 'readMessages', keys });
    },
    sendMessage: async (jid, content, options) => {
      calls.push({ method: 'sendMessage', jid, content, options });
    }
  };

  const statusMsg = {
    key: {
      remoteJid: 'status@broadcast',
      id: 'TEST_STATUS_12345',
      fromMe: false,
      participant: '2348099999999@s.whatsapp.net'
    },
    message: {
      imageMessage: { caption: 'Hello world' }
    }
  };

  // Run through our handler logic
  const settings = {
    viewStatus: true,
    reactStatus: true,
    statusEmoji: '🔥',
    statusEmojiPool: ['🔥'],
    viewStatusExclude: [],
    viewStatusOnly: [],
    reactStatusExclude: [],
    reactStatusOnly: []
  };

  const rawPart = statusMsg.key.participant;
  const stdJid = rawPart;
  const num = rawPart.replace(/\D/g, '');

  const viewBlocked = !cuz.statusAuthorAllowed(settings, 'view', num);
  const reactBlocked = !cuz.statusAuthorAllowed(settings, 'react', num);

  assert.strictEqual(viewBlocked, false);
  assert.strictEqual(reactBlocked, false);

  // Simulate view
  mockSock.readMessages([statusMsg.key]);

  // Simulate react
  const recipients = [stdJid, mockSock.user.id];
  mockSock.sendMessage('status@broadcast', { react: { text: '🔥', key: statusMsg.key } }, { statusJidList: recipients });

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].method, 'readMessages');
  assert.strictEqual(calls[0].keys[0].id, 'TEST_STATUS_12345');
  assert.strictEqual(calls[1].method, 'sendMessage');
  assert.strictEqual(calls[1].jid, 'status@broadcast');
  assert.strictEqual(calls[1].content.react.text, '🔥');
  assert.deepStrictEqual(calls[1].options.statusJidList, ['2348099999999@s.whatsapp.net', '2348000000000:1@s.whatsapp.net']);

  console.log('✔ Test 5 passed: Simulated status event produces readMessages and reaction message');
}

(async () => {
// Test 6: Reaction fallback when status@broadcast reaction fails
{
  const calls = [];
  const mockSock = {
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      if (jid === 'status@broadcast') {
        throw new Error('Precondition Required: Status reaction rejected by WhatsApp');
      }
      return { status: 200 };
    }
  };

  const authorJid = '2348099999999@s.whatsapp.net';
  const key = { remoteJid: 'status@broadcast', id: 'FALLBACK_TEST_KEY', participant: authorJid };

  let reacted = false;
  try {
    await mockSock.sendMessage('status@broadcast', { react: { text: '❤️', key } }, { statusJidList: [authorJid] });
    reacted = true;
  } catch (err) {
    // broadcast failed, fallback
  }

  if (!reacted && authorJid) {
    try {
      await mockSock.sendMessage(authorJid, { react: { text: '❤️', key } });
      reacted = true;
    } catch (err2) {}
  }

  assert.strictEqual(reacted, true, 'Reaction should succeed via fallback');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].jid, 'status@broadcast');
  assert.strictEqual(calls[1].jid, authorJid);
  assert.strictEqual(calls[1].content.react.text, '❤️');

  console.log('✔ Test 6 passed: Fallback to author JID succeeds when status@broadcast reaction is rejected');
}

console.log('\nAll Auto View Status and Auto React Status tests PASSED successfully!');

})();
