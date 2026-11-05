// =========================================================================
//  welcomeCards.cjs — v35 UNICODE-SAFE welcome/goodbye image cards.
//
//  ROOT CAUSE OF THE "???" BUG: the old renderer used Jimp's built-in
//  bitmap fonts, which contain ONLY basic Latin glyphs. Any styled Unicode
//  name (ᴍɪɴɪ, 𝑸𝒂𝒅𝒆𝒆𝒓), emoji (🔥☠️), Arabic, CJK, etc. was drawn as
//  question marks / blank boxes.
//
//  FIX: render with @napi-rs/canvas (already in package.json) using the
//  system Noto/DejaVu font stack, which covers styled Unicode, emoji,
//  Arabic, CJK and every other script. If a glyph truly has no font, the
//  codepoint is KEPT (never replaced with "?"). Jimp remains only as a
//  last-resort fallback when the canvas engine is unavailable.
//
//  The TARGET member's username + their DP are rendered beside the round
//  avatar. When the bot has not fetched the member's name/DP yet, the
//  caller passes the creator-number fallback — this module NEVER hardcodes
//  a name.
// =========================================================================
'use strict';

const W = 640, H = 300, PAD = 18;
const AV = 150;                 // avatar diameter
const AV_X = PAD + 17;          // avatar left
const AV_Y = 58 + 27;           // avatar top
const TEXT_X = AV_X + AV + 24;  // text starts right of the avatar + gutter
const TEXT_W = W - TEXT_X - PAD; // clip width so text never leaves the card

// ── safe text helpers ────────────────────────────────────────────────────
function _truncate(str, max) {
  // count by code points, not UTF-16 units, so styled letters and emoji are never split
  const chars = Array.from(String(str || ''));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}
// strip control chars ONLY — every real character (styled letters, emoji,
// Arabic, CJK, ZWJ sequences) is preserved so it can never become "?"

// Transliterate Mathematical Alphanumeric Symbols & fancy stylized Unicode to ASCII Latin
function _unfancy(str) {
  if (!str) return "";
  let out = "";
  for (const char of String(str)) {
    const cp = char.codePointAt(0);
    // Mathematical Alphanumeric Symbols: 0x1D400 - 0x1D7FF
    if (cp >= 0x1D400 && cp <= 0x1D7FF) {
      // Bold, Italic, Bold Italic, Script, Bold Script, Fraktur, Double-struck, etc.
      // Modulo 52/26 mapping to A-Z, a-z
      if (cp >= 0x1D400 && cp <= 0x1D433) out += String.fromCharCode(cp <= 0x1D419 ? 65 + (cp - 0x1D400) : 97 + (cp - 0x1D41A)); // Bold
      else if (cp >= 0x1D434 && cp <= 0x1D467) out += String.fromCharCode(cp <= 0x1D44D ? 65 + (cp - 0x1D434) : 97 + (cp - 0x1D44E)); // Italic
      else if (cp >= 0x1D468 && cp <= 0x1D49B) out += String.fromCharCode(cp <= 0x1D481 ? 65 + (cp - 0x1D468) : 97 + (cp - 0x1D482)); // Bold Italic
      else if (cp >= 0x1D49C && cp <= 0x1D4CF) out += String.fromCharCode(cp <= 0x1D4B5 ? 65 + (cp - 0x1D49C) : 97 + (cp - 0x1D4B6)); // Script
      else if (cp >= 0x1D4D0 && cp <= 0x1D503) out += String.fromCharCode(cp <= 0x1D4E9 ? 65 + (cp - 0x1D4D0) : 97 + (cp - 0x1D4EA)); // Bold Script
      else if (cp >= 0x1D504 && cp <= 0x1D537) out += String.fromCharCode(cp <= 0x1D51D ? 65 + (cp - 0x1D504) : 97 + (cp - 0x1D51E)); // Fraktur
      else if (cp >= 0x1D538 && cp <= 0x1D56B) out += String.fromCharCode(cp <= 0x1D551 ? 65 + (cp - 0x1D538) : 97 + (cp - 0x1D552)); // Double-struck
      else if (cp >= 0x1D56C && cp <= 0x1D59F) out += String.fromCharCode(cp <= 0x1D585 ? 65 + (cp - 0x1D56C) : 97 + (cp - 0x1D586)); // Bold Fraktur
      else if (cp >= 0x1D5A0 && cp <= 0x1D5D3) out += String.fromCharCode(cp <= 0x1D5B9 ? 65 + (cp - 0x1D5A0) : 97 + (cp - 0x1D5BA)); // Sans-serif
      else if (cp >= 0x1D5D4 && cp <= 0x1D607) out += String.fromCharCode(cp <= 0x1D5ED ? 65 + (cp - 0x1D5D4) : 97 + (cp - 0x1D5EE)); // Sans-serif Bold
      else if (cp >= 0x1D608 && cp <= 0x1D63B) out += String.fromCharCode(cp <= 0x1D621 ? 65 + (cp - 0x1D608) : 97 + (cp - 0x1D622)); // Sans-serif Italic
      else if (cp >= 0x1D63C && cp <= 0x1D66F) out += String.fromCharCode(cp <= 0x1D655 ? 65 + (cp - 0x1D63C) : 97 + (cp - 0x1D656)); // Sans-serif Bold Italic
      else if (cp >= 0x1D670 && cp <= 0x1D6A3) out += String.fromCharCode(cp <= 0x1D689 ? 65 + (cp - 0x1D670) : 97 + (cp - 0x1D68A)); // Monospace
      else if (cp >= 0x1D7CE && cp <= 0x1D7FF) out += String.fromCharCode(48 + ((cp - 0x1D7CE) % 10)); // Digits
      else out += char;
    } else if (cp >= 0xFF01 && cp <= 0xFF5E) {
      // Fullwidth ASCII
      out += String.fromCharCode(cp - 0xFEE0);
    } else if (cp >= 0x24B6 && cp <= 0x24E9) {
      // Circled Latin
      out += String.fromCharCode(cp <= 0x24CF ? 65 + (cp - 0x24B6) : 97 + (cp - 0x24D0));
    } else {
      out += char;
    }
  }
  return out;
}

function _sanitize(str) {
  // Preserve \n so multi-line text (like ACC and NAME) renders on separate lines
  return String(str || '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

// ── @napi-rs/canvas engine + Unicode font registration ──────────────────
let _napi = null, _napiTried = false;
function napi() {
  if (_napiTried) return _napi;
  _napiTried = true;    try {
      _napi = require('@napi-rs/canvas');
      const fs = require('fs'), path = require('path');
      const { GlobalFonts } = _napi;
      function walk(dir, depth) {
        if (depth > 6) return;
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (/\.(ttf|ttc|otf)$/i.test(e.name)) { try { GlobalFonts.registerFromPath(p); } catch {} }
        }
      }
      for (const root of ['/usr/share/fonts', '/usr/local/share/fonts', '/root/.fonts']) walk(root, 0);
    } catch { _napi = null; }
  return _napi;
}
// Font stack: first family that has a glyph wins. Math/symbol/script families are listed
// explicitly so styled letters (bold/italic/script/fraktur/double-struck/monospace), Arabic,
// Devanagari, Thai, Hebrew, Cherokee and Adlam names draw instead of boxes. Emoji comes early
// so ☠️🔥 keep their color. Families missing on a host are skipped by the renderer.
const FAMILY = '"Noto Sans","Noto Color Emoji","Noto Sans Math","Noto Sans Symbols","Noto Sans Symbols 2","Noto Sans Arabic","Noto Sans Devanagari","Noto Sans Thai","Noto Sans Hebrew","Noto Sans Cherokee","Noto Sans Adlam","Noto Sans CJK SC","Noto Emoji","DejaVu Sans","Liberation Sans",sans-serif';

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function wrapText(c, text, x, y, maxW, lh, maxLines) {
  const paragraphs = String(text).split('\n');
  let yy = y, lines = 0;
  for (const para of paragraphs) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > maxW && line) {
        c.fillText(line, x, yy); yy += lh; line = w;
        if (++lines >= maxLines - 1) break;
      } else line = t;
    }
    if (line && lines < maxLines) {
      c.fillText(line, x, yy);
      yy += lh;
      lines++;
    }
    if (lines >= maxLines) break;
  }
}

// ── canvas renderer (PRIMARY — full Unicode / emoji / styled names) ─────
async function renderCanvas(avatarBuf, label, username, sub) {
  const { createCanvas, loadImage } = napi();
  const cv = createCanvas(W, H);
  const c = cv.getContext('2d');

  c.fillStyle = '#171a21'; c.fillRect(0, 0, W, H);
  c.fillStyle = label === 'GOODBYE' ? '#b03a48' : '#2f80ed'; c.fillRect(0, 0, W, 58);
  c.fillStyle = '#232936'; roundRect(c, PAD, 66, W - PAD * 2, H - 66 - PAD - 2, 12); c.fill();

  // avatar ring + circular-clipped DP (neutral disc fallback)
  c.save(); c.beginPath(); c.arc(AV_X + AV / 2, AV_Y + AV / 2, AV / 2 + 5, 0, Math.PI * 2); c.fillStyle = '#2f80ed'; c.fill(); c.restore();
  c.save();
  c.beginPath(); c.arc(AV_X + AV / 2, AV_Y + AV / 2, AV / 2, 0, Math.PI * 2); c.closePath(); c.clip();
  let drew = false;
  if (avatarBuf) { try { const img = await loadImage(avatarBuf); c.drawImage(img, AV_X, AV_Y, AV, AV); drew = true; } catch {} }
  if (!drew) {
    c.fillStyle = '#4b5563'; c.fillRect(AV_X, AV_Y, AV, AV);
    c.fillStyle = '#9ca3af'; c.font = 'bold 64px ' + FAMILY; c.textAlign = 'center';
    c.fillText('👤', AV_X + AV / 2, AV_Y + AV / 2 + 22); c.textAlign = 'left';
  }
  c.restore();

  // top label bar
  c.fillStyle = '#ffffff'; c.textBaseline = 'alphabetic';
  c.font = 'bold 24px ' + FAMILY;
  c.fillText(_truncate(String(label || ''), 24), 18, 38);

  // ── TARGET username beside the avatar — auto-shrink so ANY name fits ──
  const name = _truncate(_sanitize(username) || 'Member', 40);
  let size = 30;
  c.font = `bold ${size}px ${FAMILY}`;
  while (size > 13 && c.measureText(name).width > TEXT_W) { size -= 2; c.font = `bold ${size}px ${FAMILY}`; }
  c.fillStyle = '#ffffff';
  c.fillText(name, TEXT_X, 58 + 70);

  if (sub) {
    c.font = '16px ' + FAMILY; c.fillStyle = '#c8ccd4';
    wrapText(c, _sanitize(sub), TEXT_X, 58 + 104, TEXT_W, 20, 3);
  }
  return cv.encode('jpeg', 88);
}

// ── Jimp fallback (LAST RESORT only, when the canvas engine is missing) ──
async function renderJimp(avatarBuf, label, username, sub) {
  const Jimp = require('jimp');
  const base = new Jimp(W, H, 0x171a21ff);
  const bar = new Jimp(W, 58, label === 'GOODBYE' ? 0xb03a48ff : 0x2f80edff);
  base.composite(bar, 0, 0);
  const inner = new Jimp(W - PAD * 2, H - 58 - PAD - 10, 0x232936ff);
  base.composite(inner, PAD, 58 + 8);
  let avatar;
  try { avatar = avatarBuf ? await Jimp.read(avatarBuf) : new Jimp(AV, AV, 0x4b5563ff); }
  catch { avatar = new Jimp(AV, AV, 0x4b5563ff); }
  avatar.cover(AV, AV).circle();
  const ring = new Jimp(AV + 10, AV + 10, 0x2f80edff).circle();
  base.composite(ring, AV_X - 5, 58 + 22 - 5);
  base.composite(avatar, AV_X, 58 + 22);
  const fontBar = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  const fontName = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  base.print(fontBar, 18, 18, { text: String(label || ''), alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, W - 36, 30);
  const name = _truncate(_sanitize(username) || 'Member', 26);
  const nameFont = name.length > 14 ? fontSub : fontName;
  base.print(nameFont, TEXT_X, 58 + 40, { text: name, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, TEXT_W, 48);
  if (sub) base.print(fontSub, TEXT_X, 58 + 96, { text: _truncate(_sanitize(sub), 60), alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, TEXT_W, 90);
  return base.quality(88).getBufferAsync(Jimp.MIME_JPEG);
}

/**
 * Render a welcome/goodbye card with the member's REAL name (any Unicode,
 * styled font, emoji, Arabic, CJK — never question marks).
 * @param {Buffer|null} avatarBuf  member profile image (fallback disc if null)
 * @param {string} label           "WELCOME" | "GOODBYE"
 * @param {string} username        TARGET member's display name (caller falls
 *                                 back to creator number when not fetched yet)
 * @param {string} sub             extra line (group / member count)
 * @returns {Promise<Buffer>}      JPEG image buffer
 */
async function renderMemberCard(avatarBuf, label, username, sub) {
  if (napi()) {
    try { return await renderCanvas(avatarBuf, label, username, sub); }
    catch (e) { try { console.error('[welcomeCards] canvas render failed, falling back:', e?.message || e); } catch {} }
  }
  return renderJimp(avatarBuf, label, username, sub);
}

module.exports = { renderMemberCard };
