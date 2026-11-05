'use strict';
/**
 * Secure authenticated file encryption.
 * Format v1: magic + salt + nonce + GCM tag + ciphertext.
 * Keys are derived from passwords with scrypt; callers must retain the
 * password securely and never pass it through logs or source control.
 */
const crypto = require('crypto');
const MAGIC = Buffer.from('MIASENC1', 'ascii');
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH;

function validatePassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 1 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new TypeError('Password must be a non-empty string no longer than 1024 bytes');
  }
}

function deriveKey(password, salt) {
  validatePassword(password);
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) throw new TypeError('Invalid salt');
  return crypto.scryptSync(password, salt, KEY_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encryptBuffer(plaintext, password) {
  validatePassword(password);
  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const key = deriveKey(password, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, salt, nonce, tag, ciphertext]);
  } finally {
    key.fill(0);
  }
}

function decryptBuffer(encrypted, password) {
  validatePassword(password);
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted);
  if (encrypted.length < HEADER_LENGTH) throw new Error('Malformed encrypted data: header is incomplete');
  if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Unsupported encrypted format. Legacy ciphertext is not decrypted implicitly.');
  }
  const saltStart = MAGIC.length;
  const nonceStart = saltStart + SALT_LENGTH;
  const tagStart = nonceStart + NONCE_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  const salt = encrypted.subarray(saltStart, nonceStart);
  const nonce = encrypted.subarray(nonceStart, tagStart);
  const tag = encrypted.subarray(tagStart, ciphertextStart);
  const ciphertext = encrypted.subarray(ciphertextStart);
  if (salt.length !== SALT_LENGTH || nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Malformed encrypted data: invalid metadata lengths');
  }
  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    throw new Error('Decryption failed: incorrect password or data was modified');
  } finally {
    key.fill(0);
  }
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  isEncryptedFormat(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
  },
  FORMAT: 'MIASENC1',
  SALT_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
};
