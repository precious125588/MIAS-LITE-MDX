import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readLocalCommit } from '../features/updateCommand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const require = createRequire(import.meta.url);

test('Railway update check: lib/precious-build-stamp.json takes precedence over stale RAILWAY_GIT_COMMIT_SHA', () => {
  const origEnv = process.env.RAILWAY_GIT_COMMIT_SHA;
  const stampPath = path.join(REPO_ROOT, 'lib', 'precious-build-stamp.json');
  const origStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;

  try {
    const staleSha = '1111111111111111111111111111111111111111';
    const updatedSha = '2222222222222222222222222222222222222222';

    // Simulate Railway container environment
    process.env.RAILWAY_GIT_COMMIT_SHA = staleSha;

    // Simulate update installed and written to build-stamp
    const testStamp = {
      sha: updatedSha,
      commit: updatedSha,
      buildSha: updatedSha,
      message: 'New update installed',
    };
    fs.writeFileSync(stampPath, JSON.stringify(testStamp, null, 2), 'utf8');

    // Temporarily hide .git if running inside git repo
    const gitHead = path.join(REPO_ROOT, '.git', 'HEAD');
    let gitHeadBackup = null;
    if (fs.existsSync(gitHead)) {
      gitHeadBackup = fs.readFileSync(gitHead, 'utf8');
      fs.renameSync(gitHead, gitHead + '.tmp_test');
    }

    try {
      const commit = readLocalCommit();
      assert.equal(commit.sha, updatedSha, 'Should read updatedSha from build-stamp, not stale Railway env');
      assert.equal(commit.source, 'build-stamp', 'Source should be build-stamp');
    } finally {
      if (gitHeadBackup !== null) {
        fs.renameSync(gitHead + '.tmp_test', gitHead);
      }
    }
  } finally {
    process.env.RAILWAY_GIT_COMMIT_SHA = origEnv;
    if (origStamp !== null) {
      fs.writeFileSync(stampPath, origStamp, 'utf8');
    }
  }
});

test('build-sync: readLocalSha prioritizes build-stamp over stale platform env', async () => {
  const origEnv = process.env.RAILWAY_GIT_COMMIT_SHA;
  const stampPath = path.join(REPO_ROOT, 'lib', 'precious-build-stamp.json');
  const origStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;

  try {
    const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const updatedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    process.env.RAILWAY_GIT_COMMIT_SHA = staleSha;

    fs.writeFileSync(
      stampPath,
      JSON.stringify({ sha: updatedSha, commit: updatedSha }, null, 2),
      'utf8'
    );

    const gitHead = path.join(REPO_ROOT, '.git', 'HEAD');
    let gitHeadBackup = null;
    if (fs.existsSync(gitHead)) {
      gitHeadBackup = fs.readFileSync(gitHead, 'utf8');
      fs.renameSync(gitHead, gitHead + '.tmp_test');
    }

    try {
      const buildSyncPath = path.join(REPO_ROOT, 'lib', 'build-sync.cjs');
      const content = fs.readFileSync(buildSyncPath, 'utf8');
      const stampIdx = content.indexOf("source: 'build-stamp'");
      const envIdx = content.indexOf("const envSha = process.env.RAILWAY_GIT_COMMIT_SHA");
      assert.ok(stampIdx > 0 && envIdx > 0, 'Both build-stamp and env should exist in build-sync');
      assert.ok(stampIdx < envIdx, 'build-stamp check must come before platform env check');
    } finally {
      if (gitHeadBackup !== null) {
        fs.renameSync(gitHead + '.tmp_test', gitHead);
      }
    }
  } finally {
    process.env.RAILWAY_GIT_COMMIT_SHA = origEnv;
    if (origStamp !== null) {
      fs.writeFileSync(stampPath, origStamp, 'utf8');
    }
  }
});

test('viewOnceCommand: Levanter relay fallback successfully reveals when buffer download fails', async () => {
  const viewOnceCmd = require('../../lib/viewOnceCommand.cjs');

  const relayed = [];
  const reactions = [];
  const replies = [];

  const mockSocket = {
    user: { id: '2348000000000@s.whatsapp.net' },
    generateMessageTag: () => 'tag_123',
    async relayMessage(jid, content, opts) {
      relayed.push({ jid, content, opts });
      return true;
    },
    async sendMessage(jid, content, opts) {
      return { key: { id: 'sent_1' } };
    },
  };

  const mockMsg = {
    key: { remoteJid: '123456789@g.us', id: 'cmd_msg_1', participant: '2348000000001@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '.vv',
        contextInfo: {
          stanzaId: 'vo_target_1',
          participant: '2348000000002@s.whatsapp.net',
          quotedMessage: {
            viewOnceMessageV2: {
              message: {
                imageMessage: {
                  url: 'https://example.com/expired',
                  mediaKey: Buffer.from('12345678901234567890123456789012'),
                  mimetype: 'image/jpeg',
                  viewOnce: true,
                },
              },
            },
          },
        },
      },
    },
  };

  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async () => {
      throw new Error('410 Gone (Media Expired)');
    },
    CONFIG: { PREFIX: '.' },
  };

  const res = await viewOnceCmd.handleViewOnceCommand(mockSocket, mockMsg, [], { cmdName: 'vv' }, deps);
  assert.equal(res.ok, true, 'Should succeed via Levanter relay fallback');
  assert.equal(res.mode, 'relay', 'Mode should be relay');
  assert.equal(reactions.includes('✅'), true, 'Should react with checkmark on success');
  assert.equal(relayed.length, 1, 'Should have relayed one message');
  assert.equal(relayed[0].jid, '123456789@g.us', 'Should relay to the current chat');
  assert.equal(relayed[0].content.imageMessage.viewOnce, false, 'viewOnce flag should be stripped');
});

test('viewOnceCommand (.vv2): silent Levanter relay delivers directly to owner DM and makes NO noise in chat', async () => {
  const viewOnceCmd = require('../../lib/viewOnceCommand.cjs');

  const relayed = [];
  const reactions = [];
  const replies = [];

  const mockSocket = {
    user: { id: '2348000000000:1@s.whatsapp.net' },
    generateMessageTag: () => 'tag_vv2',
    async relayMessage(jid, content, opts) {
      relayed.push({ jid, content, opts });
      return true;
    },
    async sendMessage() {
      return { key: { id: 'sent_dm' } };
    },
  };

  // Owner message in a public group chat
  const mockMsg = {
    key: { remoteJid: '987654321@g.us', id: 'cmd_msg_vv2', fromMe: true },
    message: {
      extendedTextMessage: {
        text: '.vv2',
        contextInfo: {
          stanzaId: 'vo_target_vv2',
          participant: '2348000000002@s.whatsapp.net',
          quotedMessage: {
            viewOnceMessageV2: {
              message: {
                videoMessage: {
                  url: 'https://example.com/expired-video',
                  mediaKey: Buffer.from('12345678901234567890123456789012'),
                  mimetype: 'video/mp4',
                  viewOnce: true,
                },
              },
            },
          },
        },
      },
    },
  };

  const deps = {
    react: async (s, m, r) => reactions.push(r),
    sendReply: async (s, m, t) => replies.push(t),
    downloadContentFromMessage: async () => {
      throw new Error('410 Gone (Media Expired)');
    },
    CONFIG: { PREFIX: '.' },
  };

  const res = await viewOnceCmd.handleViewOnceCommand(
    mockSocket,
    mockMsg,
    [],
    { cmdName: 'vv2', sendToDm: true, silent: true },
    deps
  );

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'relay');
  // Must be 100% silent in the group chat
  assert.equal(reactions.length, 0, 'No reactions in chat during .vv2');
  assert.equal(replies.length, 0, 'No replies in chat during .vv2');
  assert.equal(relayed.length, 1, 'Should relay message');
  assert.equal(relayed[0].jid, '2348000000000@s.whatsapp.net', 'Must relay directly to owner DM, NOT the group');
  assert.equal(relayed[0].content.videoMessage.viewOnce, false, 'viewOnce stripped');
});
