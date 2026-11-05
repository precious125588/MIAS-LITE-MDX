/**
 * MIAS — Unified Service Facade  v1
 *
 * Single import point for all MIAS services.
 * Commands import from here:
 *
 *   import MIAS from "../services/index.js";
 *   await MIAS.sendImage(sock, jid, buf, { caption: "Hello!" });
 *   await MIAS.reactSuccess(sock, msg);
 *   await MIAS.translate("Hola", "en");
 *
 * Or named imports:
 *   import { sendImage, reactSuccess, translate } from "../services/index.js";
 *
 * Architecture: Commands → MIAS Facade → Services → Handlers → WhatsApp
 */

// ── Core infrastructure services ──────────────────────────────────────────────
export * as Logger     from "./LoggerService.js";
export * as Cache      from "./CacheService.js";
export * as Queue      from "./QueueService.js";
export * as Network    from "./NetworkService.js";
export * as Config     from "./ConfigService.js";
export * as Metrics    from "./MetricsService.js";

// ── Media services ────────────────────────────────────────────────────────────
export * as Image      from "./ImageService.js";
export * as Thumbnail  from "./ThumbnailService.js";
export * as Audio      from "./AudioService.js";
export * as Video      from "./VideoService.js";
export * as Sticker    from "./StickerService.js";
export * as Mime       from "./MimeService.js";

// ── I/O services ──────────────────────────────────────────────────────────────
export * as Download   from "./DownloadService.js";
export * as Upload     from "./UploadService.js";
export * as Media      from "./MediaService.js";

// ── WhatsApp messaging services ───────────────────────────────────────────────
export * as Reaction   from "./ReactionService.js";
export * as Interactive from "./InteractiveService.js";
export * as Menu       from "./MenuService.js";
export * as Context    from "./ContextService.js";

// ── Bot management services ───────────────────────────────────────────────────
export * as Permission   from "./PermissionService.js";
export * as Utility      from "./UtilityService.js";
export * as Events       from "./EventBus.js";
export * as BgTasks      from "./BackgroundTaskManager.js";
export * as Plugins      from "./PluginSystem.js";

// ── Web services ──────────────────────────────────────────────────────────────
export * as LinkPreview  from "./LinkPreviewService.js";
export * as SpeedTest    from "./SpeedTestService.js";

// ── Message builder ───────────────────────────────────────────────────────────
export { build, quick as quickSend } from "./MessageBuilder.js";

// ─── Flat convenience re-exports ──────────────────────────────────────────────
// These allow: import { sendImage, reactSuccess } from "../services/index.js";

// Media sends (most-used)
export { sendImageMedia as sendImage,    sendVideoMedia as sendVideo,
         sendAudioMedia as sendAudio,    sendVoiceMedia as sendVoiceNote,
         sendDocumentMedia as sendDocument, sendStickerMedia as sendSticker,
         sendGifMedia as sendGif,        sendMedia,    sendFromUrl,
         sendAlbumMedia as sendAlbum }   from "./MediaService.js";

// Reactions
export { reactSuccess, reactFail, reactLoading, reactWarning,
         reactProcessing, reactWaiting, reactDownload, reactFire, reactLike,
         withReactions, withCommandReactions,
         reactCustom, clearReaction, reactSet, reactSequence,
         REACTIONS, REACTION_SETS }      from "./ReactionService.js";

// Downloads
export { downloadMedia, downloadQuotedMedia, downloadViewOnce,
         downloadFromUrl, fetchBuffer as fetch }   from "./DownloadService.js";

// Uploads
export { uploadToCatbox, uploadToBaileys }         from "./UploadService.js";

// Interactive
export { sendButtons, sendList, sendHeroCard, sendCarousel,
         sendNativeFlow, sendPoll, buildExternalAdReply }  from "./InteractiveService.js";

// Menu
export { sendMenu, showMainMenu, showCategory }    from "./MenuService.js";

// Context
export { buildAdReply, buildMentionContext,
         buildForwardContext, buildRichContext }   from "./ContextService.js";

// Permissions
export { isOwner, isPremium, isBanned, isAdmin, isBotAdmin,
         checkCooldown, setCooldown }              from "./PermissionService.js";

// Utilities
export { generateId, md5, sha256, base64Encode, base64Decode,
         formatDate, timeAgo, translate, ytSearch, sleep,
         truncate, slugify, capitalize, randomString }     from "./UtilityService.js";

// Logger shortcuts
export { info as log, warn, error as logError, debug } from "./LoggerService.js";

// Cache shortcuts
export { get as cacheGet, set as cacheSet, getOrSet as cacheGetOrSet } from "./CacheService.js";

// Queue shortcuts
export { enqueueMedia, enqueueDownload, enqueueUpload, enqueueAI,
         enqueueThumbnail, enqueueBackground }    from "./QueueService.js";

// Network
export { fetchBuffer as httpGet, getJson, postJson } from "./NetworkService.js";

// Link preview
export { preview as previewLink, sendPreview, formatPreview,
         extractUrl as extractUrlFromText, toAdReply as linkToAdReply,
         prefetch as prefetchLink, isUrl } from "./LinkPreviewService.js";

// Speed test
export { run as runSpeedTest, quickRun as quickSpeedTest,
         sendSpeedTest, format as formatSpeedTest,
         formatCompact as formatSpeedTestCompact } from "./SpeedTestService.js";

// Thumbnail
export { fromImage as thumbFromImage, fromVideo as thumbFromVideo, autoThumb } from "./ThumbnailService.js";

// Image
export { resize as resizeImage, optimize as optimizeImage,
         convert as convertImage }                 from "./ImageService.js";

// Sticker
export { create as createSticker, createAnimated as createAnimatedSticker,
         auto as autoSticker }                     from "./StickerService.js";

// MIME
export { detectBuffer as detectMime, fromExtension as mimeFromExt,
         getCategory as mimeCategory }             from "./MimeService.js";

// EventBus
export { on as onEvent, emit as emitEvent, once as onEventOnce,
         EVENTS }                                  from "./EventBus.js";

// BackgroundTaskManager
export { run as runBackground, schedule as scheduleTask } from "./BackgroundTaskManager.js";

// Config
export { get as getConfig, prefix as getPrefix,
         botName as getBotName, isPublic as isPublicMode } from "./ConfigService.js";

// Metrics
export { recordCommand, recordApiCall, getSummary as getMetrics } from "./MetricsService.js";

// ─── Default export: unified MIAS object ─────────────────────────────────────

import * as _Logger     from "./LoggerService.js";
import * as _Cache      from "./CacheService.js";
import * as _Queue      from "./QueueService.js";
import * as _Network    from "./NetworkService.js";
import * as _Config     from "./ConfigService.js";
import * as _Metrics    from "./MetricsService.js";
import * as _Image      from "./ImageService.js";
import * as _Thumbnail  from "./ThumbnailService.js";
import * as _Audio      from "./AudioService.js";
import * as _Video      from "./VideoService.js";
import * as _Sticker    from "./StickerService.js";
import * as _Mime       from "./MimeService.js";
import * as _Download   from "./DownloadService.js";
import * as _Upload     from "./UploadService.js";
import * as _Media      from "./MediaService.js";
import * as _Reaction   from "./ReactionService.js";
import * as _Interactive from "./InteractiveService.js";
import * as _Menu       from "./MenuService.js";
import * as _Context    from "./ContextService.js";
import * as _Permission from "./PermissionService.js";
import * as _Utility    from "./UtilityService.js";
import * as _Events     from "./EventBus.js";
import * as _BgTasks      from "./BackgroundTaskManager.js";
import * as _Plugins      from "./PluginSystem.js";
import * as _LinkPreview  from "./LinkPreviewService.js";
import * as _SpeedTest    from "./SpeedTestService.js";
import { build as _build, quick as _quick } from "./MessageBuilder.js";

const MIAS = {
  // Service namespaces
  Logger:      _Logger,
  Cache:       _Cache,
  Queue:       _Queue,
  Network:     _Network,
  Config:      _Config,
  Metrics:     _Metrics,
  Image:       _Image,
  Thumbnail:   _Thumbnail,
  Audio:       _Audio,
  Video:       _Video,
  Sticker:     _Sticker,
  Mime:        _Mime,
  Download:    _Download,
  Upload:      _Upload,
  Media:       _Media,
  Reaction:    _Reaction,
  Interactive: _Interactive,
  Menu:        _Menu,
  Context:     _Context,
  Permission:  _Permission,
  Utility:     _Utility,
  Events:      _Events,
  BgTasks:     _BgTasks,
  Plugins:     _Plugins,
  LinkPreview: _LinkPreview,
  SpeedTest:   _SpeedTest,

  // Builder
  build:       _build,
  send:        _quick,

  // Flat convenience methods (most common operations)
  // Media
  sendImage:         _Media.sendImageMedia,
  sendVideo:         _Media.sendVideoMedia,
  sendAudio:         _Media.sendAudioMedia,
  sendVoiceNote:     _Media.sendVoiceMedia,
  sendDocument:      _Media.sendDocumentMedia,
  sendSticker:       _Media.sendStickerMedia,
  sendGif:           _Media.sendGifMedia,
  sendMedia:         _Media.sendMedia,
  sendFromUrl:       _Media.sendFromUrl,
  sendAlbum:         _Media.sendAlbumMedia,
  // Reactions
  reactSuccess:      _Reaction.reactSuccess,
  reactFail:         _Reaction.reactFail,
  reactLoading:      _Reaction.reactLoading,
  reactWarning:      _Reaction.reactWarning,
  reactProcessing:   _Reaction.reactProcessing,
  reactDownload:     _Reaction.reactDownload,
  withReactions:     _Reaction.withReactions,
  withCommandReactions: _Reaction.withCommandReactions,
  // Downloads
  downloadMedia:     _Download.downloadMedia,
  downloadQuoted:    _Download.downloadQuotedMedia,
  downloadFromUrl:   _Download.downloadFromUrl,
  fetchBuffer:       _Download.fetchBuffer,
  fetch:             _Download.fetchBuffer,
  // Uploads
  uploadToCatbox:    _Upload.uploadToCatbox,
  // Interactive
  sendButtons:       _Interactive.sendButtons,
  sendList:          _Interactive.sendList,
  sendHeroCard:      _Interactive.sendHeroCard,
  sendCarousel:      _Interactive.sendCarousel,
  sendMenu:          _Menu.sendMenu,
  sendPoll:          _Interactive.sendPollInteractive,
  // Context
  buildAdReply:      _Context.buildAdReply,
  // Permissions
  isOwner:           _Permission.isOwner,
  isPremium:         _Permission.isPremium,
  isAdmin:           _Permission.isAdmin,
  checkCooldown:     _Permission.checkCooldown,
  setCooldown:       _Permission.setCooldown,
  // Sticker
  createSticker:     _Sticker.create,
  createAnimatedSticker: _Sticker.createAnimated,
  autoSticker:       _Sticker.auto,
  // Utility
  generateId:        _Utility.generateId,
  md5:               _Utility.md5,
  sha256:            _Utility.sha256,
  translate:         _Utility.translate,
  ytSearch:          _Utility.ytSearch,
  sleep:             _Utility.sleep,
  formatDate:        _Utility.formatDate,
  timeAgo:           _Utility.timeAgo,
  truncate:          _Utility.truncate,
  // Config
  getConfig:         _Config.get,
  getPrefix:         _Config.prefix,
  getBotName:        _Config.botName,
  // Logger
  log:               _Logger.info,
  warn:              _Logger.warn,
  error:             _Logger.error,
  debug:             _Logger.debug,
  // Cache
  cacheGet:          _Cache.get,
  cacheSet:          _Cache.set,
  cacheGetOrSet:     _Cache.getOrSet,
  // Queue
  enqueueMedia:      _Queue.enqueueMedia,
  enqueueDownload:   _Queue.enqueueDownload,
  enqueueBackground: _Queue.enqueueBackground,
  // Events
  on:                _Events.on,
  emit:              _Events.emit,
  EVENTS:            _Events.EVENTS,
  // Metrics
  recordCommand:     _Metrics.recordCommand,
  getMetrics:        _Metrics.getSummary,
  // Thumbnail
  thumbFromImage:    _Thumbnail.fromImage,
  thumbFromVideo:    _Thumbnail.fromVideo,
  // Image
  resizeImage:       _Image.resize,
  optimizeImage:     _Image.optimize,
  // Mime
  detectMime:        _Mime.detectBuffer,
  mimeFromExt:       _Mime.fromExtension,
  // Network
  httpGet:           _Network.fetchBuffer,
  getJson:           _Network.getJson,
  postJson:          _Network.postJson,
  // Link preview
  previewLink:       _LinkPreview.preview,
  sendPreview:       _LinkPreview.sendPreview,
  formatPreview:     _LinkPreview.formatPreview,
  extractUrl:        _LinkPreview.extractUrl,
  linkToAdReply:     _LinkPreview.toAdReply,
  prefetchLink:      _LinkPreview.prefetch,
  isUrl:             _LinkPreview.isUrl,
  // Speed test
  runSpeedTest:      _SpeedTest.run,
  quickSpeedTest:    _SpeedTest.quickRun,
  sendSpeedTest:     _SpeedTest.sendSpeedTest,
  formatSpeedTest:   _SpeedTest.format,
};

export default MIAS;
