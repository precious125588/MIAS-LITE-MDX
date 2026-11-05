'use strict';

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  const phoneLike = name.replace(/[\s()+.-]/g, "");
  if (!name || /^(?:no\s+name|unknown|undefined|null)$/i.test(name) || (/^\d+$/.test(phoneLike) && phoneLike.length >= 5) || name.includes("@")) return "";
  return name;
}

function escapeVCardText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildGroupVcf(participants, {
  resolveLid = value => value,
  cleanNumber = value => String(value || "").replace(/\D/g, ""),
} = {}) {
  const cards = [];
  for (const participant of Array.isArray(participants) ? participants : []) {
    const resolvedId = String(resolveLid(participant?.id || "") || "");
    const number = String(
      participant?.pn
        ? String(participant.pn).replace(/\D/g, "")
        : cleanNumber(resolvedId),
    );
    if (!number || number.length < 5) continue;
    if (resolvedId.endsWith("@lid") && !participant?.pn && number === resolvedId.split("@")[0]) {
      continue;
    }

    // Group VCF names come only from the participant record returned by
    // groupMetadata. Never consult the bot's global contacts or push-name cache.
    // When no profile/username is present, use "User <number>" so FN never contains
    // a bare phone number, raw LID, or "No name".
    const rawName = [
      participant?.name,
      participant?.notify,
      participant?.verifiedName,
      participant?.pushName,
      participant?.pushname,
      participant?.displayName,
      participant?.contactName,
      participant?.username,
    ].map(cleanName).find(Boolean);

    const name = rawName || `User ${number}`;

    cards.push([
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${escapeVCardText(name)}`,
      `TEL;type=CELL;type=VOICE;waid=${number}:+${number}`,
      "END:VCARD",
      "",
    ].join("\n"));
  }

  return {
    content: cards.join(""),
    savedCount: cards.length,
    skippedCount: (Array.isArray(participants) ? participants.length : 0) - cards.length,
  };
}

module.exports = { buildGroupVcf, escapeVCardText };
