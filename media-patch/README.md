# MAIS media patch — reliable public media providers

Fixes the bot errors `Download failed: no valid audio file url`,
`All download providers are busy for this link`, and
`Could not load ... content`. Those come from dead upstream domains, not from
your bot code. This patch swaps them for a **fallback chain of living public
APIs**, verified working on 2026-09-23.

## Providers

| Provider | What you get | Key | Verified |
|---|---|---|---|
| **Audius** | Full-length streaming MP3s, auto-rotating discovery nodes | none | ✅ live, returns `audio/mpeg` |
| **Jamendo** | Full legal MP3 downloads (CC artists) | free `JAMENDO_CLIENT_ID` | ✅ live (needs key) |
| **Deezer** | Huge catalog metadata + 30s MP3 previews | none | ✅ live |
| **iTunes Search** | Huge catalog metadata + 30s previews + HD artwork | none | ✅ live |
| **Piped mirrors** | YouTube search/metadata, best-effort stream URLs | none | ⚠️ partial (see below) |
| **YouTube Data v3** | Search/metadata fallback | free `YOUTUBE_API_KEY` | ✅ (quota) |

Checked and rejected: Invidious public instances (403 / disabled), cobalt v7
(shut down Nov 2024), most Piped stream endpoints (YouTube bot-blocks them).

## Install

```bash
cp config/env.example .env    # keys are optional; the chain works without them
node scripts/health.js "yala" # live check of every provider
```

No npm dependencies — uses Node 18+ built-in `fetch`.

## Wire-up

```js
const { audioChain, videoChain } = require('./src/providers');
const { fetchMedia } = require('./src/mediaPipeline');

// .play / .song / the "Audio" button
const track = await fetchMedia(audioChain, userQuery);      // resolves + downloads to /tmp
await sock.sendMessage(jid, {
  audio: { url: track.path },
  mimetype: 'audio/mpeg',
  ptt: false,
}, { quoted: msg });

// .video / option 4
const vid = await fetchMedia(videoChain, userQuery);
if (vid.linkOnly) {
  await sock.sendMessage(jid, { text: `🎬 ${vid.title}\n${vid.url}` }, { quoted: msg });
} else {
  await sock.sendMessage(jid, { video: { url: vid.path }, mimetype: 'video/mp4' }, { quoted: msg });
}
```

Route **every** media command through `fetchMedia` / `resolveMedia` so a single
dead provider can never take the bot down again. Tell the user when a result is
a 30-second preview (`track.preview === true`).

## Speed

- Files over 1 MB download with 6 parallel HTTP Range chunks + exponential
  backoff retries; the old single-threaded download was the real slowness.
- Tune with `DL_CONCURRENCY` / `DL_TIMEOUT` in `.env`.
- Write to `/tmp` (tmpfs) rather than the app directory.

## Honest limits

- YouTube's official API never returns media files (Terms of Service), and the
  public Piped mirrors are rate-limited by YouTube, so full YouTube audio/video
  delivery is not reliable from a free public API. Audius and Jamendo are the
  dependable full-length sources.
- Deezer and iTunes are previews only (30s) — legal and always available.
- No adult-content APIs are included. The "free NSFW APIs" in that space are
  routinely malware-laced or vanish without notice, which is exactly the class
  of failure that broke the bot. Pick a source you trust before wiring one in.
