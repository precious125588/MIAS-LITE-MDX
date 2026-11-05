// =========================================================================
//  whatsappPlayable.cjs — makes a downloaded MP4 playable in WhatsApp
//  without lowering its quality.
//
//  WhatsApp can show "This video is not available because something is wrong
//  with the video file" for some TikTok HD downloads (HEVC/H.265, AV1,
//  10-bit, or an MP4 whose index sits at the end of the file). We read the
//  codec with ffmpeg itself (no ffprobe needed) and then:
//   • H.264 4:2:0 video  → stream copy + faststart remux (same frames, no re-encode)
//   • any other codec    → H.264 re-encode at CRF 18, same resolution and frame rate
//  If an ffmpeg step fails the original file is sent unchanged. If the
//  re-encoded file would exceed the WhatsApp size limit, the candidate is
//  skipped instead of sent at a lower quality.
// =========================================================================
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

let resolveFfmpeg = () => 'ffmpeg';
try { resolveFfmpeg = require('./portableVideo.cjs').resolveFfmpeg || resolveFfmpeg; } catch (_) {}

// Reads ffmpeg's stream report (printed on stderr when no output is given).
async function probeVideo(file) {
  let text = '';
  try {
    const r = await execFileAsync(resolveFfmpeg(), ['-hide_banner', '-i', file], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    text = String(r.stderr || '');
  } catch (e) {
    text = String((e && e.stderr) || '');
  }
  const v = text.match(/Stream #\d+:\d+[^\n]*Video:\s*([a-z0-9_]+)([^\n]*)/i);
  const a = text.match(/Stream #\d+:\d+[^\n]*Audio:\s*([a-z0-9_]+)/i);
  const pix = v ? ((v[2].match(/\b(yuv\w+|rgb\w+|gray\w*)/i) || [])[1] || '') : '';
  return {
    videoCodec: v ? v[1].toLowerCase() : '',
    pixFmt: pix.toLowerCase(),
    audioCodec: a ? a[1].toLowerCase() : '',
  };
}

async function isMp4File(file) {
  try {
    const st = await fsp.stat(file);
    if (st.size < 12) return false;
    const fh = await fsp.open(file, 'r');
    try {
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      return head.subarray(4, 8).toString('ascii') === 'ftyp';
    } finally { await fh.close(); }
  } catch { return false; }
}

// Returns { send, action, reason }.
//   send=true  → send `file` (it was remuxed/re-encoded in place, or left as-is)
//   send=false → do not send this candidate (re-encoded output too large)
async function makeWhatsAppPlayable(file, { maxOutputBytes = 64 * 1024 * 1024, timeoutMs = 240000 } = {}) {
  let info;
  try { info = await probeVideo(file); }
  catch (e) { return { send: true, action: 'kept', reason: 'probe failed: ' + ((e && e.message) || e) }; }
  if (!info.videoCodec) return { send: true, action: 'kept', reason: 'no video stream found' };

  const isH264420 = info.videoCodec === 'h264' && info.pixFmt === 'yuv420p';
  const out = path.join(path.dirname(file), 'playable.mp4');
  const audioArgs = info.audioCodec && info.audioCodec !== 'aac'
    ? ['-c:a', 'aac', '-b:a', '192k']
    : ['-c:a', 'copy'];
  const args = isH264420
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a?',
       '-c:v', 'copy', ...audioArgs, '-movflags', '+faststart', '-f', 'mp4', out]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a?',
       '-c:v', 'libx264', '-preset', 'superfast', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
       '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', out];
  const from = `${info.videoCodec}${info.pixFmt ? '/' + info.pixFmt : ''}`;

  try {
    await execFileAsync(resolveFfmpeg(), args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return { send: true, action: 'kept', reason: `ffmpeg failed (${from}): ` + String((e && e.message) || e).slice(0, 160) };
  }
  const st = await fsp.stat(out).catch(() => null);
  if (!st || st.size < 10000 || !(await isMp4File(out))) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return { send: true, action: 'kept', reason: `output was not a valid MP4 (${from})` };
  }
  if (st.size > maxOutputBytes) {
    await fsp.rm(out, { force: true }).catch(() => {});
    return { send: false, action: 'skipped', reason: `re-encoded ${from} file is ${(st.size / 1048576).toFixed(1)} MiB, over the WhatsApp limit` };
  }
  await fsp.rename(out, file);
  return {
    send: true,
    action: isH264420 ? 'remuxed' : 're-encoded',
    reason: isH264420 ? `${from} → faststart` : `${from} → h264 crf 18`,
    bytes: st.size,
  };
}

module.exports = { makeWhatsAppPlayable, probeVideo };
