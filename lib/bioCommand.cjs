'use strict';

/**
 * XYLO-format implementation for `.setbio` / `.setabout`.
 * Matches XYLO-MD's exact privacySet.ts behavior and messages.
 */

const BIO_MAX_CHARS = 139;

async function handleSetBio(sock, msg, args = [], deps = {}) {
  const from = msg?.key?.remoteJid || '';
  const bio = (Array.isArray(args) ? args : [String(args || '')]).join(' ').trim();

  if (!bio) {
    return sock.sendMessage(from, {
      text: '✏️ Please provide a bio to set.'
    }, {
      quoted: msg
    });
  }

  if (bio.length > BIO_MAX_CHARS) {
    return sock.sendMessage(from, {
      text: '❌ Bio too long (max 139 characters).'
    }, {
      quoted: msg
    });
  }

  try {
    if (typeof sock.updateProfileStatus === 'function') {
      await sock.updateProfileStatus(bio);
    } else if (typeof sock.query === 'function') {
      await sock.query({
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'status' },
        content: [{ tag: 'status', attrs: {}, content: Buffer.from(bio, 'utf-8') }],
      });
    } else {
      throw new Error('updateProfileStatus is not supported on this socket');
    }

    await sock.sendMessage(from, {
      text: '✅ Bio updated successfully!'
    }, {
      quoted: msg
    });
    return { ok: true };
  } catch (err) {
    await sock.sendMessage(from, {
      text: '❌ Failed to update bio: ' + (err?.message || err)
    }, {
      quoted: msg
    });
    return { ok: false, error: err?.message || err };
  }
}

module.exports = {
  BIO_MAX_CHARS,
  handleSetBio,
};
