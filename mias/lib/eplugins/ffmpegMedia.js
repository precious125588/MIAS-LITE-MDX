/**
 * Levanter's fFmpeg.js helpers: getFfmpegBuffer, audioCut and videoHeightWidth.
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * Ported from Levanter's decoded fFmpeg.js. The preset table in ffmpegPresets.json is
 * copied from Levanter's source as-is, including its option strings.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ffmpeg = require("fluent-ffmpeg");

const PRESETS = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./ffmpegPresets.json", import.meta.url)), "utf8"),
);
const DEFAULT_TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../temp");

// Levanter's b5 deletes a temp file unless it is a mention file. Deleted synchronously here so
// the file is gone before the buffer is returned.
function removeFile(file) {
  if (!file || file.includes("mention")) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Already removed; Levanter ignores unlink errors too.
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// exact: fFmpeg.js getFfmpegBuffer(input, outName, preset). Resolves with the output file's
// bytes. "bass,10" and "treble,10" set the equaliser gain in the preset's third option.
export async function getFfmpegBuffer(input, outName, preset, tempDir = DEFAULT_TEMP_DIR) {
  let bass = "false";
  let treble = "false";
  if (/bass,/.test(preset)) {
    bass = preset.split(",")[1];
    preset = preset.split(",")[0];
  }
  if (/treble,/.test(preset)) {
    treble = preset.split(",")[1];
    preset = preset.split(",")[0];
  }
  const options = [...PRESETS[preset]];
  if ("false" != bass) options[2] = "bass=g=" + bass;
  if ("false" != treble) options[2] = "treble=g=" + treble;
  ensureDir(tempDir);
  const output = path.join(tempDir, outName);
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(options)
      .save(output)
      .on("error", (err, _stdout, stderr) => {
        removeFile(input);
        removeFile(output);
        reject(new Error("FFmpeg error: " + err.message + ". Stderr: " + stderr));
      })
      .on("end", () => {
        const buffer = fs.readFileSync(output);
        removeFile(input);
        removeFile(output);
        resolve(buffer);
      });
  });
}

// exact: fFmpeg.js audioCut(input, start, duration, name = "cut"). Resolves with an MP3 buffer.
export function audioCut(input, start, duration, name = "cut", tempDir = DEFAULT_TEMP_DIR) {
  ensureDir(tempDir);
  const output = path.join(tempDir, name + ".mp3");
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(start)
      .setDuration(duration)
      .save(output)
      .on("error", (err) => reject(new Error(err.message)))
      .on("end", () => {
        const buffer = fs.readFileSync(output);
        removeFile(input);
        removeFile(output);
        resolve(buffer);
      });
  });
}

// exact: fFmpeg.js videoHeightWidth. Reads the first stream's width and height with ffprobe.
export async function videoHeightWidth(input) {
  const metadata = await new Promise((resolve) => {
    ffmpeg.ffprobe(input, (_err, data) => resolve(data));
  });
  const { streams: streamList } = metadata;
  return { width: streamList[0].width, height: streamList[0].height };
}
