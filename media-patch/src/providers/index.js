// Provider chains — rewired 2026-09-23.
// princetech is FIRST everywhere (only chain live-verified to return real
// CDN file URLs). Dead providers (gifted, co.wuk.sh cobalt, ryzendesu,
// nexoracle HTML, davidcyril key-gated) removed from every chain.
const princetech = require('./princetech');
const audius = require('./audius');
const jamendo = require('./jamendo');
const deezer = require('./deezer');
const itunes = require('./itunes');
const youtube = require('./youtube');

module.exports = {
  princetech,
  audius,
  jamendo,
  deezer,
  itunes,
  youtube,
  // Audio: real full-length file first, then keyless full/preview fallbacks.
  audioChain: [princetech, audius, jamendo, deezer, itunes],
  // Video: princetech direct mp4 → piped stream extraction → metadata link.
  videoChain: [
    {
      name: 'princetech-video',
      searchTrack: async (query) => princetech.searchVideoTrack(query),
    },
    {
      name: 'piped-video',
      searchTrack: async (query) => {
        const meta = await youtube.searchVideo(query);
        return youtube.resolveStream(meta.videoId, { audioOnly: false });
      },
    },
    {
      name: 'youtube-link',
      searchTrack: async (query) => {
        const meta = await youtube.searchVideo(query);
        return { ...meta, linkOnly: true };
      },
    },
  ],
};
