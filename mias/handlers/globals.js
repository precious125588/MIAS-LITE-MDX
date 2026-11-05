/**
 * MIAS — Handler Globals Installer  v4
 *
 * Called once at bot startup (from mias/index.js).
 * Installs every handler function onto globalThis.__MIAS__ so CJS files
 * (case.js, nexray_bot.cjs) can access them via the bridge.cjs proxy.
 *
 * Also sets convenience shorthands on globalThis for legacy code.
 *
 * v3 additions:
 *  - Installs UI, eventHooks, capabilityHandler globals
 *  - Installs wizard management globals
 *  - Installs menuConfig globals
 *
 * v4 additions:
 *  - Installs full shared service layer (MIAS.services.*)
 *  - Installs CacheService, LoggerService, QueueService globals
 *  - Installs ConfigService, MetricsService, PermissionService globals
 *  - Installs EventBus globals
 *  - Starts BackgroundTaskManager default tasks
 */

import * as Handlers from "./baileysHandler.js";

let _installed = false;
let _devWatcherStarted = false;

async function startDevelopmentWatcher() {
  if (_devWatcherStarted) return;
  if (process.env.NODE_ENV !== "development" && process.env.MIAS_DEV_WATCH !== "1") return;
  _devWatcherStarted = true;
  try {
    const { startModuleWatcher } = await import("../lib/dev/moduleWatcher.mjs");
    await startModuleWatcher([
      new URL("../handlers", import.meta.url),
      new URL("../lib/engines", import.meta.url),
    ]);
  } catch (error) {
    console.error("[MIAS] Development watcher disabled:", error?.message || error);
  }
}

/**
 * Install all handler functions globally.
 * Safe to call multiple times — always updates the socket,
 * but only installs function shorthands once.
 *
 * @param {object} sock    - Active Baileys socket
 * @param {object} [config] - Bot configuration object
 */
export function installHandlerGlobals(sock, config = {}) {
  // Always update socket + config references
  globalThis.__MIAS_SOCK__   = sock;
  globalThis.__MIAS_CONFIG__ = config;

  if (!_installed) {
    // Initialize all reusable services once before exposing the handler facade.
    // GKTW remains optional; its adapter always retains the Baileys fallback.
    Handlers.initializeEngineRegistry({
      gktw: {
        isAvailable: Handlers.isGktwAvailable,
        getModule: Handlers.gktwModule,
        version: Handlers.gktwVersion,
        diagnostics: Handlers.adapterDiagnostics,
      },
      baileys: {
        getModule: Handlers.baileysModule,
      },
    });

    // ── Full handler namespace ───────────────────────────────────────────────
    globalThis.__MIAS__ = Handlers;

    // ── UI Manager ────────────────────────────────────────────────────────────
    globalThis.__MIAS_UI__              = Handlers.UI;

  // ── Event hooks ────────────────────────────────────────────────────────────
  globalThis.__MIAS_ON_HOOK__         = (event, fn) => Handlers.onHook(event, fn);
  globalThis.__MIAS_OFF_HOOK__        = (event, fn) => Handlers.offHook(event, fn);
  globalThis.__MIAS_EMIT_HOOK__       = (event, ctx) => Handlers.emitHook(event, ctx);

  // ── Capability detection ───────────────────────────────────────────────────
  globalThis.__MIAS_GET_CAPS__        = (sock) => Handlers.getCapabilities(sock);
  globalThis.__MIAS_CAN__             = (sock, feat) => Handlers.can(sock, feat);

  // ── Text messaging ─────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_TEXT__       = (sock, jid, text, opts)          => Handlers.sendText(sock, jid, text, opts);
  globalThis.__MIAS_SEND_REPLY__      = (sock, jidOrMsg, text, q, opts)  => Handlers.sendReply(sock, jidOrMsg, text, q, opts);
  globalThis.__MIAS_SEND_LONG__       = (sock, jid, text, opts)          => Handlers.sendLong(sock, jid, text, opts);
  globalThis.__MIAS_SEND_TYPING__     = (sock, jid, text, opts)          => Handlers.sendWithTyping(sock, jid, text, opts);
  globalThis.__MIAS_SEND_MENTION__    = (sock, jid, text, jids, opts)    => Handlers.sendMention(sock, jid, text, jids, opts);
  globalThis.__MIAS_SEND_POLL__       = (sock, jid, q, opts, sendOpts)   => Handlers.sendPoll(sock, jid, q, opts, sendOpts);

  // ── Media messaging ────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_IMAGE__      = (sock, jid, img, opts)           => Handlers.sendImage(sock, jid, img, opts);
  globalThis.__MIAS_SEND_VIDEO__      = (sock, jid, vid, opts)           => Handlers.sendVideo(sock, jid, vid, opts);
  globalThis.__MIAS_SEND_AUDIO__      = (sock, jid, aud, opts)           => Handlers.sendAudio(sock, jid, aud, opts);
  globalThis.__MIAS_SEND_VOICE__      = (sock, jid, aud, opts)           => Handlers.sendVoiceNote(sock, jid, aud, opts);
  globalThis.__MIAS_SEND_STICKER__    = (sock, jid, s, opts)             => Handlers.sendSticker(sock, jid, s, opts);
  globalThis.__MIAS_SEND_GIF__        = (sock, jid, gif, opts)           => Handlers.sendGif(sock, jid, gif, opts);
  globalThis.__MIAS_SEND_DOC__        = (sock, jid, doc, opts)           => Handlers.sendDocument(sock, jid, doc, opts);
  globalThis.__MIAS_SEND_ALBUM__      = (sock, jid, items, opts)         => Handlers.sendAlbum(sock, jid, items, opts);
  globalThis.__MIAS_SEND_MEDIA_URL__  = (sock, jid, url, opts)           => Handlers.sendMediaFromUrl(sock, jid, url, opts);
  globalThis.__MIAS_SEND_LOCATION__   = (sock, jid, lat, lon, opts)      => Handlers.sendLocation(sock, jid, lat, lon, opts);

  // ── Interactive messaging ──────────────────────────────────────────────────
  globalThis.__MIAS_SEND_BUTTONS__    = (sock, jid, body, btns, opts)    => Handlers.sendButtons(sock, jid, body, btns, opts);
  globalThis.__MIAS_SEND_LIST__       = (sock, jid, body, sects, opts)   => Handlers.sendList(sock, jid, body, sects, opts);
  globalThis.__MIAS_SEND_HERO__       = (sock, jid, params)              => Handlers.sendHeroCard(sock, jid, params);
  globalThis.__MIAS_SEND_CAROUSEL__   = (sock, jid, cards, opts)         => Handlers.sendCarousel(sock, jid, cards, opts);
  globalThis.__MIAS_SEND_POLL_MSG__   = (sock, jid, q, opts, sendOpts)   => Handlers.sendPollMessage(sock, jid, q, opts, sendOpts);

  // ── Reactions ──────────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_REACT__      = (sock, msg, emoji)               => Handlers.sendReaction(sock, msg, emoji);
  globalThis.__MIAS_REACT_OK__        = (sock, msg)                      => Handlers.reactSuccess(sock, msg);
  globalThis.__MIAS_REACT_FAIL__      = (sock, msg)                      => Handlers.reactFail(sock, msg);
  globalThis.__MIAS_REACT_PROC__      = (sock, msg)                      => Handlers.reactProcessing(sock, msg);
  globalThis.__MIAS_REACT_WAIT__      = (sock, msg)                      => Handlers.reactWaiting(sock, msg);
  globalThis.__MIAS_REACT_LOAD__      = (sock, msg)                      => Handlers.reactLoading(sock, msg);
  globalThis.__MIAS_REACT_DL__        = (sock, msg)                      => Handlers.reactDownload(sock, msg);
  globalThis.__MIAS_REACT_FIRE__      = (sock, msg)                      => Handlers.reactFire(sock, msg);
  globalThis.__MIAS_REACT_LIKE__      = (sock, msg)                      => Handlers.reactLike(sock, msg);
  globalThis.__MIAS_REACT_ERR__       = (sock, msg)                      => Handlers.reactError(sock, msg);
  globalThis.__MIAS_REACT_SET__       = (sock, msg, name, ms)            => Handlers.reactSet(sock, msg, name, ms);
  globalThis.__MIAS_REACT_SEQ__       = (sock, msg, emojis, ms)          => Handlers.reactSequence(sock, msg, emojis, ms);
  globalThis.__MIAS_WITH_REACTIONS__  = (sock, msg, fn, opts)            => Handlers.withReactions(sock, msg, fn, opts);

  // ── Contact / vCard ────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_CONTACT__    = (sock, jid, c, opts)             => Handlers.sendContact(sock, jid, c, opts);
  globalThis.__MIAS_SEND_CONTACTS__   = (sock, jid, cs, opts)            => Handlers.sendContacts(sock, jid, cs, opts);
  globalThis.__MIAS_SEND_BOT_VCARD__  = (sock, jid, opts)                => Handlers.sendBotVCard(sock, jid, opts);

  // ── Status (stories) ───────────────────────────────────────────────────────
  globalThis.__MIAS_POST_STATUS_TXT__ = (sock, text, opts)               => Handlers.postTextStatus(sock, text, opts);
  globalThis.__MIAS_POST_STATUS_IMG__ = (sock, img, opts)                => Handlers.postImageStatus(sock, img, opts);
  globalThis.__MIAS_POST_STATUS_VID__ = (sock, vid, opts)                => Handlers.postVideoStatus(sock, vid, opts);
  globalThis.__MIAS_POST_STATUS_AUD__ = (sock, aud, opts)                => Handlers.postAudioStatus(sock, aud, opts);
  globalThis.__MIAS_POST_STATUS_STK__ = (sock, stk, opts)                => Handlers.postStickerStatus(sock, stk, opts);
  globalThis.__MIAS_POST_STATUS_DOC__ = (sock, doc, opts)                => Handlers.postDocumentStatus(sock, doc, opts);

  // ── Forward / delete / edit ────────────────────────────────────────────────
  globalThis.__MIAS_FORWARD__         = (sock, jid, msg, opts)           => Handlers.forwardMessage(sock, jid, msg, opts);
  globalThis.__MIAS_FORWARD_SILENT__  = (sock, jid, msg)                 => Handlers.forwardSilent(sock, jid, msg);
  globalThis.__MIAS_DELETE__          = (sock, jid, key)                 => Handlers.deleteMessage(sock, jid, key);
  globalThis.__MIAS_EDIT__            = (sock, jid, key, text)           => Handlers.editMessage(sock, jid, key, text);

  // ── Download / Upload ──────────────────────────────────────────────────────
  globalThis.__MIAS_DOWNLOAD__        = (msg, type)                      => Handlers.downloadMedia(msg, type);
  globalThis.__MIAS_DL_QUOTED__       = (msg)                            => Handlers.downloadQuotedMedia(msg);
  globalThis.__MIAS_DL_VIEWONCE__     = (msg)                            => Handlers.downloadViewOnce(msg);
  globalThis.__MIAS_DL_URL__          = (url, opts)                      => Handlers.downloadFromUrl(url, opts);
  globalThis.__MIAS_UPLOAD_CATBOX__   = (buf, name, mime)                => Handlers.uploadToCatbox(buf, name, mime);
  globalThis.__MIAS_FETCH_BUFFER__    = (url, opts)                      => Handlers.fetchBuffer(url, opts);

  // ── Group / profile ────────────────────────────────────────────────────────
  globalThis.__MIAS_GROUP_META__      = (sock, jid)                      => Handlers.getGroupMetadata(sock, jid);
  globalThis.__MIAS_PROFILE_PIC__     = (sock, jid)                      => Handlers.getProfilePicture(sock, jid);

  // ── Utility ────────────────────────────────────────────────────────────────
  globalThis.__MIAS_EXTRACT_TEXT__    = (msg)                            => Handlers.extractText(msg);
  globalThis.__MIAS_EXTRACT_BODY__    = (msg)                            => Handlers.extractBody(msg);
  globalThis.__MIAS_GET_QUOTED__      = (msg)                            => Handlers.getQuoted(msg);
  globalThis.__MIAS_GET_MENTIONS__    = (msg)                            => Handlers.getMentions(msg);
  globalThis.__MIAS_EFFECTIVE_SENDER__= (msg)                            => Handlers.getEffectiveSender(msg);
  globalThis.__MIAS_IS_BOT_MSG__      = (msg)                            => Handlers.isBotMessage(msg);
  globalThis.__MIAS_HAS_MEDIA__       = (msg)                            => Handlers.hasMedia(msg);
  globalThis.__MIAS_MARK_READ__       = (sock, msg)                      => Handlers.markRead(sock, msg);

  // ── Code viewer ────────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_CODE__       = (sock, jid, code, opts)          => Handlers.sendCode(sock, jid, code, opts);

  // ── Menu ───────────────────────────────────────────────────────────────────
  globalThis.__MIAS_SEND_MENU__       = (sock, jid, msg, opts)           => Handlers.sendMenu(sock, jid, msg, opts);

  // ── Wizard management ──────────────────────────────────────────────────────
  globalThis.__MIAS_WIZARD_START__    = (jid, cmd, opts)                 => Handlers.startWizardSession(jid, cmd, opts);
  globalThis.__MIAS_WIZARD_CLEAR__    = (jid)                            => Handlers.clearWizardSession(jid);
  globalThis.__MIAS_WIZARD_HAS__      = (jid)                            => Handlers.hasWizardSession(jid);
  globalThis.__MIAS_WIZARD_GET__      = (jid)                            => Handlers.getWizardSession(jid);
  globalThis.__MIAS_WIZARD_RESUME__   = (jid, ms)                        => Handlers.resumeWizardSession(jid, ms);
  globalThis.__MIAS_WIZARD_COUNT__    = ()                               => Handlers.wizardSessionCount();
  globalThis.__MIAS_WIZARD_LIST__     = ()                               => Handlers.listWizardSessions();

    globalThis.__MIAS_ENGINES__       = Handlers.getEngineRegistry();
    globalThis.__MIAS_GET_ENGINE__    = (name) => Handlers.getEngine(name);
    globalThis.__MIAS_ENGINE_STATUS__ = () => Handlers.engineStatus();
    void globalThis.__MIAS_ENGINES__.refreshAdapters();

    // ── v4: Install shared service layer ─────────────────────────────────────
    // Load all services and expose them on globalThis.__MIAS_SERVICES__
    // so that CJS commands (case.js, nexray_bot.cjs) can access them via bridge.
    import("../services/index.js")
      .then((svc) => {
        globalThis.__MIAS_SERVICES__ = svc.default;

        // Individual service shortcuts for CJS bridge convenience
        const S = svc.default;
        globalThis.__MIAS_CACHE__       = S.Cache;
        globalThis.__MIAS_LOGGER__      = S.Logger;
        globalThis.__MIAS_QUEUE__       = S.Queue;
        globalThis.__MIAS_NETWORK__     = S.Network;
        globalThis.__MIAS_CONFIG_SVC__  = S.Config;
        globalThis.__MIAS_METRICS__     = S.Metrics;
        globalThis.__MIAS_MEDIA_SVC__   = S.Media;
        globalThis.__MIAS_IMAGE_SVC__   = S.Image;
        globalThis.__MIAS_STICKER_SVC__ = S.Sticker;
        globalThis.__MIAS_AUDIO_SVC__   = S.Audio;
        globalThis.__MIAS_VIDEO_SVC__   = S.Video;
        globalThis.__MIAS_DL_SVC__      = S.Download;
        globalThis.__MIAS_UL_SVC__      = S.Upload;
        globalThis.__MIAS_PERM_SVC__    = S.Permission;
        globalThis.__MIAS_EVENTS_SVC__  = S.Events;
        globalThis.__MIAS_MSG_BUILDER__ = S.build;

        // Override the plain handler globals with service-powered versions
        // where the service adds caching/queuing/optimization
        globalThis.__MIAS_DOWNLOAD__      = (msg, type)          => S.downloadMedia(msg, type);
        globalThis.__MIAS_DL_QUOTED__     = (msg)                => S.downloadQuoted(msg);
        globalThis.__MIAS_FETCH_BUFFER__  = (url, opts)          => S.fetchBuffer(url, opts);
        globalThis.__MIAS_UPLOAD_CATBOX__ = (buf, name, mime)    => S.uploadToCatbox(buf, name, mime);

        // Start default background tasks once
        import("../services/BackgroundTaskManager.js")
          .then((btm) => btm.startDefaultTasks())
          .catch(() => {});

        // Start ConfigService invalidation on next sock update
        import("../services/ConfigService.js")
          .then((cfg) => cfg.invalidate())
          .catch(() => {});
      })
      .catch((err) => {
        console.error("[MIAS Globals v4] Service layer load error:", err?.message || err);
      });

    _installed = true;
  }

  // Development-only; production startup never imports chokidar.
  void startDevelopmentWatcher();
}

/**
 * Update the active socket reference (called on reconnect / session refresh).
 * @param {object} sock
 */
export function updateHandlerSock(sock) {
  globalThis.__MIAS_SOCK__ = sock;
}
