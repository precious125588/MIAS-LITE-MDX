'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  lib/leaveCommand.cjs — MIAS LITE MDX Leave & Delete Group Implementation
 * ═══════════════════════════════════════════════════════════════════════
 *  When the bot receives `.leave` (or aliases `.leavegc`, `.deletegc`, `.out`):
 *  1. Verifies the command is invoked in a WhatsApp group (@g.us).
 *  2. Gated to Bot Owner, Sudo users, or Group Admins.
 *  3. Reacts with 👋 and posts a parting announcement.
 *  4. If the bot is group admin:
 *     - Revokes the group invite link to prevent re-entry.
 *     - Closes group settings (announcement mode).
 *     - Removes remaining participants to disband/delete the group.
 *  5. Bot exits the group via `sock.groupLeave(jid)`.
 *  6. Bot immediately deletes the group chat via `sock.chatModify({ delete: true })`
 *     so the dead chat never lingers in the bot's chat list.
 *  7. Cleans up internal caches and sends a private confirmation DM to the issuer.
 * ═══════════════════════════════════════════════════════════════════════
 */

function stripDevice(jid) {
  return String(jid || '').replace(/:\d+@/, '@').replace(/:\d+$/, '');
}

function digitsOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

/** Resolve an explicit group JID or WhatsApp invite URL/code without joining it. */
async function resolveLeaveTarget(sock, args = [], currentJid = '') {
  const raw = Array.isArray(args) ? args.join(' ').trim() : String(args || '').trim();
  if (!raw) return isGroupJid(currentJid) ? currentJid : null;

  const jid = raw.match(/[0-9-]+@g\.us/i)?.[0];
  if (jid && isGroupJid(jid)) return jid;

  let inviteCode = null;
  const urlMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) inviteCode = urlMatch[1];
  else if (/^[A-Za-z0-9_-]{6,64}$/.test(raw)) inviteCode = raw;
  if (!inviteCode || typeof sock?.groupGetInviteInfo !== 'function') return null;

  try {
    const info = await sock.groupGetInviteInfo(inviteCode);
    return isGroupJid(info?.id) ? info.id : null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolves whether the sender is the owner, sudo, or a group admin.
 */
async function canExecuteLeave(sock, msg, jid, senderJid, deps = {}) {
  // If sent from the bot itself
  if (msg?.key?.fromMe) return true;

  const senderDigits = digitsOf(senderJid);
  if (!senderDigits) return false;

  // Check deps / global isOwner
  const isOwnerFn = deps.isOwner || globalThis.__miasIsOwner;
  if (typeof isOwnerFn === 'function') {
    try { if (isOwnerFn(senderJid)) return true; } catch (_) {}
  }

  // Check deps / global isSudo
  const isSudoFn = deps.isSudo || globalThis.__miasIsSudo;
  if (typeof isSudoFn === 'function') {
    try { if (isSudoFn(senderJid)) return true; } catch (_) {}
  }

  // Check config owner number
  const config = deps.CONFIG || globalThis.CONFIG || {};
  const ownerNum = digitsOf(config.OWNER_NUMBER || process.env.OWNER_NUMBER || '');
  if (ownerNum && (ownerNum === senderDigits || ownerNum.endsWith(senderDigits) || senderDigits.endsWith(ownerNum))) {
    return true;
  }

  // Check if sender is group admin
  if (sock && typeof sock.groupMetadata === 'function' && isGroupJid(jid)) {
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta && Array.isArray(meta.participants)) {
        const participant = meta.participants.find(p => {
          const pDigits = digitsOf(p.id || p.jid || '');
          return pDigits && (pDigits === senderDigits || pDigits.endsWith(senderDigits) || senderDigits.endsWith(pDigits));
        });
        if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
          return true;
        }
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Main leave & delete handler.
 */
async function handleLeaveCommand(sock, msg, args = [], deps = {}) {
  const originJid = msg?.key?.remoteJid || '';
  const jid = await resolveLeaveTarget(sock, args, originJid);

  // 1. Resolve the target group. A direct chat is allowed only with an explicit target.
  if (!jid) {
    const text = isGroupJid(originJid)
      ? '👥 *Could not resolve that group.* Send a valid group JID or WhatsApp invite link/code.'
      : '👥 *Send a group JID or WhatsApp invite link/code.*';
    if (typeof deps.sendReply === 'function') {
      await deps.sendReply(sock, msg, text).catch(() => {});
    } else if (sock && typeof sock.sendMessage === 'function') {
      await sock.sendMessage(originJid, { text }, { quoted: msg }).catch(() => {});
    }
    return { ok: false, reason: 'invalid_target' };
  }

  // 2. Identify sender
  const senderJid =
    msg?.key?.participantPn ||
    msg?.key?.senderPn ||
    msg?.key?.participant ||
    msg?.participant ||
    (msg?.key?.fromMe ? sock?.user?.id : '') ||
    '';

  const allowed = await canExecuteLeave(sock, msg, jid, senderJid, deps);
  if (!allowed) {
    const deniedText = '🚫 *Access Denied:* Only bot owners, sudo users, or group admins can use this command.';
    if (typeof deps.sendReply === 'function') {
      await deps.sendReply(sock, msg, deniedText).catch(() => {});
    } else if (sock && typeof sock.sendMessage === 'function') {
      await sock.sendMessage(originJid, { text: deniedText }, { quoted: msg }).catch(() => {});
    }
    return { ok: false, reason: 'unauthorized' };
  }

  // 3. React and send farewell notification
  try {
    if (typeof deps.react === 'function') {
      await deps.react(sock, msg, '👋').catch(() => {});
    } else if (sock && typeof sock.sendMessage === 'function') {
      await sock.sendMessage(jid, { react: { text: '👋', key: msg.key } }).catch(() => {});
    }
  } catch (_) {}

  let groupMeta = null;
  let isBotAdmin = false;
  const botDigits = digitsOf(sock?.user?.id || '');

  try {
    if (typeof sock.groupMetadata === 'function') {
      groupMeta = await sock.groupMetadata(jid);
      if (groupMeta && Array.isArray(groupMeta.participants)) {
        const botMember = groupMeta.participants.find(p => {
          const pDigits = digitsOf(p.id || p.jid || '');
          return pDigits && (pDigits === botDigits || pDigits.endsWith(botDigits) || botDigits.endsWith(pDigits));
        });
        isBotAdmin = !!(botMember && (botMember.admin === 'admin' || botMember.admin === 'superadmin'));
      }
    }
  } catch (_) {}

  const partingText = isBotAdmin
    ? '👋 *Goodbye everyone!*\n\n_Disbanding, leaving, and deleting group immediately..._'
    : '👋 *Goodbye everyone!*\n\n_Bot is leaving and deleting this group chat immediately..._';

  try {
    if (typeof sock.sendMessage === 'function') {
      await sock.sendMessage(jid, { text: partingText }, originJid === jid ? { quoted: msg } : {}).catch(() => {});
    }
  } catch (_) {}

  // Short pause to ensure delivery over WebSocket before socket actions
  await new Promise(res => setTimeout(res, 600));

  // 4. Disband group if bot is admin
  if (isBotAdmin) {
    // Revoke invite link so link becomes invalid
    try {
      if (typeof sock.groupRevokeInvite === 'function') {
        await sock.groupRevokeInvite(jid).catch(() => {});
      }
    } catch (_) {}

    // Lock group settings to announcement only
    try {
      if (typeof sock.groupSettingUpdate === 'function') {
        await sock.groupSettingUpdate(jid, 'announcement').catch(() => {});
        await sock.groupSettingUpdate(jid, 'locked').catch(() => {});
      }
    } catch (_) {}

    // Remove remaining participants to effectively delete/destroy the group
    if (groupMeta && Array.isArray(groupMeta.participants)) {
      try {
        const targets = groupMeta.participants
          .map(p => p.id || p.jid)
          .filter(id => {
            const pDigits = digitsOf(id);
            return pDigits && pDigits !== botDigits;
          });

        if (targets.length > 0 && typeof sock.groupParticipantsUpdate === 'function') {
          for (let i = 0; i < targets.length; i += 25) {
            const batch = targets.slice(i, i + 25);
            await sock.groupParticipantsUpdate(jid, batch, 'remove').catch(() => {});
            if (i + 25 < targets.length) {
              await new Promise(r => setTimeout(r, 250));
            }
          }
        }
      } catch (_) {}
    }

    await new Promise(res => setTimeout(res, 400));
  }

  // 5. Bot leaves the group
  let leftOk = false;
  try {
    if (typeof sock.groupLeave === 'function') {
      await sock.groupLeave(jid);
      leftOk = true;
    }
  } catch (err) {
    console.warn('[leave] groupLeave error:', err?.message || err);
  }

  await new Promise(res => setTimeout(res, 500));

  // 6. Delete group chat immediately from bot account
  let deleteOk = false;
  try {
    if (typeof sock.chatModify === 'function') {
      // Primary: delete with lastMessages payload
      await sock.chatModify({
        delete: true,
        lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000) }]
      }, jid).catch(async () => {
        // Secondary fallback: delete without lastMessages
        return sock.chatModify({ delete: true }, jid);
      }).then(() => {
        deleteOk = true;
      }).catch(() => {});

      // Extra safety: clear messages
      await sock.chatModify({
        clear: {
          messages: [{ id: msg.key.id, fromMe: !!msg.key.fromMe, timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000) }]
        }
      }, jid).catch(() => {});
    }
  } catch (err) {
    console.warn('[leave] chatModify delete error:', err?.message || err);
  }

  // 7. Clear caches
  try {
    if (globalThis._groupMetaCache && typeof globalThis._groupMetaCache.delete === 'function') {
      globalThis._groupMetaCache.delete(jid);
    }
    if (globalThis.groupCache && typeof globalThis.groupCache.delete === 'function') {
      globalThis.groupCache.delete(jid);
    }
  } catch (_) {}

  // 8. Confirm in private DM to issuer if not sent from bot's own number
  if (senderJid && !msg?.key?.fromMe && typeof sock.sendMessage === 'function') {
    try {
      const gName = groupMeta?.subject || 'Group';
      await sock.sendMessage(senderJid, {
        text: `🚪 *Group Left & Deleted Successfully*\n\n📛 *Group:* ${gName}\n🆔 *JID:* ${jid.split('@')[0]}\n🛡️ *Admin Action:* ${isBotAdmin ? 'Disbanded & Purged' : 'Left'}\n🗑️ *Chat:* Deleted immediately from bot chats.`
      }).catch(() => {});
    } catch (_) {}
  }

  return {
    ok: true,
    isGroup: true,
    isBotAdmin,
    left: leftOk,
    deleted: deleteOk,
  };
}

module.exports = {
  isGroupJid,
  resolveLeaveTarget,
  canExecuteLeave,
  handleLeaveCommand,
};
