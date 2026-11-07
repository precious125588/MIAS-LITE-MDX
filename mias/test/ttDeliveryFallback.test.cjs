'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const delivery = require('../lib/ttDelivery.cjs');
const { processVideoTo4k } = require('../lib/tt4kVideo.cjs');

test('reencodeHdForWhatsApp falls back to source file on invalid/failing video instead of throwing', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_invalid_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.from('not a real mp4 video content to simulate ffmpeg failure'));
  try {
    const result = await delivery.reencodeHdForWhatsApp(tmpFile, { timeoutMs: 2000 });
    assert.ok(result, 'Expected a result object, not an exception');
    assert.equal(result.fallback, true);
    assert.equal(result.untouched, true);
    assert.ok(result.bytes > 0);
    await result.cleanup();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('processVideoTo4k falls back to source file on invalid/failing video instead of throwing', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_4k_invalid_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.from('not a real mp4 video content to simulate ffmpeg failure'));
  try {
    const result = await processVideoTo4k(tmpFile, { timeoutMs: 2000 });
    assert.ok(result, 'Expected a result object, not an exception');
    assert.equal(result.fallback, true);
    assert.equal(result.untouched, true);
    assert.ok(result.bytes > 0);
    if (typeof result.cleanup === 'function') result.cleanup();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('deliverTikTokFile falls back to document if file exceeds WhatsApp inline limit', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_oversized_${Date.now()}.mp4`);
  // Create a sparse file of 96 MiB (exceeds 95 MiB limit)
  const fd = fs.openSync(tmpFile, 'w');
  fs.ftruncateSync(fd, 96 * 1024 * 1024);
  fs.closeSync(fd);

  let sentAsDocument = false;
  let sentAsVideo = false;

  const mockSock = {
    sendMessage: async (jid, content) => {
      if (content.document) sentAsDocument = true;
      if (content.video) sentAsVideo = true;
      return { key: { id: 'msg-123' } };
    }
  };

  try {
    const result = await delivery.deliverTikTokFile({
      sock: mockSock,
      jid: '12345@s.whatsapp.net',
      file: { path: tmpFile, bytes: 96 * 1024 * 1024 },
      mode: { id: '1.3', format: 'video', isDocument: false },
      caption: 'Test Caption',
      fileName: 'test.mp4',
      quoted: null,
    });

    assert.equal(result.type, 'document');
    assert.equal(result.fallbackToDocument, true);
    assert.equal(sentAsDocument, true);
    assert.equal(sentAsVideo, false);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('deliverTikTokFile videoNote mode attempts PTV and falls back cleanly', async () => {
  const tmpFile = path.join(os.tmpdir(), `test_ptv_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(1024, 0x00));
  let ptvAttempted = false;
  let videoAttempted = false;

  const mockSockFailPtv = {
    sendMessage: async (jid, content) => {
      if (content.ptv) {
        ptvAttempted = true;
        throw new Error('PTV send failed');
      }
      if (content.video) {
        videoAttempted = true;
        return { key: { id: 'video-123' } };
      }
      if (content.document) {
        return { key: { id: 'doc-123' } };
      }
    }
  };

  try {
    const result = await delivery.deliverTikTokFile({
      sock: mockSockFailPtv,
      jid: '12345@s.whatsapp.net',
      file: { path: tmpFile, bytes: 1024 },
      mode: { id: '1.7', format: 'video', videoNote: true },
      caption: 'Note Caption',
      fileName: 'test.mp4',
      quoted: null,
    });

    assert.equal(ptvAttempted, true);
    assert.equal(videoAttempted, true);
    assert.equal(result.type, 'video');
    assert.equal(result.fallbackToVideo, true);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('mias/index.js contains 1.01 quality boost for TikTok HD picker (1.3 & 1.4) and 1.02 for 4K', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.equal(indexSource.includes('1.01:null'), true, 'Expected 1.01:null in index.js');
  assert.equal(indexSource.includes('1.004:null'), false, 'Found old 1.004 in index.js');
  // The 4K boost moved into the readable module; check its constant there.
  const ttSource = fs.readFileSync(path.join(__dirname, '../lib/ttDelivery.cjs'), 'utf8');
  assert.match(ttSource, /const HIGH_QUALITY_4K_BOOST = 1\.02;/, 'Expected 1.02 4K boost in lib/ttDelivery.cjs');
});
