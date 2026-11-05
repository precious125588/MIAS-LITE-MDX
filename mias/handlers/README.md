# MIAS Handler System — Architecture Reference  v4

```
Commands
    ↓
MIAS Handlers  ← single import point for all commands
    ↓
Baileys Adapter  (baileysHandler.js routes through gktwAdapter.js)
    ↓
GKTW Helper  (auto-detected; Baileys fallback when absent)
    ↓
WhatsApp
```

## Rule: Commands NEVER import Baileys or GKTW directly

All messaging goes through the handler system. The Baileys Adapter (`gktwAdapter.js`) is the **only** layer that communicates with `@whiskeysockets/baileys` or `@itsreimau/gktw`.

---

## Files

| File | Purpose |
|------|---------|
| `baileysHandler.js` | **Main entry point.** Re-exports all sibling handlers + new v4 layers. Single import for every command. |
| `gktwAdapter.js` | **Baileys Adapter + GKTW integration.** Only file touching Baileys/GKTW. Provides `smartSend()`, `sendInteractiveMessage()`, `sendPoll()`, `getGroupMetadata()`, `generateContextInfo()`, `generateExternalAdReply()`, proto access, and all low-level wrappers. |
| `uiHandler.js` | **UI Manager.** `UI.openHome()`, `UI.openCategory()`, `UI.openCommandList()`, `UI.openWizard()`, `UI.goHome()`, `UI.goBack()`, `UI.refresh()`, `UI.close()`, `UI.showHeroBanner()`, `UI.showProfileCard()`, `UI.showCommandHelp()`, `UI.showError()`, `UI.showSuccess()`, `UI.showLoading()`. Commands never build menus manually. |
| `menuConfig.js` | **Single source of truth** for all menu categories and commands. Edit here to add/remove categories — no other menu code changes needed. |
| `eventHooks.js` | **Event hook system.** `onHook()`, `offHook()`, `emitHook()`, `withCommandHooks()`. Supports: `beforeCommand`, `afterCommand`, `beforeSend`, `afterSend`, `beforeDownload`, `afterDownload`, `beforeUpload`, `afterUpload`, `beforeInteractive`, `afterInteractive`, `beforeReaction`, `afterReaction`, `onError`. |
| `capabilityHandler.js` | **Feature detection.** `getCapabilities(sock)`, `can(sock, feature)`, `capabilitySummary(sock)`, `invalidateCapabilityCache()`. Detects: nativeFlow, buttons, lists, carousel, heroCards, polls, externalAdReply, contextInfo, albums, editMessage, newsletter, gktw. |
| `globals.js` | Installs all handlers + new v4 globals on `globalThis.__MIAS__` at bot startup. Safe for CJS files via `bridge.cjs`. |
| `bridge.cjs` | CJS proxy bridge. `require('./mias/handlers/bridge.cjs')` forwards every call to `globalThis.__MIAS__`. Use in `case.js`, `nexray_bot.cjs`. |
| `messageHandler.js` | `sendText`, `sendReply` (dual-signature), `sendRaw`, `sendLong`, `sendWithTyping`, `sendTyping`, `sendRead`, `editText`, `sendMention`, `sendPoll` |
| `mediaHandler.js` | `sendImage`, `sendVideo`, `sendGif`, `sendAudio`, `sendVoiceNote`, `sendSticker`, `sendDocument`, `sendMediaFromUrl`, `sendAlbum`, `prepareThumbnail`, `guessMime`, `prepareExternalAdReply`, `prepareContextInfo`. v3: auto-generates `jpegThumbnail`, auto-injects `contextInfo`. |
| `interactiveHandler.js` | `sendButtons`, `sendInteractive`, `sendList`, `sendUrlButtons`, `sendHeroCard`, `sendCarousel`, `sendNativeFlow`, `sendPollInteractive`, `buildExternalAdReply`. v4: emits hooks, uses capabilityHandler. |
| `buttonHandler.js` | `sendCopyButton`, `sendCallButton`, `sendNativeFlow`, `sendContactWithButtons`, `autoButton`, `setButtonMode()`, `isButtonMode()`. |
| `buttonMenuHandler.js` | Button Mode navigable menu: `sendButtonHomeScreen`, `sendButtonCategorySelector`, `sendButtonCommandSelector`, `handleCommandSelection`, `handleButtonResponse`. Reads from `menuConfig.js`. |
| `reactionHandler.js` | `sendReaction`, `reactCustom`, `clearReaction`, `reactProcessing`, `reactWaiting`, `reactSuccess`, `reactFail`, `reactError`, `reactLoading`, `reactDownload`, `reactFire`, `reactLike`, `withReactions`, `reactSequence`, `reactSet`, `REACTIONS`, `REACTION_SETS` |
| `menuHandler.js` | `sendMenu` (full bot info + interactive category buttons), `sendCategoryMenu`, `sendCommandCount`. Reads categories from `menuConfig.js`. |
| `wizardHandler.js` | `startWizardSession`, `clearWizardSession`, `hasWizardSession`, `getWizardSession`, `resumeWizardSession`, `listWizardSessions`, `wizardSessionCount`, `handleWizardInput`, `COMMAND_INPUTS`. v2: timeout, cancel, resume, attempt-limit validation. |
| `uploadHandler.js` | `fetchBuffer` (with retry + cache), `generateImageThumbnail`, `generateVideoThumbnail`, `uploadToCatbox`, `uploadMedia`, `cleanupTemp` |
| `downloadHandler.js` | `downloadMedia`, `downloadQuotedMedia`, `downloadViewOnce`, `downloadFromUrl`, `fetchBuffer`, `getMessageType`, `hasMedia` |
| `statusHandler.js` | `getStatusAudience`, `postTextStatus`, `postImageStatus`, `postVideoStatus`, `postAudioStatus`, `postStickerStatus`, `postDocumentStatus` |
| `contactHandler.js` | `buildVCard`, `fetchProfilePic`, `sendContact`, `sendContacts`, `sendBotVCard`, `parseVCard` |
| `forwardHandler.js` | `forwardMessage`, `forwardSilent`, `broadcastForward`, `resendMessage` |
| `codeHandler.js` | `sendCode`, `sendCodeMulti` — code viewer with auto-document fallback for long code |
| `utilityHandler.js` | JID utils, sender helpers, text extraction, timing, formatting, presence, `markRead` |

---

## New in v4

### UI Manager

Commands use `UI.*` instead of building menus manually:

```js
import { UI } from "../../handlers/baileysHandler.js";

// Open the bot home screen
await UI.openHome(sock, jid, msg, { userName: "David" });

// Open a category
await UI.openCategory(sock, jid, msg, "cat_ai");

// Start a wizard for a command
await UI.openWizard(sock, jid, msg, "play");

// Navigate
await UI.goBack(sock, jid, msg);
await UI.close(sock, jid, msg);

// Status screens
await UI.showError(sock, jid, msg, "Something went wrong.");
await UI.showSuccess(sock, jid, msg, "Done!");
```

### Menu Configuration

All categories live in `menuConfig.js`. **To add a new category:**

```js
// In mias/handlers/menuConfig.js — add to MENU_CATEGORIES:
{
  id: "cat_myfeature",
  label: "My Feature",
  cmds: [
    { name: "mycommand", desc: "Does something cool", wizard: true },
  ],
},
```

No other changes required — menus, button screens, and category selectors update automatically.

### Event Hooks

Attach logging, analytics, or plugin behavior without modifying commands:

```js
import { onHook } from "../../handlers/baileysHandler.js";

onHook("afterCommand", async ({ command, jid, duration }) => {
  console.log(`[metrics] ${command} took ${duration}ms in ${jid}`);
});

onHook("onError", async ({ error, command }) => {
  console.error(`[error] ${command}:`, error?.message);
});
```

### Capability Detection

```js
import { getCapabilities, can } from "../../handlers/baileysHandler.js";

const caps = await getCapabilities(sock);
if (caps.nativeFlow) {
  await sendButtons(sock, jid, "Pick one:", buttons);
} else {
  await sendText(sock, jid, "Type a number:");
}

// Shorthand:
if (await can(sock, "polls")) {
  await sendPollMessage(sock, jid, "Vote:", options);
}
```

### Wizard Management

```js
import {
  startWizardSession, clearWizardSession,
  hasWizardSession, resumeWizardSession,
  listWizardSessions, wizardSessionCount,
} from "../../handlers/baileysHandler.js";

// Start a 2-minute session
startWizardSession(senderJid, "play", { timeoutMs: 120_000 });

// Resume after reconnect (extend by 60s)
resumeWizardSession(senderJid);

// Diagnostics
console.log(`Active wizard sessions: ${wizardSessionCount()}`);
console.log(listWizardSessions());
```

---

## Adding New Commands

A new command only needs business logic:

```js
// ESM command:
import * as MIAS from "../../handlers/baileysHandler.js";

export async function weatherCmd(sock, msg, args) {
  const city = args.join(" ") || "Lagos";
  const jid  = msg.key.remoteJid;

  await MIAS.reactProcessing(sock, msg);
  try {
    const data = await fetchWeatherApi(city);
    await MIAS.sendText(sock, jid, `*${city}*\n${data.description}\n${data.temp}°C`, { quoted: msg });
    await MIAS.reactSuccess(sock, msg);
  } catch {
    await MIAS.reactFail(sock, msg);
    await MIAS.sendReply(sock, msg, `Could not fetch weather for *${city}*.`);
  }
}
```

To add a new category for the command above, **only edit `menuConfig.js`**. The menu screens, button screens, and category selectors all update automatically.

---

## GKTW Optional Dependency

`@itsreimau/gktw` is **optional**. The adapter detects it at runtime:

- If installed → GKTW functions are used automatically for interactive messages
- If missing → Baileys proto fallback is used for every feature
- No command or handler needs modification either way

To install GKTW:
```sh
cd mias && npm install @itsreimau/gktw
```

Check status programmatically:
```js
import { isGktwAvailable, gktwVersion, adapterDiagnostics } from "../../handlers/baileysHandler.js";

console.log(await isGktwAvailable()); // true/false
console.log(await gktwVersion());     // "1.2.3" or null
console.log(adapterDiagnostics());    // { gktwAvailable, gktwLoadError, baileysLoaded }
```

---

## ESM / CJS Interoperability

| Context | Files | Module System |
|---------|-------|---------------|
| `mias/` | `index.js`, `handlers/` (except `bridge.cjs`) | **ESM** |
| Root | `case.js`, `bot.js`, `nexray_bot.cjs` | **CommonJS** |

### CJS usage via bridge:

```js
// In case.js or nexray_bot.cjs:
const MIAS = require('./mias/handlers/bridge.cjs');

await MIAS.sendText(sock, jid, "Hello!");
await MIAS.reactSuccess(sock, msg);
await MIAS.sendMenu(sock, jid, msg);

// UI Manager via bridge:
const UI = await MIAS.UI; // proxy resolves to globalThis.__MIAS_UI__
```
