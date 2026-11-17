'use strict';
// Works out what a .join argument points to.
// chat.whatsapp.com/CODE is a group invite and joins the group.
// whatsapp.com/channel/CODE is a channel link and follows the channel.
// A bare code is treated as a group invite code, as before.

const GROUP_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i;
const CHANNEL_RE = /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i;
const BARE_RE = /^[A-Za-z0-9_-]+$/;
const MIN_CODE_LENGTH = 8;

function validate(kind, code) {
  return code.length >= MIN_CODE_LENGTH ? { kind, code } : { kind: 'invalid', code: null };
}

function parseJoinTarget(input) {
  const text = String(input || '').trim();
  if (!text) return { kind: 'invalid', code: null };
  const channel = text.match(CHANNEL_RE);
  if (channel) return validate('channel', channel[1]);
  const group = text.match(GROUP_RE);
  if (group) return validate('group', group[1]);
  if (BARE_RE.test(text)) return validate('group', text);
  return { kind: 'invalid', code: null };
}

module.exports = { parseJoinTarget };
