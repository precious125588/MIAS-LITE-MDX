/**
 * MIAS — Builders Index
 *
 * Single import point for all fluent message builders.
 *
 *   import {
 *     MessageBuilder, MenuBuilder, InteractiveBuilder,
 *     MediaBuilder, ContextBuilder, ExternalAdReplyBuilder,
 *     VCardBuilder, ReactionBuilder, ThumbnailBuilder,
 *   } from "../handlers/builders/index.js";
 *
 *   // Or use factory shorthands:
 *   import { interactive, menu, media, vcard, reaction, thumbnail, context, adReply }
 *     from "../handlers/builders/index.js";
 *
 * The design principle: all builders compose into ONE sendMessage() call.
 * No more image-first-then-buttons-separately anti-pattern.
 */

// ── Named class exports ───────────────────────────────────────────────────────
export { ExternalAdReplyBuilder, adReply }  from "./ExternalAdReplyBuilder.js";
export { ContextBuilder, context }          from "./ContextBuilder.js";
export { ThumbnailBuilder, thumbnail }      from "./ThumbnailBuilder.js";
export { ReactionBuilder, reaction, EMOJIS } from "./ReactionBuilder.js";
export { VCardBuilder, vcard }              from "./VCardBuilder.js";
export { MediaBuilder, media }              from "./MediaBuilder.js";
export { InteractiveBuilder, interactive }  from "./InteractiveBuilder.js";
export { MenuBuilder, menu }               from "./MenuBuilder.js";
export { MIASMessageBuilder, build }        from "./MessageBuilder.js";

// ── Default export: named map ─────────────────────────────────────────────────
import { ExternalAdReplyBuilder, adReply }  from "./ExternalAdReplyBuilder.js";
import { ContextBuilder, context }          from "./ContextBuilder.js";
import { ThumbnailBuilder, thumbnail }      from "./ThumbnailBuilder.js";
import { ReactionBuilder, reaction, EMOJIS } from "./ReactionBuilder.js";
import { VCardBuilder, vcard }              from "./VCardBuilder.js";
import { MediaBuilder, media }              from "./MediaBuilder.js";
import { InteractiveBuilder, interactive }  from "./InteractiveBuilder.js";
import { MenuBuilder, menu }               from "./MenuBuilder.js";
import { MIASMessageBuilder, build }        from "./MessageBuilder.js";

export default {
  // Classes
  ExternalAdReplyBuilder,
  ContextBuilder,
  ThumbnailBuilder,
  ReactionBuilder,
  VCardBuilder,
  MediaBuilder,
  InteractiveBuilder,
  MenuBuilder,
  MIASMessageBuilder,

  // Factory shorthands
  adReply,
  context,
  thumbnail,
  reaction,
  vcard,
  media,
  interactive,
  menu,
  build,

  // Reaction emoji constants
  EMOJIS,
};
