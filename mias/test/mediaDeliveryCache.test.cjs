'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const mediaCache = require('../lib/mediaDeliveryCache.cjs');
const disk = require('../lib/tiktokDiskDelivery.cjs');
const delivery = require('../lib/ttDelivery.cjs');

test('computeFileHash computes correct sha256 hex digest', () => {
  const tmpFile = path.join(os.tmpdir(), `test_hash_${Date.now()}.bin`);
  const data = Buffer.from('hello-whatsapp-delivery-cache-test');
  fs.writeFileSync(tmpFile, data);
  try {
    const expected = crypto.createHash('sha256').update(data).digest('hex');
    const actual = mediaCache.computeFileHash(tmpFile);
    assert.equal(actual, expected);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('extractMediaKeys extracts CDN parameters from video and document messages', () => {
  const mockVideoMsg = {
    key: { remoteJid: '123@s.whatsapp.net', fromMe: true, id: 'MSG_VID_1' },
    message: {
      videoMessage: {
        url: 'https://mmg.whatsapp.net/v/t62.7118-24/vid.mp4',
        directPath: '/v/t62.7118-24/vid.mp4',
        mediaKey: Buffer.from('0123456789abcdef0123456789abcdef'),
        fileSha256: Buffer.from('sha256_mock_bytes_0123456789abcd'),
        fileEncSha256: Buffer.from('encsha_mock_bytes_0123456789abcd'),
        fileLength: 1048576,
        mimetype: 'video/mp4',
        seconds: 15,
        height: 1080,
        width: 1920,
        caption: 'Hello',
      }
    }
  };

  const extracted = mediaCache.extractMediaKeys(mockVideoMsg);
  assert.ok(extracted);
  assert.equal(extracted.type, 'video');
  assert.equal(extracted.directPath, '/v/t62.7118-24/vid.mp4');
  assert.equal(extracted.fileLength, 1048576);
  assert.equal(typeof extracted.mediaKey, 'string'); // base64
  assert.equal(typeof extracted.fileSha256, 'string');
});

test('media cache enforces 4-day TTL strictly', () => {
  const testKey = `ttl_test_${Date.now()}`;
  const now = Date.now();
  const mockData = {
    type: 'video',
    directPath: '/v/t62/test.mp4',
    mediaKey: Buffer.from('key').toString('base64'),
    fileSha256: Buffer.from('sha').toString('base64'),
    fileEncSha256: Buffer.from('enc').toString('base64'),
    fileLength: 5000,
  };

  mediaCache.setCachedMedia(testKey, mockData);

  const entry = mediaCache.getCachedMedia(testKey);
  assert.ok(entry, 'Entry should exist right after setting');
  // Check expiresAt is exactly now + 4 days
  const expectedTtl = 4 * 24 * 60 * 60 * 1000;
  assert.equal(mediaCache.CACHE_TTL_MS, expectedTtl);
  assert.ok(entry.expiresAt >= now + expectedTtl - 1000);
  assert.ok(entry.expiresAt <= now + expectedTtl + 1000);

  // Simulate expiration past 4 days
  entry.expiresAt = Date.now() - 1000;
  const expiredCheck = mediaCache.getCachedMedia(testKey);
  assert.equal(expiredCheck, null, 'Expired entry must return null and be purged');
});

test('Primary method sends via media keys without uploading file', async () => {
  let relayed = false;
  let relayedJid = null;
  let relayedPayload = null;

  const mockSock = {
    user: { id: 'bot@s.whatsapp.net' },
    relayMessage: async (jid, message, opts) => {
      relayed = true;
      relayedJid = jid;
      relayedPayload = message;
      return { key: { id: opts.messageId || 'MOCK_ID' } };
    }
  };

  const cached = {
    type: 'video',
    directPath: '/v/t62/stream.mp4',
    mediaKey: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    fileSha256: Buffer.from('sha256_mock_bytes_0123456789abcd').toString('base64'),
    fileEncSha256: Buffer.from('encsha_mock_bytes_0123456789abcd').toString('base64'),
    fileLength: 204800,
    mimetype: 'video/mp4',
    seconds: 10,
    height: 720,
    width: 1280,
  };

  const res = await mediaCache.sendViaMediaKeys(mockSock, 'target@s.whatsapp.net', cached, {
    caption: 'Custom New Caption for Recipient',
    quoted: { key: { id: 'QUOTED_1' } },
  });

  assert.equal(relayed, true);
  assert.equal(relayedJid, 'target@s.whatsapp.net');
  assert.ok(relayedPayload.videoMessage);
  assert.equal(relayedPayload.videoMessage.directPath, '/v/t62/stream.mp4');
  assert.equal(relayedPayload.videoMessage.caption, 'Custom New Caption for Recipient');
  assert.equal(res.__cacheMethod, 'primary_cdn_keys');
});

test('Fallback 1 forwards cleanly when copyNForward is used', async () => {
  let forwarded = false;
  let forwardedJid = null;
  let passedForceForward = null;

  const mockRawMsg = {
    key: { remoteJid: 'sender@s.whatsapp.net', fromMe: true, id: 'ORIG_MSG' },
    message: { videoMessage: { caption: 'Orig' } }
  };

  const mockSock = {
    copyNForward: async (jid, msg, forceForward, opts) => {
      forwarded = true;
      forwardedJid = jid;
      passedForceForward = forceForward;
      return { key: { id: 'FWD_MSG_ID' } };
    }
  };

  const cached = {
    type: 'video',
    rawMessage: mockRawMsg,
  };

  const res = await mediaCache.sendViaForwardFallback(mockSock, 'receiver@s.whatsapp.net', cached, {});
  assert.equal(forwarded, true);
  assert.equal(forwardedJid, 'receiver@s.whatsapp.net');
  assert.equal(passedForceForward, false, 'forceForward must be false for clean unflagged forward');
  assert.equal(res.__cacheMethod, 'fallback_forward');
});

test('deliverWithMediaCache caches on first send and reuses on second send (Primary & Fallback)', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_reuse_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.from('video-payload-for-cache-test-1234567890'));

  let freshSends = 0;
  let relayCalls = 0;

  const mockSock = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      freshSends++;
      return {
        key: { remoteJid: jid, fromMe: true, id: `FRESH_MSG_${freshSends}` },
        message: {
          videoMessage: {
            url: 'https://mmg.whatsapp.net/v/test.mp4',
            directPath: '/v/test.mp4',
            mediaKey: Buffer.from('0123456789abcdef0123456789abcdef'),
            fileSha256: Buffer.from('sha256_mock_bytes_0123456789abcd'),
            fileEncSha256: Buffer.from('encsha_mock_bytes_0123456789abcd'),
            fileLength: 100,
            mimetype: 'video/mp4',
          }
        }
      };
    },
    relayMessage: async (jid, message, opts) => {
      relayCalls++;
      return { key: { id: `RELAY_MSG_${relayCalls}` } };
    }
  };

  try {
    // 1st Send: Fresh upload (cache miss)
    const res1 = await mediaCache.deliverWithMediaCache({
      sock: mockSock,
      jid: 'user1@s.whatsapp.net',
      filePath: tmpFile,
      type: 'video',
      caption: 'Send 1',
      sendFresh: () => mockSock.sendMessage('user1@s.whatsapp.net', { video: { url: tmpFile } })
    });

    assert.equal(freshSends, 1, 'First delivery must perform fresh send');
    assert.equal(relayCalls, 0);

    // 2nd Send to another person: Hits cache, delivers via Primary (relayMessage with CDN keys)
    const res2 = await mediaCache.deliverWithMediaCache({
      sock: mockSock,
      jid: 'user2@s.whatsapp.net',
      filePath: tmpFile,
      type: 'video',
      caption: 'Send 2 to another person',
      sendFresh: () => mockSock.sendMessage('user2@s.whatsapp.net', { video: { url: tmpFile } })
    });

    assert.equal(freshSends, 1, 'Second delivery must NOT re-upload (freshSends remains 1)');
    assert.equal(relayCalls, 1, 'Second delivery must use Primary CDN keys relay');
    assert.equal(res2.__cacheMethod, 'primary_cdn_keys');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('deliverTikTokFile reuses cached CDN media for repeat TikTok URLs without re-encoding', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_tt_cache_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(2048, 0x11));

  let freshUploads = 0;
  let relays = 0;

  const mockSock = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      freshUploads++;
      return {
        key: { remoteJid: jid, fromMe: true, id: `TT_MSG_${freshUploads}` },
        message: {
          videoMessage: {
            url: 'https://mmg.whatsapp.net/v/tiktok_hd.mp4',
            directPath: '/v/tiktok_hd.mp4',
            mediaKey: Buffer.from('0123456789abcdef0123456789abcdef'),
            fileSha256: Buffer.from('sha256_mock_bytes_0123456789abcd'),
            fileEncSha256: Buffer.from('encsha_mock_bytes_0123456789abcd'),
            fileLength: 2048,
            mimetype: 'video/mp4',
          }
        }
      };
    },
    relayMessage: async (jid, message, opts) => {
      relays++;
      return { key: { id: `TT_RELAY_${relays}` } };
    }
  };

  const fakeUrl = 'https://www.tiktok.com/@test/video/998877665544';

  try {
    // 1st Deliver
    const res1 = await delivery.deliverTikTokFile({
      sock: mockSock,
      jid: 'friendA@s.whatsapp.net',
      file: { path: tmpFile, bytes: 2048, url: fakeUrl },
      mode: { id: '1.3', format: 'video' },
      caption: 'First send',
      fileName: 'test.mp4',
      url: fakeUrl,
    });

    assert.equal(freshUploads, 1);
    assert.equal(relays, 0);

    // 2nd Deliver for same TikTok URL: should hit cache directly, 0 re-encodes, 0 uploads
    const res2 = await delivery.deliverTikTokFile({
      sock: mockSock,
      jid: 'friendB@s.whatsapp.net',
      file: { path: tmpFile, bytes: 2048, url: fakeUrl },
      mode: { id: '1.3', format: 'video' },
      caption: 'Second send to another friend',
      fileName: 'test.mp4',
      url: fakeUrl,
    });

    assert.equal(res2.fromCache, true, 'Repeat request must be served from cache');
    assert.equal(res2.cacheMethod, 'primary_cdn_keys');
    assert.equal(freshUploads, 1, 'Upload count must not increase');
    assert.equal(relays, 1, 'Primary CDN relay was used');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});
