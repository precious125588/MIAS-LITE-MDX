'use strict';
/* ── NON-BLOCKING PROCESS HELPERS ────────────────────────────────────────────
   execSync / spawnSync freeze the whole Node process while ffmpeg runs (up to
   60 seconds per sticker, voice note, or video probe). During that time the
   WhatsApp socket, incoming commands, and replies all wait. These helpers run
   the same commands asynchronously. Errors behave like the sync versions:
   execShellAsync rejects on a non-zero exit; spawnAsync never rejects and
   reports the exit status and output instead.
   ──────────────────────────────────────────────────────────────────────────── */

const { exec, spawn } = require('node:child_process');

const OUTPUT_LIMIT = 16 * 1024 * 1024;

function execShellAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, {
      timeout: Number(options.timeout) || 0,
      maxBuffer: OUTPUT_LIMIT,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnAsync(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return done({ status: null, error });
    }
    child.stdout.on('data', (chunk) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    const limit = Number(options.timeout) || 0;
    if (limit > 0) {
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, limit);
    }
    child.on('error', (error) => done({ status: null, error }));
    child.on('close', (code) => done({ status: code }));
  });
}

module.exports = { execShellAsync, spawnAsync };
