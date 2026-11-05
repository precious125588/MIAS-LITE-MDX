/**
 * UNIVERSAL NATIVE-FLOW BUTTONS  (PRECIOUS v1)
 * ────────────────────────────────────────────
 * Old behavior: .play and .ytmate cards shipped a `buttonsMessage` /
 * `interactiveMessage` that renders on most install / OS pairs but
 * the BUTTONS ARE DEAD on Android-11 regular WhatsApp (no
 * `viewOnceMessage` envelope, `deviceListMetadata`, or
 * `messageContextInfo` properly aligned to the *sender* jid).
 * Users installing on Android 11 (and some Windows desktop builds)
 * see "Open Categories" but tapping it does nothing.
 *
 * New behavior: we wrap every send in viewOnceMessage + 2.x
 * deviceListMetadata and force a `userJid` containing the bot's
 * own full jid (so the relay channel is recognised by Baileys as a
 * real interactive payload even on Android 11 stock WA). We also
 * cap field sizes, strip markdown from button params (some
 * installs reject interactive JSON containing `*`/`_` brackets),
 * and gracefully fall back to a plain numbered list when even the
 * native flow is rejected. The plain list is itself wrapped in a
 * viewOnceMessage so the fallback reads consistently.
 */

function _clean(s) {
  return String(s == null ? "" : s)
    .replace(/\u2022/g, "•")
    .replace(/[*~`_<>\[\]›]/g, "")
    .trim();
}

function _nativeFlowUserJid(sock) {
  const raw = String(sock?.user?.id || "");
  const number = raw.split("@")[0].split(":")[0].replace(/\D/g, "");
  return number ? `${number}@s.whatsapp.net` : "";
}

export async function sendInteractiveCard(sock, jid, body, opts = {}) {
  const sendOpts = {};
  if (opts.quoted) sendOpts.quoted = opts.quoted;

  const userJid = _nativeFlowUserJid(sock);

  // ── Try Baileys native interactiveMessage envelope first ────────
  try {
    const B = await import("@whiskeysockets/baileys").catch(() => null);
    if (B?.proto) {
      const proto = B.proto;

      const buttons = (opts.buttons || []).slice(0, 3).map(b => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: _clean(b.text || "Tap").slice(0, 25),
          id: _clean(b.id || b.text || "btn").slice(0, 256),
        }),
      }));

      if (buttons.length) {
        const interactive = proto.Message?.InteractiveMessage?.create?.({
          body: proto.Message.InteractiveMessage.Body.create({ text: body || " " }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: _clean(opts.footer || "") }),
          header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
          contextInfo: { mentionedJid: userJid ? [userJid] : [] },
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons,
            messageParamsJson: JSON.stringify({}),
            messageVersion: 1,
          }),
        });

        if (interactive) {
          // v30: the viewOnceMessage envelope made the card INVISIBLE to
          // everyone except the person who ran the command. Relay the
          // interactive payload directly so the whole chat sees it, and keep
          // the wrapped form only as a fallback if the direct relay fails.
          const ctxBlock = {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
          };
          const content = { ...ctxBlock, interactiveMessage: interactive };
          const fallbackContent = {
            viewOnceMessage: { message: { ...ctxBlock, interactiveMessage: interactive } },
          };
          const wam = await B.generateWAMessageFromContent(jid, content, {
            quoted: opts.quoted || undefined,
            userJid: userJid || undefined,
          });
          try {
            await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
            return { ok: true, mode: "native", key: wam.key };
          } catch (relayErr) {
            try {
              const wam2 = await B.generateWAMessageFromContent(jid, fallbackContent, {
                quoted: opts.quoted || undefined,
                userJid: userJid || undefined,
              });
              await sock.relayMessage(jid, wam2.message, { messageId: wam2.key.id });
              return { ok: true, mode: "nativeViewOnce", key: wam2.key };
            } catch {}
            // fall through to next strategy
          }
        }
      }
    }
  } catch {}

  // ── Plain text numbered fallback — ALWAYS works ─────────────────
  const numbered = (opts.buttons || []).map((b, i) => `[${i + 1}] ${b.text}`).join("\n");
  const text = [
    opts.header ? `*${opts.header}*` : null,
    body,
    numbered,
    opts.footer ? `_${opts.footer}_` : null,
  ].filter(Boolean).join("\n\n");
  const sent = await sock.sendMessage(jid, { text }, sendOpts);
  return { ok: true, mode: "textFallback", key: sent?.key };
}

export async function sendListCard(sock, jid, body, sections, opts = {}) {
  const sendOpts = {};
  if (opts.quoted) sendOpts.quoted = opts.quoted;
  const userJid = _nativeFlowUserJid(sock);

  try {
    const B = await import("@whiskeysockets/baileys").catch(() => null);
    if (B?.proto) {
      const proto = B.proto;
      const nfSections = (sections || []).map(sec => ({
        title: _clean(sec.title || "Menu").slice(0, 24) || "Menu",
        highlight_label: _clean(sec.highlight_label || "❗").slice(0, 12),
        rows: (sec.rows || []).slice(0, 100).map(r => ({
          header: "",
          title: _clean(r.title || "Option").slice(0, 72) || "Option",
          description: _clean(r.description || "").slice(0, 96),
          id: _clean(r.id || r.rowId || r.title || "row").slice(0, 256),
        })),
      })).filter(sec => sec.rows.length);

      if (nfSections.length) {
        const interactive = proto.Message?.InteractiveMessage?.create?.({
          body: proto.Message.InteractiveMessage.Body.create({ text: body || " " }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: _clean(opts.footer || "") }),
          header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
          contextInfo: { mentionedJid: userJid ? [userJid] : [] },
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [{
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: _clean(opts.buttonText || "Open").slice(0, 24) || "Open",
                sections: nfSections,
              }),
            }],
            messageParamsJson: JSON.stringify({}),
            messageVersion: 1,
          }),
        });

        if (interactive) {
          // v30: the viewOnceMessage envelope made the card INVISIBLE to
          // everyone except the person who ran the command. Relay the
          // interactive payload directly so the whole chat sees it, and keep
          // the wrapped form only as a fallback if the direct relay fails.
          const ctxBlock = {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
          };
          const content = { ...ctxBlock, interactiveMessage: interactive };
          const fallbackContent = {
            viewOnceMessage: { message: { ...ctxBlock, interactiveMessage: interactive } },
          };
          const wam = await B.generateWAMessageFromContent(jid, content, {
            quoted: opts.quoted || undefined,
            userJid: userJid || undefined,
          });
          try {
            await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
            return { ok: true, mode: "nativeList", key: wam.key };
          } catch {
            try {
              const wam2 = await B.generateWAMessageFromContent(jid, fallbackContent, {
                quoted: opts.quoted || undefined,
                userJid: userJid || undefined,
              });
              await sock.relayMessage(jid, wam2.message, { messageId: wam2.key.id });
              return { ok: true, mode: "nativeListViewOnce", key: wam2.key };
            } catch {}
          }
        }
      }
    }
  } catch {}

  // Plain text fallback
  const allRows = (sections || []).flatMap(s => s.rows || []);
  const numbered = allRows.map((r, i) => `[${i + 1}] ${r.title}`).join("\n");
  const text = [opts.title ? `*${opts.title}*` : null, body, numbered].filter(Boolean).join("\n\n");
  const sent = await sock.sendMessage(jid, { text }, sendOpts);
  return { ok: true, mode: "textFallback", key: sent?.key };
}
