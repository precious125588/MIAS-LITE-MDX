'use strict';
/**
 * nexray.js — Complete wrapper for https://api.nexray.eu.cc (369 endpoints)
 *
 * Categories:
 *   AI(69)  Anime(19)  Berita(10)  Canvas(9)   Downloader(42)
 *   Editor(2)  Ephoto(26)  Fun(2)  Games(8)  Information(9)
 *   Maker(22)  Payment(3)  Primbon(10)  Random(10)  Search(33)
 *   Stalker(15)  Textpro(22)  Tools(57)  Uploader(1)
 *
 * Usage:
 *   const nx = require('./nexray');
 *   const res = await nx.ai.chatgpt({ text: 'hello' });
 *   // text endpoints  → JSON  { result, status, ... }
 *   // image endpoints → { type:'media', contentType:'image/png', buffer:Buffer }
 */

const { httpClient: axios } = require('./mias/lib/engineAccess.cjs');
const FormData = require('form-data');
const fs       = require('fs');

const BASE_URL = 'https://api.nexray.eu.cc';
const TIMEOUT  = 90000; // 90 s — AI/image/video endpoints can be slow

// ── core helpers ──────────────────────────────────────────────────────────────

async function _get(path, params = {}) {
  // remove undefined/null keys
  const p = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p[k] = v;
  }
  const res = await axios.get(BASE_URL + path, {
    params: p,
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'MAIS-MDX-Bot/2.0', 'Accept': '*/*' },
    validateStatus: () => true,
  });
  return _parse(res);
}

async function _post(path, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (Buffer.isBuffer(v))          form.append(k, v,  { filename: k, contentType: 'application/octet-stream' });
    else if (typeof v === 'string' && fs.existsSync(v)) form.append(k, fs.createReadStream(v));
    else                             form.append(k, String(v));
  }
  const res = await axios.post(BASE_URL + path, form, {
    headers: form.getHeaders(),
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });
  return _parse(res);
}

function _parse(res) {
  const ct   = (res.headers['content-type'] || '').toLowerCase();
  const body = Buffer.from(res.data);
  if (ct.includes('application/json') || ct.includes('text/plain')) {
    try { return JSON.parse(body.toString('utf8')); } catch {}
  }
  if (ct.includes('image/') || ct.includes('video/') || ct.includes('audio/')) {
    return { type: 'media', contentType: ct.split(';')[0].trim(), buffer: body };
  }
  try { return JSON.parse(body.toString('utf8')); } catch {}
  return { type: 'raw', contentType: ct, buffer: body };
}

function _req(required, opts) {
  const missing = required.filter(k => !opts[k]);
  if (missing.length) throw new Error(`Missing required params: ${missing.join(', ')}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AI  (69 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ai = {
  /** Chat dengan Alisia AI | text* */
  alisia:       o => { _req(['text'],   o); return _get('/ai/alisia',      { text: o.text }); },
  /** Chat dengan Andisearch AI | text* */
  andisearch:   o => { _req(['text'],   o); return _get('/ai/andisearch',  { text: o.text }); },
  /** AI content humanizer / bypass AI detection | text* */
  bypass:       o => { _req(['text'],   o); return _get('/ai/bypass',      { text: o.text }); },
  /** Chat dengan ChatGPT | text* */
  chatgpt:      o => { _req(['text'],   o); return _get('/ai/chatgpt',     { text: o.text }); },
  /** Chat dengan Claude AI | text* */
  claude:       o => { _req(['text'],   o); return _get('/ai/claude',      { text: o.text }); },
  /** Chat dengan Copilot AI | text* */
  copilot:      o => { _req(['text'],   o); return _get('/ai/copilot',     { text: o.text }); },
  /** Generate images using DeepImg AI | prompt* */
  deepimg:      o => { _req(['prompt'], o); return _get('/ai/deepimg',     { prompt: o.prompt }); },
  /** Deep search with AI | text* */
  deepsearch:   o => { _req(['text'],   o); return _get('/ai/deepsearch',  { text: o.text }); },
  /** Chat dengan DeepSeek | text* */
  deepseek:     o => { _req(['text'],   o); return _get('/ai/deepseek',    { text: o.text }); },
  /** Chat with Dgaf AI | text* */
  dgaf:         o => { _req(['text'],   o); return _get('/ai/dgaf',        { text: o.text }); },
  /** Chat dengan Dolphin AI | text*, template? */
  dolphin:      o => { _req(['text'],   o); return _get('/ai/dolphin',     { text: o.text, template: o.template }); },
  /** Membuat suara dracin TTS | text*, speed?, volume?, music? */
  dracinTts:    o => { _req(['text'],   o); return _get('/ai/dracin-tts',  { text: o.text, speed: o.speed, volume: o.volume, music: o.music }); },
  /** Analisis mimpi dengan AI | text* */
  dreamanalyze: o => { _req(['text'],   o); return _get('/ai/dreamanalyze',{ text: o.text }); },
  /** Chat with Duck AI | text*, model? */
  duck:         o => { _req(['text'],   o); return _get('/ai/duck',        { text: o.text, model: o.model }); },
  /** Academic paper search with Epsilon AI | text* */
  epsilon:      o => { _req(['text'],   o); return _get('/ai/epsilon',     { text: o.text }); },
  /** Chat dengan Felo AI | text* */
  felo:         o => { _req(['text'],   o); return _get('/ai/felo',        { text: o.text }); },
  /** Generate images using Flux AI v1 | prompt* */
  fluxV1:       o => { _req(['prompt'], o); return _get('/ai/v1/flux',     { prompt: o.prompt }); },
  /** Buat pembicaraan menggunakan Gemini TTS | text* */
  geminiTts:    o => { _req(['text'],   o); return _get('/ai/gemini-tts',  { text: o.text }); },
  /** Chat dengan Google Gemini | text* */
  gemini:       o => { _req(['text'],   o); return _get('/ai/gemini',      { text: o.text }); },
  /** Tanya jawab dengan GitaGPT | text* */
  gitagpt:      o => { _req(['text'],   o); return _get('/ai/gitagpt',     { text: o.text }); },
  /** Chat with GLM AI | text*, model? */
  glm:          o => { _req(['text'],   o); return _get('/ai/glm',         { text: o.text, model: o.model }); },
  /** Chat with GPT-3.5 Turbo | text* */
  gpt35:        o => { _req(['text'],   o); return _get('/ai/gpt-3.5-turbo',{ text: o.text }); },
  /** Edit image using GPT Vision | image*(Buffer), param*(prompt) */
  gptimage:     o => { _req(['image','param'], o); return _post('/ai/gptimage', { image: o.image, param: o.param }); },
  /** Check and correct grammar | text* */
  grammarcheck: o => { _req(['text'],   o); return _get('/ai/grammarcheck',{ text: o.text }); },
  /** Chat dengan Hammer AI | text* */
  hammer:       o => { _req(['text'],   o); return _get('/ai/hammer',      { text: o.text }); },
  /** Chat dengan Heck AI | text*, model? */
  heck:         o => { _req(['text'],   o); return _get('/ai/heck',        { text: o.text, model: o.model }); },
  /** Generate image using Ideogram AI | prompt* */
  ideogram:     o => { _req(['prompt'], o); return _get('/ai/ideogram',    { prompt: o.prompt }); },
  /** Generate prompt from image | url* */
  image2prompt: o => { _req(['url'],    o); return _get('/ai/image2prompt',{ url: o.url }); },
  /** Chat dengan IslamCity AI | text* */
  islamcity:    o => { _req(['text'],   o); return _get('/ai/islamcity',   { text: o.text }); },
  /** Chat dengan AI tentang Islam | text* */
  islamic:      o => { _req(['text'],   o); return _get('/ai/islamic',     { text: o.text }); },
  /** Chat with Jadve AI | text* */
  jadve:        o => { _req(['text'],   o); return _get('/ai/jadve',       { text: o.text }); },
  /** Chat dengan Jeeves AI | text* */
  jeeves:       o => { _req(['text'],   o); return _get('/ai/jeeves',      { text: o.text }); },
  /** Chat dengan Kimi AI | text* */
  kimi:         o => { _req(['text'],   o); return _get('/ai/kimi',        { text: o.text }); },
  /** Chat with LlamaCoder AI | text*, model? */
  llamacoder:   o => { _req(['text'],   o); return _get('/ai/llamacoder',  { text: o.text, model: o.model }); },
  /** Chat dengan Lumin AI | text* */
  lumin:        o => { _req(['text'],   o); return _get('/ai/lumin',       { text: o.text }); },
  /** Generate AI images menggunakan MagicStudio | prompt* */
  magicstudio:  o => { _req(['prompt'], o); return _get('/ai/magicstudio', { prompt: o.prompt }); },
  /** Chat with MathGPT | text* */
  mathgpt:      o => { _req(['text'],   o); return _get('/ai/mathgpt',     { text: o.text }); },
  /** Chat dengan Monica AI | text* */
  monica:       o => { _req(['text'],   o); return _get('/ai/monica',      { text: o.text }); },
  /** Chat dengan Morphic AI | text* */
  morphic:      o => { _req(['text'],   o); return _get('/ai/morphic',     { text: o.text }); },
  /** Chat dengan AI tentang Islam (Muslim) | text* */
  muslim:       o => { _req(['text'],   o); return _get('/ai/muslim',      { text: o.text }); },
  /** Modify image based on prompt | image*(Buffer), param*(prompt) */
  nanobanana:   o => { _req(['image','param'], o); return _post('/ai/nanobanana', { image: o.image, param: o.param }); },
  /** Chat with Natalie AI | text* */
  natalie:      o => { _req(['text'],   o); return _get('/ai/Natalie',     { text: o.text }); },
  /** Chat dengan NexRay AI | text* */
  nexray:       o => { _req(['text'],   o); return _get('/ai/nexray',      { text: o.text }); },
  /** Chat dengan Nowtech AI | text* */
  nowtech:      o => { _req(['text'],   o); return _get('/ai/nowtech',     { text: o.text }); },
  /** Chat dengan OpenAI | text* */
  openai:       o => { _req(['text'],   o); return _get('/ai/openai',      { text: o.text }); },
  /** Chat dengan Overchat AI | text* */
  overchat:     o => { _req(['text'],   o); return _get('/ai/overchat',    { text: o.text }); },
  /** Chat dengan Perplexity AI | text* */
  perplexity:   o => { _req(['text'],   o); return _get('/ai/perplexity',  { text: o.text }); },
  /** Chat dengan PowerBrain AI | text* */
  powerbrain:   o => { _req(['text'],   o); return _get('/ai/powerbrain',  { text: o.text }); },
  /** Chat dengan Public AI | text* */
  public:       o => { _req(['text'],   o); return _get('/ai/public',      { text: o.text }); },
  /** Chat with QuillBot AI | text* */
  quillbot:     o => { _req(['text'],   o); return _get('/ai/quillbot',    { text: o.text }); },
  /** Chat dengan Riple AI | text* */
  riple:        o => { _req(['text'],   o); return _get('/ai/riple',       { text: o.text }); },
  /** Chat with SchoolHub AI | text* */
  schoolhub:    o => { _req(['text'],   o); return _get('/ai/schoolhub',   { text: o.text }); },
  /** Chat dengan Screnapp AI | text* */
  screnapp:     o => { _req(['text'],   o); return _get('/ai/screnapp',    { text: o.text }); },
  /** Chat dengan Simi Simi | text* */
  simisimi:     o => { _req(['text'],   o); return _get('/ai/simisimi',    { text: o.text }); },
  /** Chat dengan Skole AI | text* */
  skole:        o => { _req(['text'],   o); return _get('/ai/skole',       { text: o.text }); },
  /** Generate logo | prompt* */
  sologo:       o => { _req(['prompt'], o); return _get('/ai/sologo',      { prompt: o.prompt }); },
  /** Generate stories from prompts | prompt*, mode?, length?, creative? */
  story:        o => { _req(['prompt'], o); return _get('/ai/story',       { prompt: o.prompt, mode: o.mode, length: o.length, creative: o.creative }); },
  /** Generate music using Suno AI | prompt* */
  suno:         o => { _req(['prompt'], o); return _get('/ai/suno',        { prompt: o.prompt }); },
  /** Generate image from text prompt | prompt* */
  text2image:   o => { _req(['prompt'], o); return _get('/ai/v1/text2image',{ prompt: o.prompt }); },
  /** Chat dengan TurboChat AI | text* */
  turbochat:    o => { _req(['text'],   o); return _get('/ai/turbochat',   { text: o.text }); },
  /** Chat dengan Turboseek AI | text* */
  turboseek:    o => { _req(['text'],   o); return _get('/ai/turboseek',   { text: o.text }); },
  /** Chat dengan Venice AI | text* */
  venice:       o => { _req(['text'],   o); return _get('/ai/venice',      { text: o.text }); },
  /** Generate video using Veo2 AI | prompt* */
  veo2:         o => { _req(['prompt'], o); return _get('/ai/veo2',        { prompt: o.prompt }); },
  /** Generate video from image/prompt using Veo3 | prompt* */
  veo3:         o => { _req(['prompt'], o); return _get('/ai/veo3',        { prompt: o.prompt }); },
  /** Generate images menggunakan Vider AI | prompt* */
  vider:        o => { _req(['prompt'], o); return _get('/ai/vider',       { prompt: o.prompt }); },
  /** Search and get AI answers with sources | text* */
  webpilot:     o => { _req(['text'],   o); return _get('/ai/webpilot',    { text: o.text }); },
  /** Chat dengan WhiteRabbitNeo AI | text* */
  whiterabbitneo:o=>{ _req(['text'],   o); return _get('/ai/whiterabbitneo',{ text: o.text }); },
  /** Chat dengan Writesonic AI | text* */
  writesonic:   o => { _req(['text'],   o); return _get('/ai/writesonic',  { text: o.text }); },
  /** Chat dengan YouChat AI | text* */
  youchat:      o => { _req(['text'],   o); return _get('/ai/youchat',     { text: o.text }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ANIME  (19 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const anime = {
  /** Get detailed anime info including episodes | url* */
  anichinDetail:  o => { _req(['url'],   o); return _get('/anime/anichin/detail',  { url: o.url }); },
  /** Get anime list by genre | page? */
  anichinGenre:   o =>                       _get('/anime/anichin/genre',   { page: o?.page }),
  /** Get latest anime list | page? */
  anichinLatest:  o =>                       _get('/anime/anichin/latest',  { page: o?.page }),
  /** Search anime | query* */
  anichinSearch:  o => { _req(['query'], o); return _get('/anime/anichin/search',  { query: o.query }); },
  /** Get anime episodes | url* */
  anichinEpisode: o => { _req(['url'],   o); return _get('/anime/anichin/episode', { url: o.url }); },
  /** Get anime by genre list */
  anichinGenreList:() =>                     _get('/anime/anichin/genre-list'),
  /** Otakudesu anime detail | url* */
  otakudesuDetail:o => { _req(['url'],   o); return _get('/anime/otakudesu/detail',  { url: o.url }); },
  /** Otakudesu ongoing list | page? */
  otakudesuOngoing:o =>                      _get('/anime/otakudesu/ongoing',  { page: o?.page }),
  /** Otakudesu complete list | page? */
  otakudesuComplete:o=>                      _get('/anime/otakudesu/complete', { page: o?.page }),
  /** Otakudesu search | query* */
  otakudesuSearch:o => { _req(['query'], o); return _get('/anime/otakudesu/search',  { query: o.query }); },
  /** Otakudesu episode | url* */
  otakudesuEpisode:o=> { _req(['url'],   o); return _get('/anime/otakudesu/episode', { url: o.url }); },
  /** Samehadaku detail | url* */
  samehadakuDetail:o=>{ _req(['url'],   o); return _get('/anime/samehadaku/detail',  { url: o.url }); },
  /** Samehadaku episode | url* */
  samehadakuEpisode:o=>{ _req(['url'],  o); return _get('/anime/samehadaku/episode', { url: o.url }); },
  /** Samehadaku latest | page? */
  samehadakuLatest:o =>                      _get('/anime/samehadaku/latest',  { page: o?.page }),
  /** Samehadaku search | query* */
  samehadakuSearch:o=>{ _req(['query'], o); return _get('/anime/samehadaku/search',  { query: o.query }); },
  /** Kusonime detail | url* */
  kusonimeDetail: o => { _req(['url'],   o); return _get('/anime/kusonime/detail',   { url: o.url }); },
  /** Kusonime latest | page? */
  kusonimeLatest: o =>                       _get('/anime/kusonime/latest',   { page: o?.page }),
  /** Kusonime search | query* */
  kusonimeSearch: o => { _req(['query'], o); return _get('/anime/kusonime/search',   { query: o.query }); },
  /** Anime quote random */
  quote:          () =>                      _get('/anime/quote'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BERITA / NEWS  (10 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const berita = {
  /** Berita terbaru dari Antara News */
  antara:        () => _get('/berita/antara'),
  /** Berita CNBC Indonesia */
  cnbcindonesia: () => _get('/berita/cnbcindonesia'),
  /** Berita CNN Indonesia */
  cnn:           () => _get('/berita/cnn'),
  /** Berita Detik */
  detik:         () => _get('/berita/detik'),
  /** Berita Kompas */
  kompas:        () => _get('/berita/kompas'),
  /** Berita Liputan6 */
  liputan6:      () => _get('/berita/liputan6'),
  /** Berita Republika */
  republika:     () => _get('/berita/republika'),
  /** Berita Tempo */
  tempo:         () => _get('/berita/tempo'),
  /** Berita Tribun */
  tribun:        () => _get('/berita/tribun'),
  /** Berita VIVA */
  viva:          () => _get('/berita/viva'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CANVAS  (9 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const canvas = {
  /** Membuat gambar dengan template Gura | url* */
  gura:       o => { _req(['url'], o); return _get('/canvas/gura',       { url: o.url }); },
  /** Tribun JMK48 Twibbon | url* */
  jmk:        o => { _req(['url'], o); return _get('/canvas/jmk',        { url: o.url }); },
  /** Canvas lirik musik | url*, text* */
  lirik:      o => { _req(['url','text'], o); return _get('/canvas/lirik', { url: o.url, text: o.text }); },
  /** Canvas ship/couple | url1*, url2* */
  ship:       o => { _req(['url1','url2'], o); return _get('/canvas/ship', { url1: o.url1, url2: o.url2 }); },
  /** Canvas wanted poster | url* */
  wanted:     o => { _req(['url'], o); return _get('/canvas/wanted',     { url: o.url }); },
  /** Canvas wasted overlay | url* */
  wasted:     o => { _req(['url'], o); return _get('/editor/wasted', { url: o.url }); },
  /** Generate music card | judul*, nama*, image_url* */
  musiccard:  o => { _req(['judul','nama','image_url'], o); return _get('/canvas/musiccard', { judul: o.judul, nama: o.nama, image_url: o.image_url }); },
  /** Canvas pixelate | url* */
  pixelate:   o => { _req(['url'], o); return _get('/canvas/pixelate',   { url: o.url }); },
  /** Canvas glass effect | url* */
  glass:      o => { _req(['url'], o); return _get('/canvas/glass',      { url: o.url }); },
  /** Canvas rainbow effect | url* */
  rainbow:    o => { _req(['url'], o); return _get('/canvas/rainbow',    { url: o.url }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DOWNLOADER  (42 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const downloader = {
  /** All-in-one downloader | url* */
  aio:          o => { _req(['url'], o); return _get('/downloader/aio',          { url: o.url }); },
  /** Apple Music downloader | url* */
  applemusic:   o => { _req(['url'], o); return _get('/downloader/applemusic',   { url: o.url }); },
  /** Capcut downloader | url* */
  capcut:       o => { _req(['url'], o); return _get('/downloader/capcut',       { url: o.url }); },
  /** Douyin downloader | url* */
  douyin:       o => { _req(['url'], o); return _get('/downloader/douyin',       { url: o.url }); },
  /** Facebook downloader | url* */
  facebook:     o => { _req(['url'], o); return _get('/downloader/facebook',     { url: o.url }); },
  /** Gdrive downloader | url* */
  gdrive:       o => { _req(['url'], o); return _get('/downloader/gdrive',       { url: o.url }); },
  /** GitHub repo downloader | url* */
  github:       o => { _req(['url'], o); return _get('/downloader/github',       { url: o.url }); },
  /** GoFile downloader | url* */
  gofile:       o => { _req(['url'], o); return _get('/downloader/gofile',       { url: o.url }); },
  /** Google Drive downloader | url* */
  googledrive:  o => { _req(['url'], o); return _get('/downloader/googledrive',  { url: o.url }); },
  /** Instagram downloader | url* */
  instagram:    o => { _req(['url'], o); return _get('/downloader/instagram',    { url: o.url }); },
  /** Instagram story downloader | url* */
  igstory:      o => { _req(['url'], o); return _get('/downloader/igstory',      { url: o.url }); },
  /** Likee downloader | url* */
  likee:        o => { _req(['url'], o); return _get('/downloader/likee',        { url: o.url }); },
  /** Mediafire downloader | url* */
  mediafire:    o => { _req(['url'], o); return _get('/downloader/mediafire',    { url: o.url }); },
  /** Mega.nz downloader | url* */
  mega:         o => { _req(['url'], o); return _get('/downloader/mega',         { url: o.url }); },
  /** ML Skin downloader | url* */
  mlskin:       o => { _req(['url'], o); return _get('/downloader/mlskin',       { url: o.url }); },
  /** Pinterest downloader | url* */
  pinterest:    o => { _req(['url'], o); return _get('/downloader/pinterest',    { url: o.url }); },
  /** Pinterest image search | query* */
  pinterestSearch:o=>{ _req(['query'],o); return _get('/downloader/pinterest/search',{ query: o.query }); },
  /** Pixiv downloader | url* */
  pixiv:        o => { _req(['url'], o); return _get('/downloader/pixiv',        { url: o.url }); },
  /** Play Store APK downloader | url* */
  playstore:    o => { _req(['url'], o); return _get('/downloader/playstore',    { url: o.url }); },
  /** Reddit downloader | url* */
  reddit:       o => { _req(['url'], o); return _get('/downloader/reddit',       { url: o.url }); },
  /** Reels downloader | url* */
  reels:        o => { _req(['url'], o); return _get('/downloader/reels',        { url: o.url }); },
  /** Saavn music downloader | url* */
  saavn:        o => { _req(['url'], o); return _get('/downloader/saavn',        { url: o.url }); },
  /** SaveFrom downloader | url* */
  savefrom:     o => { _req(['url'], o); return _get('/downloader/savefrom',     { url: o.url }); },
  /** SoundCloud downloader | url* */
  soundcloud:   o => { _req(['url'], o); return _get('/downloader/soundcloud',   { url: o.url }); },
  /** Spotify downloader | url* */
  spotify:      o => { _req(['url'], o); return _get('/downloader/spotify',      { url: o.url }); },
  /** Sticker WA downloader | url* */
  stickerwa:    o => { _req(['url'], o); return _get('/downloader/stickerwa',    { url: o.url }); },
  /** Threads downloader | url* */
  threads:      o => { _req(['url'], o); return _get('/downloader/threads',      { url: o.url }); },
  /** TikTok downloader | url* */
  tiktok:       o => { _req(['url'], o); return _get('/downloader/tiktok',       { url: o.url }); },
  /** TikTok v1 downloader | url* */
  tiktokV1:     o => { _req(['url'], o); return _get('/downloader/v1/tiktok',    { url: o.url }); },
  /** TikTok v2 downloader | url* */
  tiktokV2:     o => { _req(['url'], o); return _get('/downloader/v2/tiktok',    { url: o.url }); },
  /** Twitter/X downloader | url* */
  twitter:      o => { _req(['url'], o); return _get('/downloader/twitter',      { url: o.url }); },
  /** Twitter v1 downloader | url* */
  twitterV1:    o => { _req(['url'], o); return _get('/downloader/v1/twitter',   { url: o.url }); },
  /** Video downloader generic | url* */
  video:        o => { _req(['url'], o); return _get('/downloader/video',        { url: o.url }); },
  /** Vimeo downloader | url* */
  vimeo:        o => { _req(['url'], o); return _get('/downloader/vimeo',        { url: o.url }); },
  /** WeTV downloader | url* */
  wetv:         o => { _req(['url'], o); return _get('/downloader/wetv',         { url: o.url }); },
  /** YouTube downloader (audio) | url* */
  ytAudio:      o => { _req(['url'], o); return _get('/downloader/ytaudio',      { url: o.url }); },
  /** YouTube downloader (video) | url* */
  ytVideo:      o => { _req(['url'], o); return _get('/downloader/ytvideo',      { url: o.url }); },
  /** YouTube v1 | url* */
  ytV1:         o => { _req(['url'], o); return _get('/downloader/v1/youtube',   { url: o.url }); },
  /** YouTube v2 | url* */
  ytV2:         o => { _req(['url'], o); return _get('/downloader/v2/youtube',   { url: o.url }); },
  /** YouTube mp3 | url* */
  ytmp3:        o => { _req(['url'], o); return _get('/downloader/ytmp3',        { url: o.url }); },
  /** YouTube mp4 | url* */
  ytmp4:        o => { _req(['url'], o); return _get('/downloader/ytmp4',        { url: o.url }); },
  /** Zoho downloader | url* */
  zoho:         o => { _req(['url'], o); return _get('/downloader/zoho',         { url: o.url }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EDITOR  (2 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const editor = {
  /** Wanted poster editor | url* */
  wanted: o => { _req(['url'], o); return _get('/editor/wanted', { url: o.url }); },
  /** Wasted overlay editor | url* */
  wasted: o => { _req(['url'], o); return _get('/editor/wasted', { url: o.url }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EPHOTO  (26 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ephoto = {
  /** Ephoto anime effect | text* */
  /** Convert image to photorealistic | url* */
  real:       o => { _req(['url'],  o); return _get('/ephoto/real',        { url: o.url }); },
  anime:      o => { _req(['text'], o); return _get('/ephoto/anime',      { text: o.text }); },
  /** Ephoto art effect | text* */
  art:        o => { _req(['text'], o); return _get('/ephoto/art',        { text: o.text }); },
  /** Ephoto blood effect | text* */
  blood:      o => { _req(['text'], o); return _get('/ephoto/blood',      { text: o.text }); },
  /** Ephoto blur effect | text* */
  blur:       o => { _req(['text'], o); return _get('/ephoto/blur',       { text: o.text }); },
  /** Ephoto bokeh effect | text* */
  bokeh:      o => { _req(['text'], o); return _get('/ephoto/bokeh',      { text: o.text }); },
  /** Ephoto broken glass | text* */
  brokenglass:o => { _req(['text'], o); return _get('/ephoto/brokenglass',{ text: o.text }); },
  /** Ephoto cartoon effect | text* */
  cartoon:    o => { _req(['text'], o); return _get('/ephoto/cartoon',    { text: o.text }); },
  /** Ephoto fire effect | text* */
  fire:       o => { _req(['text'], o); return _get('/ephoto/fire',       { text: o.text }); },
  /** Ephoto galaxy effect | text* */
  galaxy:     o => { _req(['text'], o); return _get('/ephoto/galaxy',     { text: o.text }); },
  /** Ephoto glitch effect | text* */
  glitch:     o => { _req(['text'], o); return _get('/ephoto/glitch',     { text: o.text }); },
  /** Ephoto gold effect | text* */
  gold:       o => { _req(['text'], o); return _get('/ephoto/gold',       { text: o.text }); },
  /** Ephoto graffiti effect | text* */
  graffiti:   o => { _req(['text'], o); return _get('/ephoto/graffiti',   { text: o.text }); },
  /** Ephoto hacker effect | text* */
  hacker:     o => { _req(['text'], o); return _get('/ephoto/hacker',     { text: o.text }); },
  /** Ephoto ice effect | text* */
  ice:        o => { _req(['text'], o); return _get('/ephoto/ice',        { text: o.text }); },
  /** Ephoto lava effect | text* */
  lava:       o => { _req(['text'], o); return _get('/ephoto/lava',       { text: o.text }); },
  /** Ephoto lightning effect | text* */
  lightning:  o => { _req(['text'], o); return _get('/ephoto/lightning',  { text: o.text }); },
  /** Ephoto matrix effect | text* */
  matrix:     o => { _req(['text'], o); return _get('/ephoto/matrix',     { text: o.text }); },
  /** Ephoto metal effect | text* */
  metal:      o => { _req(['text'], o); return _get('/ephoto/metal',      { text: o.text }); },
  /** Ephoto neon effect | text* */
  neon:       o => { _req(['text'], o); return _get('/ephoto/neon',       { text: o.text }); },
  /** Ephoto ocean effect | text* */
  ocean:      o => { _req(['text'], o); return _get('/ephoto/ocean',      { text: o.text }); },
  /** Ephoto pixel effect | text* */
  pixel:      o => { _req(['text'], o); return _get('/ephoto/pixel',      { text: o.text }); },
  /** Ephoto rainbow effect | text* */
  rainbow:    o => { _req(['text'], o); return _get('/ephoto/rainbow',    { text: o.text }); },
  /** Ephoto retro effect | text* */
  retro:      o => { _req(['text'], o); return _get('/ephoto/retro',      { text: o.text }); },
  /** Ephoto smoke effect | text* */
  smoke:      o => { _req(['text'], o); return _get('/ephoto/smoke',      { text: o.text }); },
  /** Ephoto space effect | text* */
  space:      o => { _req(['text'], o); return _get('/ephoto/space',      { text: o.text }); },
  /** Ephoto wood effect | text* */
  wood:       o => { _req(['text'], o); return _get('/ephoto/wood',       { text: o.text }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FUN  (2 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fun = {
  /** Convert text to alay style | text* */
  alay:      o => { _req(['text'], o); return _get('/fun/alay',      { text: o.text }); },
  /** Get live fun fact */
  livefunfact:() =>                    _get('/fun/livefunfact'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GAMES  (8 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const games = {
  /** Asah otak game */
  asahotak:   () => _get('/games/asahotak'),
  /** Islamic quiz */
  islamic:    () => _get('/games/islamic'),
  /** Siapakah aku game */
  siapakahaku:() => _get('/games/siapakahaku'),
  /** Susun kata game */
  susunkata:  () => _get('/games/susunkata'),
  /** Tebak bendera game */
  tebakbendera:()=> _get('/games/tebakbendera'),
  /** Tebak gambar game */
  tebakgambar:() => _get('/games/tebakgambar'),
  /** Tebak kata game */
  tebakkata:  () => _get('/games/tebakkata'),
  /** Tebak lirik game */
  tebaklirik: () => _get('/games/tebaklirik'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INFORMATION  (9 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const information = {
  /** Cek tagihan PLN | idpel* */
  cektagihanpln:  o => { _req(['idpel'],    o); return _get('/information/cektagihanpln',  { idpel: o.idpel }); },
  /** Cek rekening bank | rekening*, bank* */
  checkRekening:  o => { _req(['rekening','bank'], o); return _get('/information/check-rekening', { rekening: o.rekening, bank: o.bank }); },
  /** Info cuaca | kota* */
  cuaca:          o => { _req(['kota'],     o); return _get('/information/cuaca',          { kota: o.kota }); },
  /** Alias: Weather (English) — uses cuaca endpoint | kota* */
  weather:        o => { const city = o.city || o.kota; if (!city) throw new Error('Missing required params: city or kota'); return _get('/information/cuaca', { kota: city }); },
  /** Kode pos by kota | kota* */
  kodepos:        o => { _req(['kota'],     o); return _get('/information/kodepos',        { kota: o.kota }); },
  /** Info gempa terbaru */
  gempa:          () =>                         _get('/information/gempa'),
  /** Info hari libur nasional */
  hariLibur:      () =>                         _get('/information/hari-libur'),
  /** Info kurs mata uang */
  kurs:           () =>                         _get('/information/kurs'),
  /** Info prakiraan cuaca | kota* */
  prakiraan:      o => { _req(['kota'],     o); return _get('/information/prakiraan',      { kota: o.kota }); },
  /** Info jadwal sholat | kota* */
  sholat:         o => { _req(['kota'],     o); return _get('/information/sholat',         { kota: o.kota }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAKER  (22 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const maker = {
  /** Buat sticker ATTP | text* */
  attp:        o => { _req(['text'],  o); return _get('/maker/attp',         { text: o.text }); },
  /** Buat logo BA | text* */
  balogo:      o => { _req(['text'],  o); return _get('/maker/balogo',       { text: o.text }); },
  /** Buat banner blur | text* */
  bannerBlur:  o => { _req(['text'],  o); return _get('/maker/banner-blur',  { text: o.text }); },
  /** Buat kartu ucapan | text* */
  card:        o => { _req(['text'],  o); return _get('/maker/card',         { text: o.text }); },
  /** Buat fake chat WA | text* */
  fakechat:    o => { _req(['text'],  o); return _get('/maker/fakechat',     { text: o.text }); },
  /** Buat fakegram | username*, text* */
  fakegram:    o => { _req(['username','text'], o); return _get('/maker/fakegram', { username: o.username, text: o.text }); },
  /** Buat fake tweet | username*, text* */
  faketweet:   o => { _req(['username','text'], o); return _get('/maker/faketweet',{ username: o.username, text: o.text }); },
  /** Buat kaligrafi | text* */
  kaligrafi:   o => { _req(['text'],  o); return _get('/maker/kaligrafi',    { text: o.text }); },
  /** Buat kartu nama | text* */
  kartunama:   o => { _req(['text'],  o); return _get('/maker/kartunama',    { text: o.text }); },
  /** Buat meme | text* */
  meme:        o => { _req(['text'],  o); return _get('/maker/meme',         { text: o.text }); },
  /** Buat nulis di tangan | text* */
  nulis:       o => { _req(['text'],  o); return _get('/maker/nulis',        { text: o.text }); },
  /** Buat profil keren | url*, text* */
  profil:      o => { _req(['url','text'], o); return _get('/maker/profil',  { url: o.url, text: o.text }); },
  /** Buat QR code | text* */
  qrcode:      o => { _req(['text'],  o); return _get('/maker/qrcode',       { text: o.text }); },
  /** Buat quote keren | text* */
  quote:       o => { _req(['text'],  o); return _get('/maker/quote',        { text: o.text }); },
  /** Buat sertifikat | text* */
  sertifikat:  o => { _req(['text'],  o); return _get('/maker/sertifikat',   { text: o.text }); },
  /** Buat sticker | text* */
  sticker:     o => { _req(['text'],  o); return _get('/maker/sticker',      { text: o.text }); },
  /** Buat storify | text* */
  storify:     o => { _req(['text'],  o); return _get('/maker/storify',      { text: o.text }); },
  /** Buat tiktok card | text* */
  tiktokcrd:   o => { _req(['text'],  o); return _get('/maker/tiktokcrd',    { text: o.text }); },
  /** Buat watermark | url*, text* */
  watermark:   o => { _req(['url','text'], o); return _get('/maker/watermark',{ url: o.url, text: o.text }); },
  /** Buat welcome card | url*, text* */
  welcome:     o => { _req(['url','text'], o); return _get('/maker/welcome', { url: o.url, text: o.text }); },
  /** Buat youtube thumbnail | text* */
  ytthumb:     o => { _req(['text'],  o); return _get('/maker/ytthumb',      { text: o.text }); },
  /** Buat youtube card | text* */
  ytcard:      o => { _req(['text'],  o); return _get('/maker/ytcard',       { text: o.text }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAYMENT  (3 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const payment = {
  /** Buat QRIS | file*(Buffer) or url* */
  qris:          o => _post('/payment/qris', { file: o.file, url: o.url }),
  /** Cek donasi Saweria | username* */
  saweriaCheck:  o => { _req(['username'], o); return _get('/payment/saweria/check', { username: o.username }); },
  /** Donasi via Saweria | username*, amount* */
  saweriaDonate: o => { _req(['username','amount'], o); return _get('/payment/saweria/donate', { username: o.username, amount: o.amount }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRIMBON  (10 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const primbon = {
  /** Arti nama | nama* */
  artinama:    o => { _req(['nama'],  o); return _get('/primbon/artinama',   { nama: o.nama }); },
  /** Nomor hoki | nomor* */
  nomerhoki:   o => { _req(['nomor'], o); return _get('/primbon/nomerhoki',  { nomor: o.nomor }); },
  /** Ramalan bintang | bintang* */
  ramalanbintang:o=>{ _req(['bintang'],o);return _get('/primbon/ramalanbintang',{ bintang: o.bintang }); },
  /** Ramalan jodoh | nama1*, nama2* */
  ramalanjodoh:o => { _req(['nama1','nama2'], o); return _get('/primbon/ramalanjodoh', { nama1: o.nama1, nama2: o.nama2 }); },
  /** Ramalan mimpi | mimpi* */
  ramalanmimpi:o => { _req(['mimpi'], o); return _get('/primbon/ramalanmimpi',{ mimpi: o.mimpi }); },
  /** Ramalan nama | nama* */
  ramalannama: o => { _req(['nama'],  o); return _get('/primbon/ramalannama',{ nama: o.nama }); },
  /** Ramalan rezeki | tanggal* */
  ramalanrezeki:o=>{ _req(['tanggal'],o);return _get('/primbon/ramalanrezeki',{tanggal:o.tanggal}); },
  /** Ramalan shio | tahun* */
  ramalanshio: o => { _req(['tahun'], o); return _get('/primbon/ramalanshio',{ tahun: o.tahun }); },
  /** Ramalan weton | tanggal*, bulan*, tahun* */
  ramalanweton:o => { _req(['tanggal','bulan','tahun'], o); return _get('/primbon/ramalanweton', { tanggal: o.tanggal, bulan: o.bulan, tahun: o.tahun }); },
  /** Ramalan zodiak | zodiak* */
  ramalanzodiak:o=>{ _req(['zodiak'], o);return _get('/primbon/ramalanzodiak',{ zodiak: o.zodiak }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RANDOM  (10 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const random = {
  /** Random anime gif | type? */
  anime:      o => _get('/random/anime',      { type: o?.type }),
  /** Random Blue Archive image */
  ba:         () => _get('/random/ba'),
  /** Random cat image — uses /random/ba?type=cat (confirmed working) */
  cat:        () => _get('/random/ba', { type: 'cat' }),
  /** Random dog image — uses /random/ba?type=dog (confirmed working) */
  dog:        () => _get('/random/ba', { type: 'dog' }),
  /** Random fact */
  fact:       () => _get('/random/fact'),
  /** Random fox image */
  fox:        () => _get('/random/fox'),
  /** Random meme */
  meme:       () => _get('/random/meme'),
  /** Random quote */
  quote:      () => _get('/random/quote'),
  /** Random waifu image — uses /random/anime?type=waifu (confirmed working) */
  waifu:      () => _get('/random/anime', { type: 'waifu' }),
  /** Random word */
  word:       () => _get('/random/word'),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEARCH  (33 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const search = {
  /** Search 8 font styles | query*, page? */
  font8:          o => { _req(['query'], o); return _get('/search/8font',           { q: o.query, page: o.page }); },
  /** Search Apple Music | query* */
  applemusic:     o => { _req(['query'], o); return _get('/search/applemusic', { q: o.query }); },
  /** Search APK from APKPure | query* */
  apkpure:        o => { _req(['query'], o); return _get('/search/apkpure', { q: o.query }); },
  /** Search dari Canva | query* */
  canva:          o => { _req(['query'], o); return _get('/search/canva', { q: o.query }); },
  /** Search Capcut template | query* */
  capcut:         o => { _req(['query'], o); return _get('/search/capcut', { q: o.query }); },
  /** Search Deezer music | query* */
  deezer:         o => { _req(['query'], o); return _get('/search/deezer', { q: o.query }); },
  /** Search font | query* */
  font:           o => { _req(['query'], o); return _get('/search/font', { q: o.query }); },
  /** Search GitHub repo | query* */
  github:         o => { _req(['query'], o); return _get('/search/github', { q: o.query }); },
  /** Search Google | query* */
  google:         o => { _req(['query'], o); return _get('/search/google', { q: o.query }); },
  /** Search Google Images | query* */
  googleImages:   o => { _req(['query'], o); return _get('/search/googleimage', { q: o.query }); },
  /** Search Google Scholar | query* */
  googleScholar:  o => { _req(['query'], o); return _get('/search/googlescholar', { q: o.query }); },
  /** Search Google News | query* */
  googlenews:     o => { _req(['query'], o); return _get('/search/googlenews', { q: o.query }); },
  /** Search Instagram | query* */
  instagram:      o => { _req(['query'], o); return _get('/search/instagram', { q: o.query }); },
  /** Search Islam QA | query* */
  islamqa:        o => { _req(['query'], o); return _get('/search/islamqa', { q: o.query }); },
  /** Search JKT48 info | query* */
  jkt48:          o => { _req(['query'], o); return _get('/search/jkt48', { q: o.query }); },
  /** Search Lirik lagu | query* */
  lirik:          o => { _req(['query'], o); return _get('/search/lirik', { q: o.query }); },
  /** Alias: Search lyrics by query | query* */
  lyrics:         o => { _req(['query'], o); return _get('/search/lirik', { q: o.query }); },
  /** Search npm package | query* */
  npm:            o => { _req(['query'], o); return _get('/search/npm', { q: o.query }); },
  /** Search Pinterest | query* */
  pinterest:      o => { _req(['query'], o); return _get('/search/pinterest', { q: o.query }); },
  /** Search Play Store | query* */
  playstore:      o => { _req(['query'], o); return _get('/search/playstore', { q: o.query }); },
  /** Search Reddit | query* */
  reddit:         o => { _req(['query'], o); return _get('/search/reddit', { q: o.query }); },
  /** Search Shopee | query* */
  shopee:         o => { _req(['query'], o); return _get('/search/shopee', { q: o.query }); },
  /** Search Soundcloud | query* */
  soundcloud:     o => { _req(['query'], o); return _get('/search/soundcloud', { q: o.query }); },
  /** Search Spotify | query* */
  spotify:        o => { _req(['query'], o); return _get('/search/spotify', { q: o.query }); },
  /** Search Sticker WA | query* */
  stickerwa:      o => { _req(['query'], o); return _get('/search/stickerwa', { q: o.query }); },
  /** Search TikTok | query* */
  tiktok:         o => { _req(['query'], o); return _get('/search/tiktok', { q: o.query }); },
  /** Search Twitter | query* */
  twitter:        o => { _req(['query'], o); return _get('/search/twitter', { q: o.query }); },
  /** Search Wikipedia | query*, lang? */
  wikipedia:      o => { _req(['query'], o); return _get('/search/wikipedia',       { q: o.query, lang: o.lang }); },
  /** Search Wiktionary | query*, lang? */
  wiktionary:     o => { _req(['query'], o); return _get('/search/wiktionary',      { q: o.query, lang: o.lang }); },
  /** Search YouTube | query* */
  youtube:        o => { _req(['query'], o); return _get('/search/youtube', { q: o.query }); },
  /** Search YouTube Music | query* — routed to /search/youtube (ytmusic endpoint not live) */
  youtubeMusic:   o => { _req(['query'], o); return _get('/search/youtube',         { q: o.query }); },
  /** Search Bukalapak | query* */
  bukalapak:      o => { _req(['query'], o); return _get('/search/bukalapak', { q: o.query }); },
  /** Search Tokopedia | query* */
  tokopedia:      o => { _req(['query'], o); return _get('/search/tokopedia', { q: o.query }); },
  /** Search Wallpaper | query* */
  wallpaper:      o => { _req(['query'], o); return _get('/search/wallpaper', { q: o.query }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STALKER  (15 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const stalker = {
  /** Stalk Free Fire | uid*, region? */
  freefire:    o => { _req(['uid'],      o); return _get('/stalker/freefire',    { uid: o.uid, region: o.region }); },
  /** Stalk Genshin Impact | uid* */
  genshin:     o => { _req(['uid'],      o); return _get('/stalker/genshin',     { uid: o.uid }); },
  /** Stalk GitHub | username* */
  github:      o => { _req(['username'], o); return _get('/stalker/github',      { username: o.username }); },
  /** Stalk Instagram | username* */
  instagram:   o => { _req(['username'], o); return _get('/stalker/instagram',   { username: o.username }); },
  /** Stalk ML Mobile Legends | id*, zoneid* */
  ml:          o => { _req(['id','zoneid'], o); return _get('/stalker/ml',       { id: o.id, zoneid: o.zoneid }); },
  /** Stalk NPM package | package* */
  npm:         o => { _req(['package'],  o); return _get('/stalker/npm',         { package: o.package }); },
  /** Stalk Pinterest | username* */
  pinterest:   o => { _req(['username'], o); return _get('/stalker/pinterest',   { username: o.username }); },
  /** Stalk PUBG | username* */
  pubg:        o => { _req(['username'], o); return _get('/stalker/pubg',        { username: o.username }); },
  /** Stalk Reddit | username* */
  reddit:      o => { _req(['username'], o); return _get('/stalker/reddit',      { username: o.username }); },
  /** Stalk Snack Video | username* */
  snackvideo:  o => { _req(['username'], o); return _get('/stalker/snackvideo',  { username: o.username }); },
  /** Stalk Spotify | username* */
  spotify:     o => { _req(['username'], o); return _get('/stalker/spotify',     { username: o.username }); },
  /** Stalk TikTok | username* */
  tiktok:      o => { _req(['username'], o); return _get('/stalker/tiktok',      { username: o.username }); },
  /** Stalk Twitter/X | username* */
  twitter:     o => { _req(['username'], o); return _get('/stalker/twitter',     { username: o.username }); },
  /** Stalk YouTube | username* */
  youtube:     o => { _req(['username'], o); return _get('/stalker/youtube',     { username: o.username }); },
  /** Stalk WhatsApp number | number* */
  whatsapp:    o => { _req(['number'],   o); return _get('/stalker/whatsapp',    { number: o.number }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXTPRO  (22 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const textpro = {
  /** Avengers text effect | text* */
  avengers:    o => { _req(['text'], o); return _get('/textpro/avengers',    { text: o.text }); },
  /** Bear text effect | text* */
  bear:        o => { _req(['text'], o); return _get('/textpro/bear',        { text: o.text }); },
  /** Candy text effect | text* */
  candy:       o => { _req(['text'], o); return _get('/textpro/candy',       { text: o.text }); },
  /** Chrome text effect | text* */
  chrome:      o => { _req(['text'], o); return _get('/textpro/chrome',      { text: o.text }); },
  /** Diamond text effect | text* */
  diamond:     o => { _req(['text'], o); return _get('/textpro/diamond',     { text: o.text }); },
  /** Fire text effect | text* */
  fire:        o => { _req(['text'], o); return _get('/textpro/fire',        { text: o.text }); },
  /** Glitch text effect | text* */
  glitch:      o => { _req(['text'], o); return _get('/textpro/glitch',      { text: o.text }); },
  /** Gold text effect | text* */
  gold:        o => { _req(['text'], o); return _get('/textpro/gold',        { text: o.text }); },
  /** Gradient text effect | text* */
  gradient:    o => { _req(['text'], o); return _get('/textpro/gradient',    { text: o.text }); },
  /** Ice text effect | text* */
  ice:         o => { _req(['text'], o); return _get('/textpro/ice',         { text: o.text }); },
  /** Lava text effect | text* */
  lava:        o => { _req(['text'], o); return _get('/textpro/lava',        { text: o.text }); },
  /** Lightning text effect | text* */
  lightning:   o => { _req(['text'], o); return _get('/textpro/lightning',   { text: o.text }); },
  /** Minecraft text effect | text* */
  minecraft:   o => { _req(['text'], o); return _get('/textpro/minecraft',   { text: o.text }); },
  /** Neon text effect | text* */
  neon:        o => { _req(['text'], o); return _get('/textpro/neon',        { text: o.text }); },
  /** Ocean text effect | text* */
  ocean:       o => { _req(['text'], o); return _get('/textpro/ocean',       { text: o.text }); },
  /** Phantom text effect | text* */
  phantom:     o => { _req(['text'], o); return _get('/textpro/phantom',     { text: o.text }); },
  /** Retro text effect | text* */
  retro:       o => { _req(['text'], o); return _get('/textpro/retro',       { text: o.text }); },
  /** Shadow text effect | text* */
  shadow:      o => { _req(['text'], o); return _get('/textpro/shadow',      { text: o.text }); },
  /** Smoke text effect | text* */
  smoke:       o => { _req(['text'], o); return _get('/textpro/smoke',       { text: o.text }); },
  /** Space text effect | text* */
  space:       o => { _req(['text'], o); return _get('/textpro/space',       { text: o.text }); },
  /** Superstar text effect | text* */
  superstar:   o => { _req(['text'], o); return _get('/textpro/superstar',   { text: o.text }); },
  /** Unicorn text effect | text* */
  unicorn:     o => { _req(['text'], o); return _get('/textpro/unicorn',     { text: o.text }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLS  (57 endpoints)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const tools = {
  /** Buat preset Alight Motion | text* */
  alightmotion:   o => { _req(['text'],    o); return _get('/tools/alightmotion',         { text: o.text }); },
  /** Blur face in image | url* */
  blurface:       o => { _req(['url'],     o); return _get('/tools/blurface',             { url: o.url }); },
  /** Cek broken link | url* */
  brokenlink:     o => { _req(['url'],     o); return _get('/tools/brokenlink',           { url: o.url }); },
  /** Convert currency | amount*, from*, to* */
  currency:       o => { _req(['amount','from','to'], o); return _get('/tools/currency',  { amount: o.amount, from: o.from, to: o.to }); },
  /** DNS lookup | domain* */
  dnslookup:      o => { _req(['domain'],  o); return _get('/tools/dnslookup',            { domain: o.domain }); },
  /** Emoji to GIF | emoji* */
  emojigif:       o => { _req(['emoji'],   o); return _get('/tools/emojigif',             { emoji: o.emoji }); },
  /** Mix two emoji | emoji1*, emoji2* */
  emojimix:       o => { _req(['emoji1','emoji2'], o); return _get('/tools/emojimix',     { emoji1: o.emoji1, emoji2: o.emoji2 }); },
  /** Enhance image quality | url* */
  enhancer:       o => { _req(['url'],     o); return _get('/tools/enhancer',             { url: o.url }); },
  /** Enhance image quality v1 | url* */
  enhancerV1:     o => { _req(['url'],     o); return _get('/tools/v1/enhancer',          { url: o.url }); },
  /** Enhance image quality v2 | url* */
  enhancerV2:     o => { _req(['url'],     o); return _get('/tools/v2/enhancer',          { url: o.url }); },
  /** Swap faces between two images | url1*, url2* */
  faceswap:       o => { _req(['url1','url2'], o); return _get('/tools/faceswap',         { url1: o.url1, url2: o.url2 }); },
  /** Enhance video quality to HD | url* */
  hdvideo:        o => { _req(['url'],     o); return _get('/tools/hdvideo',              { url: o.url }); },
  /** HD video v1 with resolution | url*, resolusi? */
  hdvideoV1:      o => { _req(['url'],     o); return _get('/tools/v1/hdvideo',           { url: o.url, resolusi: o.resolusi }); },
  /** Convert HTML to image | html*, css?, width?, height?, font? */
  html2img:       o => { _req(['html'],    o); return _get('/tools/html2img',             { html: o.html, css: o.css, width: o.width, height: o.height, font: o.font }); },
  /** Convert image to QR code | url* */
  image2qr:       o => { _req(['url'],     o); return _get('/tools/image2qr',            { url: o.url }); },
  /** Parse NIK Indonesia | nik* */
  nikparse:       o => { _req(['nik'],     o); return _get('/tools/nikparse',             { nik: o.nik }); },
  /** Check NSFW content in image | url* */
  nsfwChecker:    o => { _req(['url'],     o); return _get('/tools/nsfw-checker',         { url: o.url }); },
  /** OCR - extract text from image | url* */
  ocr:            o => { _req(['url'],     o); return _get('/tools/ocr',                  { url: o.url }); },
  /** Remini image enhance | url* */
  remini:         o => { _req(['url'],     o); return _get('/tools/remini',               { url: o.url }); },
  /** Remove background from image | url* */
  removebg:       o => { _req(['url'],     o); return _get('/tools/removebg',             { url: o.url }); },
  /** Remove background v1 | url* */
  removebgV1:     o => { _req(['url'],     o); return _get('/tools/v1/removebg',          { url: o.url }); },
  /** Remove background v2 | url* */
  removebgV2:     o => { _req(['url'],     o); return _get('/tools/v2/removebg',          { url: o.url }); },
  /** Remove vocal from audio | url* */
  removevokal:    o => { _req(['url'],     o); return _get('/tools/removevokal',          { url: o.url }); },
  /** Skip Adlinksumo link | url* */
  skipAdlinksumo: o => { _req(['url'],     o); return _get('/tools/skip/adlinksumo',      { url: o.url }); },
  /** Send anonymous NGL messages | url*, pesan*, jumlah* */
  spamngl:        o => { _req(['url','pesan','jumlah'], o); return _get('/tools/spamngl', { url: o.url, pesan: o.pesan, jumlah: o.jumlah }); },
  /** Screenshot website | url*, width?, height? */
  ssweb:          o => { _req(['url'],     o); return _get('/tools/ssweb',                { url: o.url, width: o.width, height: o.height }); },
  /** Find subdomains | domain* */
  subdomainfinder:o => { _req(['domain'],  o); return _get('/tools/subdomainfinder',      { domain: o.domain }); },
  /** Get Telegram sticker pack | url* */
  telegramSticker:o => { _req(['url'],     o); return _get('/tools/telegram-sticker',     { url: o.url }); },
  /** TikTok earnings analytics | username* */
  tiktokearnings: o => { _req(['username'],o); return _get('/tools/tiktokearnings',       { username: o.username }); },
  /** TikTok hashtag analytics | hashtags* */
  tiktokhashtags: o => { _req(['hashtags'],o); return _get('/tools/tiktokhashtags',       { hashtags: o.hashtags }); },
  /** Track IP address | target* */
  trackip:        o => { _req(['target'],  o); return _get('/tools/trackip',              { target: o.target }); },
  /** Translate text | text*, lang* */
  translate:      o => { _req(['text','lang'], o); return _get('/tools/translate',        { text: o.text, lang: o.lang }); },
  /** Google TTS | text* */
  ttsGoogle:      o => { _req(['text'],    o); return _get('/tools/tts-google',           { text: o.text }); },
  /** Unblur image using AI | url* */
  unblur:         o => { _req(['url'],     o); return _get('/tools/unblur',               { url: o.url }); },
  /** Upscale image | url* */
  upscale:        o => { _req(['url'],     o); return _get('/tools/upscale',              { url: o.url }); },
  /** Upscale image v1 | url* */
  upscaleV1:      o => { _req(['url'],     o); return _get('/tools/v1/upscale',           { url: o.url }); },
  /** Upscale image v2 | url* */
  upscaleV2:      o => { _req(['url'],     o); return _get('/tools/v2/upscale',           { url: o.url }); },
  /** Upscale image v3 | url* */
  upscaleV3:      o => { _req(['url'],     o); return _get('/tools/v3/upscale',           { url: o.url }); },
  /** Upscale image v4 | url* */
  upscaleV4:      o => { _req(['url'],     o); return _get('/tools/v4/upscale',           { url: o.url }); },
  /** Upscale image v5 | url* */
  upscaleV5:      o => { _req(['url'],     o); return _get('/tools/v5/upscale',           { url: o.url }); },
  /** Generate usernames | name*, mode?, instansai?, theme? */
  usernamegen:    o => { _req(['name'],    o); return _get('/tools/usernamegen',          { name: o.name, mode: o.mode, instansai: o.instansai, theme: o.theme }); },
  /** Generate virtual credit cards */
  vcc:            () =>                        _get('/tools/vcc'),
  /** Get virtual number OTP | number? */
  virtualNumber:  o => _get('/tools/virtual-number',    { number: o?.number }),
  /** Get virtual number OTP v1 */
  virtualNumberV1:() => _get('/tools/v1/virtual-number'),
  /** Check website phishing | url* */
  webphishing:    o => { _req(['url'],     o); return _get('/tools/webphishing',          { url: o.url }); },
  /** Convert website to ZIP | url* */
  webtozip:       o => { _req(['url'],     o); return _get('/tools/webtozip',             { url: o.url }); },
  /** Identify music from audio URL | url* */
  whatsmusic:     o => { _req(['url'],     o); return _get('/tools/whatsmusic',           { url: o.url }); },
  /** Wink enhance video/image | url*, type?, imagevideo? */
  wink:           o => { _req(['url'],     o); return _get('/tools/wink',                 { url: o.url, type: o.type, imagevideo: o.imagevideo }); },
  /** MLBB win-rate calculator */
  winrateMLBB:    () =>                        _get('/tools/winrate-mlbb'),
  /** Summarize YouTube video v1 | url* */
  ytSummarizeV1:  o => { _req(['url'],     o); return _get('/tools/v1/youtube-summarize', { url: o.url }); },
  /** Summarize YouTube video v2 | url* */
  ytSummarizeV2:  o => { _req(['url'],     o); return _get('/tools/v2/youtube-summarize', { url: o.url }); },
  /** Transcribe YouTube video | url* */
  ytTranscribe:   o => { _req(['url'],     o); return _get('/tools/yt-transcribe',        { url: o.url }); },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UPLOADER  (1 endpoint)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const uploader = {
  /** Upload file to Nexray CDN | file*(Buffer), ttl? */
  upload: o => {
    const _f = o.file || o.buffer;  // accept both param names
    if (!_f) throw new Error('Missing required param: file or buffer');
    return _post('/upload', { file: _f, ttl: o.ttl });
  },
};

// ── exports ───────────────────────────────────────────────────────────────────
module.exports = {
  ai, anime, berita, canvas, downloader, editor, ephoto, fun,
  games, information, maker, payment, primbon, random, search,
  stalker, textpro, tools, uploader,
  // expose raw helpers for custom requests
  _get, _post,
};
