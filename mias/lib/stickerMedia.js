/**
 * MIAS sticker media pipeline.
 *
 * The WhatsApp sticker field must contain an actual WebP file. In particular,
 * animated stickers need a WebP ANIM/ANMF stream; sending the source MP4 with a
 * sticker-shaped success message is not sufficient.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const MAX_VIDEO_SECONDS = 6;
const MAX_VIDEO_FPS = 10;
const MAX_DIMENSION = 512;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_STATIC_STICKER_BYTES = 1024 * 1024;
const MAX_ANIMATED_STICKER_BYTES = 512 * 1024;

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function isWebp(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 16
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function isAnimatedWebp(buffer) {
  if (!isWebp(buffer)) return false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    if (type === "ANIM" || type === "ANMF") return true;
    offset += 8 + size + (size % 2);
  }
  return false;
}

function safeExt(mediaType) {
  if (String(mediaType || "").startsWith("image/")) return "image";
  if (String(mediaType || "").startsWith("video/")) return "video";
  return "media";
}

let _resolvedFfmpeg = null;
async function ffmpegPath() {
  if (_resolvedFfmpeg) return _resolvedFfmpeg;
  // 1) ffmpeg-static bundled binary — but only if it actually exists on disk
  //    (a partial install leaves the package importable with a dead path,
  //    which is exactly the "cannot find the native FFmpeg binary" failure).
  try {
    const mod = await import("ffmpeg-static");
    const p = typeof mod === "string" ? mod : (mod.default || null);
    if (p && fs.existsSync(p)) {
      _resolvedFfmpeg = p;
      return p;
    }
  } catch {}
  // 2) Well-known system locations (Docker apt ffmpeg, Alpine, Railway).
  for (const p of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg", "/usr/sbin/ffmpeg"]) {
    try { if (fs.existsSync(p)) { _resolvedFfmpeg = p; return p; } } catch {}
  }
  // 3) PATH probe — confirm the binary really executes before trusting it.
  const onPath = await new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const probe = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      probe.once("error", () => done(false));
      probe.once("close", (code) => done(code === 0));
      const t = setTimeout(() => { try { probe.kill("SIGKILL"); } catch {} done(false); }, 5000);
      if (t && typeof t.unref === "function") t.unref();
    } catch { done(false); }
  });
  if (onPath) {
    _resolvedFfmpeg = "ffmpeg";
    return "ffmpeg";
  }
  throw new Error(
    "No usable FFmpeg binary found. Install it with `apt-get install -y ffmpeg` " +
    "or `npm i ffmpeg-static` (the project Dockerfile already does both)."
  );
}

async function runFfmpeg(input, output, { animated, fps = MAX_VIDEO_FPS, seconds = MAX_VIDEO_SECONDS, quality }) {
  const binary = await ffmpegPath();
  const vf = animated
    ? [
        `fps=${fps}`,
        `scale=${MAX_DIMENSION}:${MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
        `pad=${MAX_DIMENSION}:${MAX_DIMENSION}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        "format=yuva420p",
      ].join(",")
    : [
        `scale=${MAX_DIMENSION}:${MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
        `pad=${MAX_DIMENSION}:${MAX_DIMENSION}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        "format=yuva420p",
      ].join(",");

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vf", vf,
    "-c:v", "libwebp",
    "-lossless", "0",
    "-compression_level", "6",
    "-q:v", String(quality != null ? quality : (animated ? 58 : 75)),
    "-an",
  ];
  if (animated) {
    args.push("-t", String(seconds), "-loop", "0", "-vsync", "0");
  }
  args.push("-f", "webp", output);

  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function addMetadata(buffer, pack, author) {
  // WhatsApp reads sticker pack info from the WebP EXIF chunk. The header MUST
  // be the full 22-byte little-endian TIFF stub whose bytes 14..17 hold the
  // JSON payload length — the old 12-byte stub produced a malformed chunk and
  // WhatsApp answered every such sticker with
  // "Sorry, this media file doesn't exist on your internal storage".
  const animatedInput = isAnimatedWebp(buffer);
  try {
    const mod = await import("node-webpmux");
    const WebPMux = mod.default || mod;
    if (typeof WebPMux.Image?.initLib === "function") {
      try { await WebPMux.Image.initLib(); } catch {}
    }
    const payload = Buffer.from(JSON.stringify({
      "sticker-pack-id": "com.mias.stickers",
      "sticker-pack-name": String(pack || "MIAS").slice(0, 128),
      "sticker-pack-publisher": String(author || "MIAS Bot").slice(0, 128),
      emojis: ["\u{1F3AD}"],
    }), "utf8");

    const exifHeader = Buffer.from([
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);
    exifHeader.writeUInt32LE(payload.length, 14);

    // node-webpmux v3 exposes load/save on an INSTANCE. The previous code
    // called the non-existent static WebPMux.Image.load(), so every sticker
    // silently shipped without its pack metadata.
    const image = new WebPMux.Image();
    await image.load(buffer);
    image.exif = Buffer.concat([exifHeader, payload]);
    const tagged = await image.save(null, { exif: true });

    // Never hand WhatsApp a file the tagger damaged: it must still be a WebP,
    // and an animated sticker must still be animated.
    if (!isWebp(tagged)) return buffer;
    if (animatedInput && !isAnimatedWebp(tagged)) return buffer;
    return tagged;
  } catch {
    return buffer;
  }
}

async function staticSticker(buffer, pack, author) {
  try {
    const mod = await import("wa-sticker-formatter");
    const Sticker = mod.Sticker || mod.default?.Sticker;
    const StickerTypes = mod.StickerTypes || mod.default?.StickerTypes;
    if (!Sticker || !StickerTypes) throw new Error("wa-sticker-formatter is unavailable");
    const sticker = new Sticker(buffer, {
      pack,
      author,
      type: StickerTypes.FULL,
      quality: 75,
    });
    return await sticker.toBuffer();
  } catch {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mias-sticker-"));
    try {
      const input = path.join(dir, "input.image");
      const output = path.join(dir, "output.webp");
      fs.writeFileSync(input, buffer);
      await runFfmpeg(input, output, { animated: false });
      return fs.readFileSync(output);
    } finally {
      cleanup(dir);
    }
  }
}

/**
 * Convert a downloaded WhatsApp/TikTok media buffer into a valid sticker.
 *
 * @param {Buffer} buffer
 * @param {{mediaType?: string, pack?: string, author?: string}} options
 */
export async function createStickerFromBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    throw new Error("media is empty or too small");
  }
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error("media is larger than the 40 MiB sticker input limit");
  }
  const mediaType = String(options.mediaType || "").toLowerCase();
  const pack = options.pack || "MIAS";
  const author = options.author || "MIAS Bot";
  const animated = mediaType.startsWith("video/");

  let sticker;
  if (!animated) {
    sticker = await staticSticker(buffer, pack, author);
  } else {
    // A single fixed-quality pass very often lands above WhatsApp's 512 KiB
    // animated-sticker limit, and the old code then THREW — which is why
    // "video → sticker" silently never delivered. Encode progressively
    // smaller versions until one fits, and keep the smallest attempt as a
    // last resort instead of failing.
    const attempts = [
      { fps: MAX_VIDEO_FPS, seconds: MAX_VIDEO_SECONDS, quality: 58 },
      { fps: 10, seconds: 5, quality: 45 },
      { fps: 8,  seconds: 5, quality: 38 },
      { fps: 8,  seconds: 4, quality: 30 },
      { fps: 6,  seconds: 3, quality: 22 },
      { fps: 5,  seconds: 3, quality: 15 },
    ];
    let smallest = null;
    let lastError = null;
    for (const attempt of attempts) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mias-sticker-"));
      try {
        const input = path.join(dir, `input.${safeExt(mediaType)}`);
        const output = path.join(dir, "output.webp");
        fs.writeFileSync(input, buffer);
        await runFfmpeg(input, output, { animated: true, ...attempt });
        const encoded = fs.readFileSync(output);
        if (!isWebp(encoded) || !isAnimatedWebp(encoded)) {
          lastError = new Error("ffmpeg produced a non-animated WebP");
          continue;
        }
        if (!smallest || encoded.length < smallest.length) smallest = encoded;
        // Leave headroom for the EXIF metadata chunk added below.
        if (encoded.length <= MAX_ANIMATED_STICKER_BYTES - 8192) break;
      } catch (error) {
        lastError = error;
      } finally {
        cleanup(dir);
      }
    }
    if (!smallest) throw lastError || new Error("could not encode an animated sticker");
    sticker = smallest;
  }

  if (!isWebp(sticker)) throw new Error("sticker encoder did not produce WebP");
  if (animated && !isAnimatedWebp(sticker)) throw new Error("animated sticker encoding failed");
  const tagged = await addMetadata(sticker, pack, author);
  const maxBytes = animated ? MAX_ANIMATED_STICKER_BYTES : MAX_STATIC_STICKER_BYTES;
  // Metadata can tip a borderline file over the limit; the untagged file is
  // still a perfectly valid sticker, so prefer sending that over failing.
  if (tagged.length > maxBytes) {
    if (sticker.length <= maxBytes) return sticker;
    throw new Error(`sticker is larger than the ${Math.round(maxBytes / 1024)} KiB WhatsApp limit`);
  }
  // Last gate before the buffer reaches WhatsApp.
  if (!isWebp(tagged) || tagged.length < 64) return sticker;
  return tagged;
}

export { isWebp, isAnimatedWebp };