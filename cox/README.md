# cox

Local drop-in helper for the gktw adapter.

- `@itsreimau/gktw` is 404 on npm and on GitHub; until a real release appears,
  this package lives in the repo and exposes the same call surface so the
  adapter at `mias/handlers/gktwAdapter.js` lights up automatically when cox
  is installed.
- All operations are thin wrappers around `@whiskeysockets/baileys`.
- Wired into `start.sh` and added as a `file:` dependency in `mias/package.json`.

## API

```
prepareWAMessageMedia(...)
downloadContentFromMessage(...)
jidNormalizedUser(...)
getContentType(...)
sendPoll(...)
sendRichInteractive({ sock, jid, text, footer, title, subtitle, image, buttons, listSections, style })
sendHeroCard(spec)
sendCarousel(spec)
sendList(spec)
createInteractiveMessage(spec)
```
