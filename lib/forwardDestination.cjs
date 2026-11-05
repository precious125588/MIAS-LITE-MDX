'use strict';

/**
 * Helpers for `.forward` / `.fwd` destinations and group VCF file names.
 */

/**
 * Joins every argument so a number typed with spaces, dashes or brackets
 * ("+234 907 963 3136") arrives whole. The old code read only args[0].
 */
function forwardRawArg(args) {
  const parts = Array.isArray(args) ? args : [args];
  return parts.map((p) => String(p ?? '')).join(' ')
    .trim()
    .replace(/^[{\[<]+|[}\]>]+$/g, '')
    .trim();
}

/** Digits of a phone destination, or null when it is not a plausible phone number. */
function forwardPhoneDigits(raw) {
  const text = String(raw ?? '');
  if (!text || text.includes('@') || /chat\.whatsapp\.com\//i.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/**
 * File name for a group's contact export: "<Group name>.contacts.vcf".
 * Only characters that cannot appear in a file name are removed.
 */
function groupVcfFileName(subject) {
  const base = String(subject ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'group';
  return `${base}.contacts.vcf`;
}

module.exports = { forwardRawArg, forwardPhoneDigits, groupVcfFileName };
