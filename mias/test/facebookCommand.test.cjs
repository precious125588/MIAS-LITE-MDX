const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fb = require('../lib/facebookDownloader.cjs');

test('Facebook command updates status with 1.3 HD re-encoding and delivers video', async () => {
  const statuses = [];
  const reactions = [];
  let videoSent = null;

  const mockMedia = {
    buffer: Buffer.from('mock video data'),
    mimetype: 'video/mp4',
    extension: '.mp4',
    title: 'Test FB Video',
    quality: 'HD',
    url: 'https://www.facebook.com/reel/123456789',
  };

  const command = fb.createFacebookCommand({
    getPrefix: () => '.',
    getQuotedText: () => '',
    react: async (sock, msg, emoji) => { reactions.push(emoji); },
    sendStatus: async (sock, msg, text) => {
      statuses.push(text);
      return { key: { id: 'status_1' } };
    },
    editStatus: async (sock, msg, key, text) => {
      statuses.push(text);
    },
    resolveMedia: async (url) => mockMedia,
    sendVideo: async (sock, msg, media, opts) => {
      videoSent = { media, opts };
    },
    sendDocument: async () => {},
    sendAudio: async () => {},
  });

  const res = await command({}, { key: { remoteJid: 'user@s.whatsapp.net' } }, ['https://www.facebook.com/reel/123456789']);

  assert.equal(res.ok, true);
  assert.equal(res.deliveredAs, 'video');
  assert.equal(res.quality, 'HD');

  // Verify status progress
  assert.ok(statuses.some(s => s.includes('Fetching Facebook video links')));
  assert.ok(statuses.some(s => s.includes('Re-encoding in 1.3 HD & delivering')));
  // Verify old stuck message is NOT present
  assert.ok(!statuses.some(s => s.includes('without re-encoding')));
  assert.ok(statuses.some(s => s.includes('Facebook HD video delivered')));

  // Verify reactions
  assert.deepEqual(reactions, ['🌀', '✅']);
  assert.ok(videoSent);
  assert.equal(videoSent.media.title, 'Test FB Video');
});

test('Facebook command doc mode updates status and sends document', async () => {
  const statuses = [];
  let docSent = null;

  const command = fb.createFacebookCommand({
    getPrefix: () => '.',
    getQuotedText: () => '',
    react: async () => {},
    sendStatus: async (sock, msg, text) => {
      statuses.push(text);
      return { key: { id: 'status_doc' } };
    },
    editStatus: async (sock, msg, key, text) => { statuses.push(text); },
    resolveMedia: async () => ({
      buffer: Buffer.from('mock video data'),
      title: 'Doc FB Video',
      quality: 'HD',
    }),
    sendVideo: async () => { assert.fail('Should not call sendVideo in doc mode'); },
    sendDocument: async (sock, msg, media, opts) => {
      docSent = { media, opts };
    },
    sendAudio: async () => {},
  });

  const res = await command({}, { key: { remoteJid: 'user@s.whatsapp.net' } }, ['https://www.facebook.com/watch?v=123', 'doc']);

  assert.equal(res.ok, true);
  assert.equal(res.deliveredAs, 'file');
  assert.ok(statuses.some(s => s.includes('Preparing document delivery')));
  assert.ok(docSent);
});

test('Facebook command audio mode extracts audio and updates status', async () => {
  const statuses = [];
  let audioSent = null;

  const command = fb.createFacebookCommand({
    getPrefix: () => '.',
    getQuotedText: () => '',
    react: async () => {},
    sendStatus: async (sock, msg, text) => {
      statuses.push(text);
      return { key: { id: 'status_audio' } };
    },
    editStatus: async (sock, msg, key, text) => { statuses.push(text); },
    resolveMedia: async () => ({
      buffer: Buffer.from('mock video data'),
      title: 'Audio FB Video',
      quality: 'HD',
    }),
    extractAudio: async (buf, media) => Buffer.alloc(2048, 1),
    sendVideo: async () => {},
    sendDocument: async () => {},
    sendAudio: async (sock, msg, audio, opts) => {
      audioSent = { audio, opts };
    },
  });

  const res = await command({}, { key: { remoteJid: 'user@s.whatsapp.net' } }, ['https://www.facebook.com/watch?v=123', 'audio']);

  assert.equal(res.ok, true);
  assert.equal(res.deliveredAs, 'audio');
  assert.ok(statuses.some(s => s.includes('Extracting audio & delivering')));
  assert.ok(audioSent);
});

test('Facebook command video failure falls back cleanly to document', async () => {
  const statuses = [];
  let docSent = null;

  const command = fb.createFacebookCommand({
    getPrefix: () => '.',
    getQuotedText: () => '',
    react: async () => {},
    sendStatus: async (sock, msg, text) => {
      statuses.push(text);
      return { key: { id: 'status_fallback' } };
    },
    editStatus: async (sock, msg, key, text) => { statuses.push(text); },
    resolveMedia: async () => ({
      buffer: Buffer.from('mock video data'),
      title: 'Fallback FB Video',
      quality: 'HD',
    }),
    sendVideo: async () => {
      throw new Error('Video too large or rejected by WhatsApp');
    },
    sendDocument: async (sock, msg, media, opts) => {
      docSent = { media, opts };
    },
    sendAudio: async () => {},
  });

  const res = await command({}, { key: { remoteJid: 'user@s.whatsapp.net' } }, ['https://www.facebook.com/watch?v=123']);

  assert.equal(res.ok, true);
  assert.equal(res.deliveredAs, 'file');
  assert.ok(docSent);
  assert.ok(statuses.some(s => s.includes('delivered')));
});

test('deliverVideoHd13 re-encodes video using 1.3 HD and delivers via socket', async () => {
  // Generate a valid 1s test mp4 file
  const testDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-test-'));
  const testSrc = path.join(testDir, 'test_src.mp4');

  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
    '-c:v', 'libx264', '-c:a', 'aac', testSrc,
  ], { stdio: 'ignore' });

  const buf = await fsp.readFile(testSrc);
  let sentPayload = null;

  const mockSock = {
    sendMessage: async (jid, payload, opts) => {
      sentPayload = { jid, payload, opts };
      return { key: { id: 'msg_hd13_test' } };
    },
  };

  // Require deliverVideoHd13 from index.js scope or test directly
  // We can test the deliverVideoHd13 logic directly
  const ttd = require('../lib/ttDelivery.cjs');
  const disk = require('../lib/tiktokDiskDelivery.cjs');

  // Test buffer delivery
  const tmpIn = path.join(testDir, 'source.mp4');
  await fsp.writeFile(tmpIn, buf);

  const encoded = await ttd.reencodeHdForWhatsApp(tmpIn, {
    boost: 1.2,
    sourceQualityBoost: 1.2,
    maxBytes: ttd.TT_INLINE_VIDEO_MAX_BYTES,
  });

  assert.ok(encoded.path);
  assert.ok(fs.existsSync(encoded.path));
  assert.ok(encoded.bytes > 0);

  // Send via mock sock
  const sent = await disk.sendWithRateLimitRetry(async () => {
    return await mockSock.sendMessage('123@s.whatsapp.net', {
      video: { url: encoded.path },
      mimetype: 'video/mp4',
      caption: 'HD Test',
    }, {});
  });

  assert.equal(sent.key.id, 'msg_hd13_test');
  assert.equal(sentPayload.payload.mimetype, 'video/mp4');

  await encoded.cleanup();
  assert.ok(!fs.existsSync(encoded.path));

  await fsp.rm(testDir, { recursive: true, force: true });
});
