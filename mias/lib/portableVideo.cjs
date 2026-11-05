'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

let ffmpegPath;
function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  try {
    let p = require('ffmpeg-static');
    if (p && typeof p === 'object' && p.default) p = p.default;
    if (p && typeof p === 'string' && fs.existsSync(p)) {
      try { fs.chmodSync(p, 0o755); } catch (_) {}
      ffmpegPath = p;
      return ffmpegPath;
    }
  } catch (_) {}
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    ffmpegPath = process.env.FFMPEG_PATH;
    return ffmpegPath;
  }
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg']) {
    if (fs.existsSync(p)) {
      ffmpegPath = p;
      return ffmpegPath;
    }
  }
  ffmpegPath = 'ffmpeg';
  return ffmpegPath;
}

function isMp4(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp';
}

// A stream copy keeps whatever codec the source used, and TikTok sometimes serves H.265.
// WhatsApp does not reliably play that, so copy output is only accepted when the video is
// H.264 and the audio (if any) is AAC. Anything else falls through to the H.264/AAC transcode.
async function hasWhatsAppCodecs(bin, file) {
  let stderr = '';
  try {
    await execFileAsync(bin, ['-hide_banner', '-i', file], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    // ffmpeg with no output target exits non-zero but prints the stream list to stderr.
    stderr = String((err && err.stderr) || '');
  }
  const video = (stderr.match(/Stream #\d+:\d+[^\n]*?Video: (\w+)/) || [])[1];
  const audio = (stderr.match(/Stream #\d+:\d+[^\n]*?Audio: (\w+)/) || [])[1];
  if (video !== 'h264') return false;
  return !audio || audio === 'aac';
}

async function normalizeVideoBuffer(input, opts = {}) {
  if (!Buffer.isBuffer(input) || input.length < 1024) return input;
  if (input.length > (opts.maxInputBytes || 120 * 1024 * 1024)) return input;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mias-video-'));
  const inPath = path.join(dir, 'input.bin');
  const outPath = path.join(dir, 'output.mp4');
  try {
    await fsp.writeFile(inPath, input);
    const bin = resolveFfmpeg();

    // 1) Fast path: stream copy with faststart (instant, no CPU transcode, fixes WhatsApp moov atom)
    try {
      await execFileAsync(bin, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
        '-c', 'copy', '-movflags', '+faststart',
        '-f', 'mp4', outPath,
      ], { timeout: 30000, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024 });
      const fastOutput = await fsp.readFile(outPath);
      if (isMp4(fastOutput) && fastOutput.length > 10000 && await hasWhatsAppCodecs(bin, outPath)) return fastOutput;
    } catch (_) {
      // Stream copy failed or input needs re-encode; continue to full transcode
    }

    // 2) Full transcode fallback with faststart
    await execFileAsync(bin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', opts.preset || 'veryfast',
      '-crf', String(opts.crf || 26), '-pix_fmt', 'yuv420p',
      ...(opts.maxrate ? ['-maxrate', String(opts.maxrate), '-bufsize', String(opts.bufsize || opts.maxrate)] : []),
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      '-f', 'mp4', outPath,
    ], { timeout: opts.timeoutMs || 120000, maxBuffer: opts.maxBuffer || 32 * 1024 * 1024 });
    const output = await fsp.readFile(outPath);
    if (isMp4(output) && output.length > 10000) return output;
  } catch (err) {
    try { console.warn('[video] normalization skipped:', err && err.message || err); } catch (_) {}
  } finally {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return input;
}

/**
 * Build a high quality slideshow video from an array of image URLs and an optional audio URL.
 * Slides each image for durationPerSlide seconds (default: 3 seconds).
 */
/**
 * Build a slideshow video from image URLs + optional audio URL.
 * v2026-10 SPEED PASS:
 *  - images download in PARALLEL (was sequential: the main delay)
 *  - 720x1280 ultrafast encode (was 1080x1920 veryfast crf22: ~3x faster)
 *  - shorter network timeouts (12s/img, 20s audio)
 *  - output is +faststart remux-ready so WhatsApp accepts it instantly
 */
async function createSliderVideo({ images = [], audioUrl = null, durationPerSlide = 3 }) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('No images provided for slider video');
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mias-slider-'));
  try {
    // ── Parallel image downloads (biggest speed win) ──
    const fetched = await Promise.all(images.slice(0, 30).map(async (url, i) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length > 512 ? { i, buf } : null;
      } catch (e) {
        try { console.warn('[slider] image download failed for index', i, e?.message || e); } catch (_) {}
        return null;
      }
    }));
    const downloadedImages = [];
    for (const item of fetched.filter(Boolean).sort((a, b) => a.i - b.i)) {
      const imgPath = path.join(dir, 'slide_' + String(item.i).padStart(3, '0') + '.jpg');
      await fsp.writeFile(imgPath, item.buf);
      downloadedImages.push(imgPath);
    }

    if (downloadedImages.length === 0) {
      throw new Error('Failed to download any images for the slider video');
    }

    // ── Audio (single fetch, tight timeout; silent fallback never blocks) ──
    let audioPath = null;
    if (audioUrl) {
      try {
        const aRes = await fetch(audioUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(20000),
        });
        if (aRes.ok) {
          const aBuf = Buffer.from(await aRes.arrayBuffer());
          if (aBuf.length > 1024) {
            audioPath = path.join(dir, 'audio.bin');
            await fsp.writeFile(audioPath, aBuf);
          }
        }
      } catch (e) {
        try { console.warn('[slider] audio download failed:', e?.message || e); } catch (_) {}
      }
    }

    let concatText = '';
    for (let i = 0; i < downloadedImages.length; i++) {
      concatText += "file '" + downloadedImages[i] + "'\nduration " + durationPerSlide + "\n";
    }
    concatText += "file '" + downloadedImages[downloadedImages.length - 1] + "'\n";
    const concatFile = path.join(dir, 'concat.txt');
    await fsp.writeFile(concatFile, concatText);

    const outPath = path.join(dir, 'output.mp4');
    const totalDuration = String(downloadedImages.length * durationPerSlide);
    const bin = resolveFfmpeg();
    const VF = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24'; // 576x1024: WhatsApp-ready vertical, ~2x faster encode than 720x1280, still clean HD on phones

    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
    ];

    let _audioOk = false;
    if (audioPath) { try { const _ast = await fsp.stat(audioPath); _audioOk = !!_ast && _ast.size > 100; } catch (_) { _audioOk = false; } }
    if (_audioOk) {
      ffmpegArgs.push('-stream_loop', '-1', '-i', audioPath);
    } else {
      ffmpegArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }

    ffmpegArgs.push(
      '-vf', VF,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', '24',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', totalDuration,
      '-movflags', '+faststart',
      '-f', 'mp4', outPath
    );

    try {
      await execFileAsync(bin, ffmpegArgs, { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    } catch (_ffErr) {
      // Retry once: drop the (possibly corrupt/empty) audio track so the slider
      // is ALWAYS delivered instead of crashing.
      console.error('[slider] ffmpeg attempt 1 failed, retrying without audio:', _ffErr?.message || _ffErr);
      const retryArgs = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', VF,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', '24', '-threads', '2',
        '-c:a', 'aac', '-b:a', '128k',
        '-t', totalDuration,
        '-movflags', '+faststart',
        '-f', 'mp4', outPath
      ];
      await execFileAsync(bin, retryArgs, { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    }
    const outputBuffer = await fsp.readFile(outPath);
    // REMUX PASS (stream copy, no re-encode — finishes in ~1s): rewrites the
    // MP4 container with clean timestamps and the moov atom at the front so
    // WhatsApp accepts and renders the slider instantly. Falls back to the
    // encoded file if remuxing fails.
    try {
      const remuxPath = path.join(dir, 'output_remux.mp4');
      await execFileAsync(bin, ['-hide_banner','-loglevel','error','-y','-i',outPath,'-c','copy','-movflags','+faststart',remuxPath], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const remuxBuf = await fsp.readFile(remuxPath);
      if (remuxBuf.length > 1024) return remuxBuf;
    } catch (_) {}
    return outputBuffer;
  } finally {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { normalizeVideoBuffer, isMp4, resolveFfmpeg, createSliderVideo };
