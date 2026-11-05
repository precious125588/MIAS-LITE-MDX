# MIAS Bot — Architecture Overview

## Messaging Architecture

```
Commands (case.js / mias/index.js / mias/nexray_bot.cjs)
        ↓
MIAS Handlers (mias/handlers/baileysHandler.js — single import point)
        ↓
Baileys Adapter (mias/handlers/gktwAdapter.js)
        ↓
GKTW Helper (@itsreimau/gktw — auto-detected, Baileys fallback if absent)
        ↓
WhatsApp
```

## Core Principle

**Commands must NEVER import Baileys or GKTW directly.**

All messaging goes through the handler system. The Baileys Adapter (`gktwAdapter.js`) is the **only** layer that communicates with `@whiskeysockets/baileys` or `@itsreimau/gktw`.

## Directory Structure

```
mias/
├── index.js              — Bot entry point (ESM, 37k lines)
├── package.json          — "type": "module" — ESM context
├── handlers/
│   ├── baileysHandler.js — Universal API + main export hub
│   ├── gktwAdapter.js    — ONLY file touching Baileys/GKTW
│   ├── globals.js        — Installs handlers on globalThis.__MIAS__
│   ├── bridge.cjs        — CJS proxy for case.js + nexray_bot.cjs
│   ├── messageHandler.js — Text, reply, long messages
│   ├── mediaHandler.js   — Image, video, audio, sticker, gif, document, album
│   ├── interactiveHandler.js — Buttons, lists, hero cards, carousels
│   ├── buttonHandler.js  — Extended button system + Button Mode
│   ├── reactionHandler.js — Emoji reactions + withReactions() wrapper
│   ├── menuHandler.js    — Bot menu with interactive categories
│   ├── uploadHandler.js  — fetchBuffer, thumbnails, catbox upload
│   ├── downloadHandler.js — downloadMedia, downloadQuotedMedia, viewOnce
│   ├── statusHandler.js  — WhatsApp Status / Story posting
│   ├── contactHandler.js — vCard building and sending
│   ├── forwardHandler.js — Message forwarding
│   ├── codeHandler.js    — Code viewer (text + document fallback)
│   ├── utilityHandler.js — JID utils, text extraction, timing helpers
│   └── README.md         — Full API reference
├── lib/
│   ├── kevdraPatches.js  — Stability: session health, resource monitor
│   ├── stickerCmd.js     — Sticker-to-command binding system
│   ├── autoDownloader.js — Auto social media downloader
│   └── ...
└── api.js                — API routing (ZeroAPI → Prexzy → Nexray fallback)
```

## Shared infrastructure engines

Reusable infrastructure lives under `mias/lib/engines/` and is intentionally
isolated from command and handler logic. Existing commands do not need to
change to use these modules.

- `httpClient.cjs` — shared Axios client with URL validation, timeouts,
  response-size limits, exponential retries, and safe idempotent retry rules.
- `fileDetection.cjs` — magic-byte media detection with image, video, audio,
  GIF, sticker, PDF, archive, and document categories.
- `mediaEngine.cjs` — normalized image/video/audio/voice-note/document/sticker
  payloads plus sequential album sending.
- `imageProcessing.cjs` — Jimp resize, crop, overlay, blur, watermark, and
  bounded optimization helpers using the existing Jimp-compatible API.
- `canvasEngine.cjs`, `svgEngine.cjs`, and `cardEngine.cjs` — lazy-loaded
  native renderers (`@napi-rs/canvas` first, `canvas` fallback) and reusable
  hero, thumbnail, profile, music, rank, menu, welcome, goodbye, dashboard,
  and AI card builders.
- `linkPreview.cjs`, `stickerEngine.cjs`, and `speedTest.cjs` — reusable
  metadata, sticker, and network measurement helpers.
- `mias/lib/dev/moduleWatcher.mjs` — development-only chokidar watcher.
  Production startup does not load it.
- `mias/lib/engineRegistry.cjs` — singleton registry that initializes the
  reusable engines once, exposes stable aliases (`graphics`, `preview`, `file`,
  and `speed`), reports isolated engine failures, and records GKTW/Baileys
  fallback status.

The engine modules use CommonJS to remain compatible with the root CJS runtime
and are loaded lazily where native dependencies are involved. This keeps
pairing, sessions, Baileys, GKTW fallback behavior, and existing commands
independent of optional infrastructure.

Handlers expose the registry through `getEngineRegistry()`, `getEngine()`, and
`engineStatus()`. CJS modules can use the same services through
`mias/handlers/bridge.cjs` (`MIAS.engines`, `MIAS.getEngine()`, and
`MIAS.engineStatus()`).

Command/API compatibility modules use `mias/lib/engineAccess.cjs` or
`mias/lib/engineAccess.js`. These preserve the existing Axios, Jimp, and
File Type call signatures while routing them through the registered engines.
The protected `case.js` command file, pairing boundary, and protected
`mias/index.js` startup compatibility shim retain their direct imports
intentionally; new and unprotected command/API modules use the registry.

## ESM/CJS Interoperability

The project has two contexts:

| Context | Files | Module System |
|---------|-------|---------------|
| **mias/** | `mias/index.js`, `mias/handlers/` (except bridge.cjs) | **ESM** (`type: module`) |
| **Root** | `case.js`, `bot.js`, `server.js`, `nexray_bot.cjs` | **CommonJS** |

### Bridge Pattern

CJS files access the handler system through `bridge.cjs`:

```js
// In case.js or nexray_bot.cjs:
const MIAS = require('./mias/handlers/bridge.cjs');
await MIAS.sendText(sock, jid, "Hello!");
```

The bridge is a Proxy that forwards calls to `globalThis.__MIAS__`, which `mias/index.js` populates at startup via `globals.js`.

## GKTW Feature Detection

```
sendInteractiveMessage() called
        ↓
Is @itsreimau/gktw installed? → YES → Use GKTW
                               → NO  → Build via Baileys proto
        ↓
WhatsApp receives the message
```

No command-level code changes needed when GKTW is installed or updated.

## Adding a Command (Template)

```js
// ESM command in mias/:
import * as MIAS from "../../handlers/baileysHandler.js";

export async function myCommand(sock, msg, args) {
  await MIAS.reactProcessing(sock, msg);
  // ... business logic ...
  await MIAS.sendText(sock, msg.key.remoteJid, "Result", { quoted: msg });
  await MIAS.reactSuccess(sock, msg);
}

// CJS command in case.js:
const MIAS = require('./mias/handlers/bridge.cjs');
// same API
```

## Future Stability

When Baileys is updated:
- Only `gktwAdapter.js` and possibly `baileysHandler.js` need changes
- All commands continue working without modification

When GKTW is updated:
- Only `gktwAdapter.js` needs changes
- Automatic feature detection handles everything else
