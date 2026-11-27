// =========================================================================
//  precious-anime-edits.cjs  ·  PRECIOUS v24 — anime edits engine
// ─────────────────────────────────────────────────────────────────────────
//  Powers commands like .naruto / .jjk / .demonslayer / .aot / .onepiece …
//
//  Behaviour (per the owner's spec):
//   • reacts ☄️ on every request
//   • drops TWO edits per request
//   • each category keeps two persistent, unique candidate IDs ready in a queue
//   • queue refill shuffles classified repo links, creator pages, and keyword search
//   • successful deliveries are recorded globally so the same TikTok ID is not reused
//   • franchise accuracy is enforced by hashtag/caption validation:
//     Naruto (== Boruto, same franchise) never fetches JJK-only edits, etc.
//     Edits whose hashtags combine franchises live in BOTH category files,
//     so both commands may serve them — exactly as requested.
//   • "no low-life videos": page/search routes require real engagement
//     (digg_count ≥ 1000 or play_count ≥ 10000 when stats are returned)
//   • multiple TikTok APIs with fallback (tikwm primary, then alternates)
//
//  BEGINNER-FRIENDLY: to add more links, just paste TikTok URLs (or the
//  tab-separated lines from the zip) into edits/<category>.txt and to add
//  more pages paste usernames (one per line) into edits/_usernames.txt.
//  Category creators (Cruise, Discipline, Free Fire, FYP, Feeling): one username per
//  line in edits/creators/<key>.txt (cruise.txt, discipline.txt, freefire.txt, fyp.txt,
//  feeling.txt). Add or remove a line; the bot picks it up without a code change.
//  No restart logic needed beyond a normal bot restart.
// =========================================================================
'use strict';

const fs    = require('fs');
const path  = require('path');
const EM = require('./lib/editMatch.cjs');
const NX = require('./lib/miasGate.cjs');
let axios = (typeof globalThis !== 'undefined' && globalThis.axios) ? globalThis.axios : null;
try { if (!axios) axios = require('axios'); } catch {}

// Creator pages are prefetched in the background into a persistent ID queue.
// Media itself is downloaded to a temporary disk file only when delivered, then removed.
const os = require('os');
let CVS = null;
try { CVS = require('./lib/creatorVideoStore.cjs'); } catch (e) {
  // console.log silenced
}
let StatusEditQueue = null;
try { StatusEditQueue = require('./lib/statusEditQueue.cjs').StatusEditQueue; } catch {}
let CVD = null;
try { CVD = require('./lib/tiktokDiskDelivery.cjs'); } catch (e) {
  // console.log silenced
}
// Makes each downloaded edit play in WhatsApp (H.264 remux, or H.264 CRF 18 re-encode
// for HEVC/other codecs; resolution and frame rate are kept).
let WP = null;
try { WP = require('./lib/whatsappPlayable.cjs'); } catch (e) {
  // console.log silenced
}
let TTD = null;
try { TTD = require('./lib/ttDelivery.cjs'); } catch (e) {
  // console.log silenced
}
// Status menu categories process to HD only (no 4K upscale needed).

// ── locate the edits/ folder (repo root) ─────────────────────────────────
function editsDir() {
  const a = path.join(__dirname, '..', 'edits');
  if (fs.existsSync(a)) return a;
  const b = path.join(__dirname, 'edits');
  return fs.existsSync(b) ? b : a;
}

// ── category table: file → franchise tags + command aliases ──────────────
// NOTE: Naruto and Boruto are ONE franchise on purpose (same file, same cmd
// family). JJK + jujutsu_kaisen files are merged. Mixed-hashtag edits are
// already cross-listed inside both franchise files by the zip author.
const CATEGORIES = {
  naruto:        { files: ['naruto_boruto.txt'],                    label: 'Naruto/Boruto',
                   aliases: ['naruto','boruto'],
                   tags: ['naruto','boruto','narutoshippuden','narutoshipuden','borutotwobluevortex','sasuke','itachi','kakashi','obito','madara','minato','sarada','hinata','jiraiya','tsunade','kawaki','obitouchiha','madarauchiha','sasukeuchiha','itachiuchiha','kurama','painakatsuki','shisui','shisuiuchiha','narutouzumaki'] },
  jjk:           { files: ['jjk.txt','jujutsu_kaisen.txt'],         label: 'Jujutsu Kaisen',
                   aliases: ['jjk','jujutsukaisen','jujutsu'],
                   tags: ['jjk','jujutsukaisen','jujustukaisen','gojo','sukuna','yuji','itadori','megumi','toji','nanami','yuta','geto','nobara','choso','hakari','kashimo'] },
  demonslayer:   { files: ['demon_slayer.txt'],                     label: 'Demon Slayer',
                   aliases: ['demonslayer','ds','kny','kimetsunoyaiba'],
                   tags: ['demonslayer','kimetsunoyaiba','kny','tanjiro','nezuko','zenitsu','inosuke','rengoku','muzan','akaza','kokushibo','muichiro','giyu','shinobu','tengen','mitsuri','sanemi'] },
  aot:           { files: ['attack_on_titan.txt'],                  label: 'Attack on Titan',
                   aliases: ['aot','attackontitan','shingeki','snk'],
                   tags: ['attackontitan','aot','shingekinokyojin','snk','eren','yeager','mikasa','levi','ackerman','erwin','armin','reiner','hange'] },
  onepiece:      { files: ['one_piece.txt'],                        label: 'One Piece',
                   aliases: ['onepiece','op'],
                   tags: ['onepiece','onepieceedit','luffy','zoro','sanji','gear5','shanks','kaido','whitebeard','doflamingo','nami','usopp'] },
  dragonball:    { files: ['dragon_ball.txt'],                      label: 'Dragon Ball',
                   aliases: ['dragonball','db','dbz','dbs'],
                   tags: ['dragonball','dbz','dbs','goku','vegeta','gohan','trunks','frieza','broly','gogeta','vegito','supersaiyan','ultrainstinct'] },
  bleach:        { files: ['bleach.txt'],                           label: 'Bleach',
                   aliases: ['bleach'],
                   tags: ['bleach','tybw','ichigo','aizen','byakuya','kenpachi','rukia','ulquiorra','grimmjow','yoruichi','urahara','bankai'] },
  blackclover:   { files: ['black_clover.txt'],                     label: 'Black Clover',
                   aliases: ['blackclover','bc'],
                   tags: ['blackclover','asta','yuno','noelle','yami','mereoleona'] },
  mha:           { files: ['my_hero_academia.txt'],                 label: 'My Hero Academia',
                   aliases: ['mha','myheroacademia','bnha','bokunohero'],
                   tags: ['myheroacademia','mha','bnha','bokunoheroacademia','deku','midoriya','bakugo','bakugou','todoroki','allmight','shigaraki','dabi','toga','aizawa'] },
  mushokutensei: { files: ['mushoku_tensei.txt'],                   label: 'Mushoku Tensei',
                   aliases: ['mushokutensei','mt'],
                   tags: ['mushokutensei','joblessreincarnation','rudeus','roxy','sylphiette','greyrat','orsted'] },
  sololeveling:  { files: ['solo_leveling.txt'],                    label: 'Solo Leveling',
                   aliases: ['sololeveling','sl'],
                   tags: ['sololeveling','sungjinwoo','jinwoo','shadowmonarch','igris','beru','chahaein'] },
  cote:          { files: ['classroom_of_the_elite.txt'],           label: 'Classroom of the Elite',
                   aliases: ['cote','classroomoftheelite'],
                   tags: ['cote','classroomoftheelite','ayanokoji','ayanokouji','kiyotaka','ryuen','horikita','sakayanagi'] },
  tomodachigame: { files: ['tomodachi_game.txt'],                   label: 'Tomodachi Game',
                   aliases: ['tomodachigame','tomodachi'],
                   tags: ['tomodachigame','yuuichi','yuuichikatagiri'] },
  horimiya:      { files: ['horimiya.txt'],                         label: 'Horimiya',
                   aliases: ['horimiya'],
                   tags: ['horimiya','miyamura','horikyoko'] },
  oshinoko:      { files: ['oshi_no_ko.txt'],                       label: 'Oshi no Ko',
                   aliases: ['oshinoko','onk'],
                   tags: ['oshinoko','aihoshino','aquahoshino','rubyhoshino','arimakana'] },
  rezero:        { files: ['re_zero.txt'],                          label: 'Re:Zero',
                   aliases: ['rezero','rz'],
                   tags: ['rezero','subarunatsuki','emilia','rem','echidna','roswaal','beatrice'] },
  vinlandsaga:   { files: ['vinland_saga.txt'],                     label: 'Vinland Saga',
                   aliases: ['vinlandsaga','vinland'],
                   tags: ['vinlandsaga','vinland','thorfinn','askeladd','thorkell','canute'] },
  spiderman:     { files: ['marvel_spiderman.txt'],                 label: 'Marvel/Spider-Man',
                   aliases: ['spiderman','marvel','avengers','mcu'],
                   tags: ['spiderman','marvel','mcu','avengers','peterparker','milesmorales','tomholland','tobeymaguire','ironman','thanos','deadpool','wolverine'] },
  invincible:    { files: ['invincible.txt'],                       label: 'Invincible',
                   aliases: ['invincible'],
                   tags: ['invincible','omniman','markgrayson','viltrumite'] },
  bluelock:      { files: ['blue_lock.txt'],                        label: 'Blue Lock',
                   aliases: ['bluelock','bllk'],
                   tags: ['bluelock','bllk','isagi','bachira','chigiri','nagi','barou','itoshirin','itoshisae','shidou','kunigami','nagiseishiro','baroushoei','bluelockedit'] },
  onepunchman:   { files: ['one_punch_man.txt'],                    label: 'One Punch Man',
                   aliases: ['onepunchman','opm'],
                   tags: ['onepunchman','opm','saitama','genos','garou','tatsumaki','fubuki'] },
  sonic:         { files: ['sonic.txt'],                            label: 'Sonic',
                   aliases: ['sonic'],
                   tags: ['sonic','sonicthehedgehog','shadowthehedgehog','knuckles'] },
  fireforce:     { files: ['fire_force.txt'],                       label: 'Fire Force',
                   aliases: ['fireforce','firef'],
                   tags: ['fireforce','shinra','benimaru','shinrabanshoman'] },
  cruise:        { files: ['cruise.txt'],                           label: 'Cruise',
                   aliases: ['cruise','cruzz','techcruzz'],
                   usernames: ['kingoftechcruzz','mr_vawulencee','kellyreacts02','mrdonduke','gigidroid001'],
                   tags: ['cruise','cruzz','vawulence','kelly','comedy','funny','viral','cruisevideo','cruisetime'] },
  discipline:    { files: ['discipline.txt'],                       label: 'Discipline',
                   aliases: ['discipline','discip','mindset','motivation'],
                   usernames: ['rude_advice','jesse.serna.02','fam0us.mikeey','marcushullaster','breakuptoresilience','aidenheaney','risenexx','churchill___._','quietauthority.exe','mindful_mo','big.body485','relentless__mentality','drleonkessel'],
                   tags: ['discipline','motivation','mindset','grind','focus','mentality','resilience','hardwork','growth','sigma'] },
  freefire:      { files: ['freefire.txt'],                         label: 'Free Fire',
                   aliases: ['freefire','ff','freef'],
                   usernames: ['nexus.120fps_','zoya.120fps','.nur._ff','o1zhik_19','e_s_t_ff','prince.aep5','tik_ff_n','demi_ae1','iamnasboyff','mrvawulencefff','chris_dline4','lyonnn3d_','otc4mena','arnaud.freefire.dancer','nexuss_44','primalhaloleader','aidaa.120fps'],
                   tags: ['freefire','ff','ffedit','garenafreefire','freefireedit','ffhighlights','120fps','freefiremena','free_fire','freefire120fps','freefire_lover','primalhalo','aidaa120fps'] },
  fyp:           { files: ['fyp.txt'],                              label: 'FYP',
                   aliases: ['fyp','foryou','foryoupage'],
                   usernames: ['undead.aep','mentalistfilms','kitostunna','edits.moral','stizzy.mac4','interestingdiscoveriesus','dyuo1200','ragzfr','elyasclaire','patrickjane.viral.videos','factdrop_01','ductuvu8','noisy.neighbor.en','vlados_adventure','mxtn65','maven.stark','mrpio_','solosurvivalking','loveishere36'],
                   tags: ['fyp','foryou','foryoupage','viral','edit','edits','trending','aep','4kedit'] },
  feeling:       { files: ['feeling.txt'],                           label: 'Feeling',
                   aliases: ['feeling'],
                   usernames: ['sandip_sayzz','stevenyeun.intl','doom_yywk','gfx19386'],
                   tags: ['feeling','feelings','emotional','mood','sad','heartbreak','vibes','quotes'] },
  peak:          { files: ['peak.txt'],                            label: 'Peak',
                   aliases: ['peak'],
                   usernames: ['ridley_edit','haykalrz','norx.ae','drxpz.aepp','grmz.edits','krantixxq','polaris.aep0'],
                   tags: ['peak','edit','edits','viral','fyp','targetaudience','larping','larp','4k','120fps','movie','cinema','cinematic'] },
  loveme:        { files: ['loveme.txt'],                          label: 'Love Me',
                   aliases: ['loveme'],
                   searchQuery: ['#lovemeedit', '#loveme'],
                   tags: ['lovemeedit','loveme','lovemeedits'] },
  mood:          { files: ['mood.txt'],                            label: 'Mood',
                   aliases: ['mood'],
                   searchQuery: '#mood',
                   tags: ['mood','moodedits','moodedit'] },
  lyrics:        { files: ['lyrics.txt'],                          label: 'Lyrics',
                   aliases: ['lyrics','lyric'],
                   searchQuery: '#lyricsedit',
                   tags: ['lyricsedit','lyricsedits','lyrics','lyricedit','lyric'] },
  babe:          { files: ['babe.txt'],                            label: 'Babe',
                   aliases: ['babe','baby','bby'],
                   searchQuery: '#caredit',
                   tags: ['caredit','caredits','car'] },
};

// ── tiny fs helpers ───────────────────────────────────────────────────────
function seenPath() { return path.join(editsDir(), '_seen.json'); }
function loadSeen() { try { return JSON.parse(fs.readFileSync(seenPath(), 'utf8')); } catch { return {}; } }
function saveSeen(s) { try { fs.writeFileSync(seenPath(), JSON.stringify(s)); } catch {} }

// Last good creator-page results per category. When every live source is empty or
// cooling down, the request is served from here instead of failing.
function lastGoodPath() {
  return path.join(process.env.NEXSTORE_DIR || path.join(process.cwd(), 'nexstore'), 'last-good-edits.json');
}
function loadLastGood(catKey) {
  try {
    const all = JSON.parse(fs.readFileSync(lastGoodPath(), 'utf8'));
    const items = all && Array.isArray(all[catKey]) ? all[catKey] : [];
    return items.filter((i) => i && i.url);
  } catch { return []; }
}
function saveLastGood(catKey, items) {
  if (!items || !items.length) return;
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(lastGoodPath(), 'utf8')) || {}; } catch {}
    all[catKey] = items.slice(0, 80);
    fs.mkdirSync(path.dirname(lastGoodPath()), { recursive: true });
    fs.writeFileSync(lastGoodPath(), JSON.stringify(all));
  } catch {}
}

const _cache = new Map(); // file -> {mtime, items}
function loadLinkFile(file) {
  const p = path.join(editsDir(), file);
  let mt = 0;
  try { mt = fs.statSync(p).mtimeMs; } catch { return []; }
  const hit = _cache.get(p);
  if (hit && hit.mtime === mt) return hit.items;
  let items = [];
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.includes('tiktok.com')) continue;
      const url = (line.match(/https?:\/\/[^\s]*tiktok\.com[^\s]*/i) || [])[0];
      if (!url) continue;
      const cols = line.split('\t');
      const caption  = cols.length >= 6 ? (cols[3] || '') : '';
      const hashtags = cols.length >= 6 ? (cols[4] || '') : '';
      const play = cols.length >= 7 ? (cols[6] || '') : '';
      items.push({ url: url.trim(), caption, hashtags, play });
    }
  } catch {}
  _cache.set(p, { mtime: mt, items });
  return items;
}
// ── per-category creator lists: edit the text file, no code change ──────
// edits/creators/<key>.txt, one username per line (with or without @).
// Lines starting with # are ignored. When the file exists it is the full list
// for that category, so a line added or removed is used on the next request and
// the next monitor check (about a minute), with no restart. Without the file,
// the built-in list in CATEGORIES is used.
for (const k of Object.keys(CATEGORIES)) CATEGORIES[k].key = k;
// Trims, drops @ and # lines, and removes repeats (case-insensitive) so a handle listed twice is only used once.
function uniqueNames(list) {
  const seen = new Set(); const out = [];
  for (const raw of list || []) {
    const n = String(raw ?? '').trim().replace(/^@/, '').trim();
    if (!n || n.startsWith('#')) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  return out;
}
function categoryCreators(cat) {
  if (!cat) return [];
  try {
    const p = path.join(editsDir(), 'creators', `${cat.key}.txt`);
    return uniqueNames(fs.readFileSync(p, 'utf8').split(/\r?\n/));
  } catch {
    return uniqueNames(cat.usernames || []);
  }
}

function loadUsernames() {
  const p = path.join(editsDir(), '_usernames.txt');
  try {
    return uniqueNames(fs.readFileSync(p, 'utf8').split(/\r?\n/));
  } catch { return []; }
}

// ── http helpers ─────────────────────────────────────────────────────────
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
async function getJson(url, timeout = 15000) {
  const r = await axios.get(url, { headers: UA, timeout, validateStatus: () => true });
  if (r.status >= 400 || !r.data) return null;
  return typeof r.data === 'string' ? (() => { try { return JSON.parse(r.data); } catch { return null; } })() : r.data;
}
// Heavy-download protection: anime video fetches run through the global
// bounded queue so simultaneous anime commands can never spike memory and
// OOM-restart the process. Fails open (direct fetch) if the guard is absent.
let _heavyGuard = null;
try { _heavyGuard = require('./lib/heavyTaskGuard.cjs'); } catch {}
async function getBuf(url, timeout = 90000) {
  const _fetch = async () => {
    const r = await axios.get(url, { headers: { ...UA, Referer: 'https://www.tiktok.com/' }, responseType: 'arraybuffer', timeout, maxContentLength: 400 * 1024 * 1024, validateStatus: () => true });
    if (r.status >= 400) return null;
    const b = Buffer.from(r.data || []);
    return b.length ? b : null;
  };
  if (_heavyGuard && typeof _heavyGuard.runHeavy === 'function') {
    try { return await _heavyGuard.runHeavy(_fetch, { tag: 'anime-edit-dl', timeoutMs: timeout + 30000 }); }
    catch { return null; }    // a failed/timed-out edit download degrades, never crashes
  }
  return _fetch();
}

// ── Shared TikTok info resolver ─────────────────────────────────────────
let _sharedTikTokApi;
async function resolveTikTok(videoUrl) {
  try {
    _sharedTikTokApi ||= import('./features/tiktok.js');
    const { fetchTikTokInfo, ANIME_STATUS_PRIMARY_ORDER } = await _sharedTikTokApi;
    const info = await fetchTikTokInfo(videoUrl, fetch, {
      order: ANIME_STATUS_PRIMARY_ORDER || ['prexzy', 'nexray-aio', 'nexray-tiktok', 'davidcyril-rapid'],
    });
    const bestVideo = info.videoHd || info.videoSd || info.videoWatermark;
    const play = info.videoSd || bestVideo || info.videoWatermark;
    if (!play) return null;
    return {
      title: info.title || 'TikTok edit',
      author: info.author || '',
      play,
      hd: bestVideo || play,
      music: info.audio || '',
      cover: info.thumbnail || info.covers?.[0] || '',
      digg: 0,
      plays: 0,
    };
  } catch (e) {
    
    return null;
  }
}
async function prexzySearch(keywords) {
  try {
    const pxBase = process.env.PREXZY_API || 'https://prexzyapis.com';
    const r = await axios.get(`${pxBase}/search/tiktoksearch?q=` + encodeURIComponent(keywords), {
      headers: UA,
      timeout: 15000,
      validateStatus: () => true,
    });
    const data = r?.data?.data || r?.data?.result;
    if (Array.isArray(data) && data.length) {
      const items = data.map((v) => ({
        id: v.id || v.video_id,
        title: v.title || v.caption || `${keywords} edit`,
        author: { nickname: v.author?.nickname || v.author || 'tiktok' },
        data: v.hdplay || v.play || v.video || v.url,
        stats: { likes: v.digg_count || v.likes || 0, views: v.play_count || v.views || 0 },
      })).filter((v) => v.id && v.data);
      if (items.length) return items;
    }
  } catch {}
  return [];
}

async function animeStatusSearch(keywords) {
  // Anime status categories: Prexzy first, NexRay second
  const pxList = await prexzySearch(keywords).catch(() => []);
  if (pxList && pxList.length) return pxList;

  const nx = await NX.nexrayList('https://api.nexray.eu.cc/search/tiktok?q=' + encodeURIComponent(keywords), 20000);
  if (nx.list && nx.list.length) return nx.list;

  if (!require('./lib/tikwmGate.cjs').isTikwmEnabled()) return [];
  try {
    const d = await getJson('https://www.tikwm.com/api/feed/search?keywords=' + encodeURIComponent(keywords) + '&count=20&hd=1', 15000);
    const arr = d && d.data && d.data.videos;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function nexraySearch(keywords) { return animeStatusSearch(keywords); }
async function tikwmSearch(keywords) { return animeStatusSearch(keywords); }

// ── franchise validation ─────────────────────────────────────────────────
function textOf(item) {
  return String((item.caption || '') + ' ' + (item.hashtags || '') + ' ' + (item.title || '')).toLowerCase().replace(/[#_\-]/g, '');
}
const FRANCHISE_EXCLUSIVE_MARKERS = {
  naruto: ['naruto', 'narutoshippuden', 'boruto', 'sasuke', 'itachi', 'kakashi', 'madara', 'obito', 'minato', 'sarada'],
  demonslayer: ['demonslayer', 'kimetsunoyaiba', 'kny', 'tanjiro', 'nezuko', 'zenitsu', 'rengoku', 'muzan', 'akaza', 'muichiro'],
  onepiece: ['onepiece', 'luffy', 'zoro', 'sanji', 'gear5', 'shanks'],
  jjk: ['jujutsukaisen', 'jjk', 'gojo', 'sukuna', 'yuji', 'megumi', 'toji'],
  aot: ['attackontitan', 'aot', 'shingekinokyojin', 'eren', 'levi', 'mikasa', 'erwin'],
  dragonball: ['dragonball', 'dbz', 'dbs', 'goku', 'vegeta', 'gohan', 'trunks', 'frieza'],
  bleach: ['bleach', 'ichigo', 'aizen', 'byakuya', 'bankai'],
  sololeveling: ['sololeveling', 'sungjinwoo', 'jinwoo', 'shadowmonarch'],
  bluelock: ['bluelock', 'bllk', 'isagi', 'bachira', 'nagi'],
  blackclover: ['blackclover', 'asta', 'yuno', 'yami'],
  mha: ['myheroacademia', 'mha', 'bnha', 'deku', 'bakugo', 'todoroki', 'allmight'],
  cote: ['classroomoftheelite', 'cote', 'ayanokoji', 'ayanokouji', 'kiyotaka'],
  vinlandsaga: ['vinlandsaga', 'vinland', 'thorfinn', 'askeladd'],
  mushokutensei: ['mushokutensei', 'joblessreincarnation', 'rudeus'],
  onepunchman: ['onepunchman', 'opm', 'saitama', 'genos', 'garou'],
  fireforce: ['fireforce', 'shinra', 'benimaru'],
  tomodachigame: ['tomodachigame', 'yuuichi'],
  horimiya: ['horimiya', 'miyamura'],
  oshinoko: ['oshinoko', 'aihoshino', 'aquahoshino'],
  rezero: ['rezero', 'subarunatsuki', 'emilia', 'rem'],
  spiderman: ['spiderman', 'marvel', 'peterparker', 'milesmorales'],
  invincible: ['invincible', 'omniman', 'markgrayson'],
  sonic: ['sonic', 'sonicthehedgehog', 'shadowthehedgehog'],
};

function matchesCat(item, cat) {
  return EM.matchesCategory(item, cat, FRANCHISE_EXCLUSIVE_MARKERS);
}
function parseStatNum(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const str = String(val).trim().toLowerCase();
  const m = str.match(/^([\d.,]+)\s*([kmb])?$/);
  if (!m) return Number(str) || 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return 0;
  const mult = m[2] === 'k' ? 1000 : (m[2] === 'm' ? 1000000 : (m[2] === 'b' ? 1000000000 : 1));
  return Math.round(n * mult);
}

function isPhotoSlider(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.is_slider || v.type === 'image' || v.type === 'slider') return true;
  if (Array.isArray(v.images) && v.images.length > 0) return true;
  if (Array.isArray(v.image_post_info?.images) && v.image_post_info.images.length > 0) return true;
  if (Array.isArray(v.photos) && v.photos.length > 0) return true;
  const playUrl = String(v.data || v.hdplay || v.play || v.url || '');
  if (/\.(?:mp3|m4a|aac)(\?|$)/i.test(playUrl)) return true;
  return false;
}

function qualityOk(v) {
  if (isPhotoSlider(v)) return false;
  const digg = parseStatNum(v.digg_count || v.digg || (v.stats && (v.stats.likes || v.stats.digg_count)) || v.likes || 0);
  const plays = parseStatNum(v.play_count || v.plays || (v.stats && (v.stats.views || v.stats.play_count)) || v.views || 0);
  if (digg > 0 && digg < 1000) return false;      // strictly avoid any videos below 1k likes
  if (!digg && !plays) return true;               // no stats → don't judge
  return digg >= 1000 || plays >= 10000;          // no low-life videos: >= 1k likes or >= 10k views
}

const TIKTOK_SEARCH_CATS = new Set(['loveme', 'mood', 'lyrics', 'lyric', 'babe', 'baby', 'bby']);

// ── routes ────────────────────────────────────────────────────────────────
function routeZip(cat) {
  const out = [];
  for (const f of cat.files || []) out.push(...loadLinkFile(f));
  return out.filter(i => {
    if (TIKTOK_SEARCH_CATS.has(cat.key)) return true;
    return categoryCreators(cat).length ? true : matchesCat(i, cat);
  }).map(i => ({ ...i, src: 'zip', cid: 'zip_' + i.url }));
}
const NO_SHARED_CREATOR_FILES = new Set(['cruise.txt', 'discipline.txt', 'fyp.txt', 'freefire.txt', 'feeling.txt', 'peak.txt', 'loveme.txt', 'mood.txt', 'lyrics.txt', 'babe.txt']);
async function routePages(cat) {
  if (!CVS) return [];
  // Creator categories keep their own creator list exactly as before (no tag filter).
  // edits/_usernames.txt is read for every category too, through the same tag and
  // quality filter as the other sources, so newly added creators reach every command.
  const catNames = categoryCreators(cat);
  const catKeys = new Set(catNames.map(n => n.toLowerCase()));
  // The shared list feeds every anime category except these four, which keep only their own creators.
  const sharedOff = (cat.files || []).some(f => NO_SHARED_CREATOR_FILES.has(f));
  const fileNames = sharedOff ? [] : loadUsernames();
  const fileOnly = fileNames.filter(n => !catKeys.has(n.toLowerCase()));
  const [catCands, fileCands] = await Promise.all([
    catNames.length ? CVS.fetchLive({ axios, usernames: catNames, logger: console, limit: Math.min(catNames.length, 3) }) : [],
    fileOnly.length ? CVS.fetchLive({ axios, usernames: fileOnly, logger: console, limit: Math.min(fileOnly.length, 3) }) : [],
  ]);
  const toItem = (v) => ({
    url: v.url,
    caption: v.title || '',
    hashtags: '',
    cid: 'creator_' + v.id,
    src: 'pages',
    play: v.play,
    digg_count: v.digg,
    play_count: v.plays,
    creator: v.creator,
  });
  const fromCat = catCands.map(toItem).filter(i => Boolean(i.url && (i.play || i.cid)));
  const fromFile = fileCands.map(toItem).filter(i => qualityOk(i) && matchesCat(i, cat));
  
  return [...fromCat, ...fromFile];
}
async function routeSearch(cat) {
  let kw;
  if (cat.key === 'loveme') {
    // 50:3 ratio for #lovemeedit vs #loveme
    kw = (Math.random() < (50 / 53)) ? '#lovemeedit' : '#loveme';
  } else if (cat.searchQuery) {
    if (Array.isArray(cat.searchQuery)) {
      kw = cat.searchQuery[Math.floor(Math.random() * cat.searchQuery.length)];
    } else {
      kw = cat.searchQuery;
    }
  } else {
    const words = cat.aliases.filter(a => a.length > 2);
    kw = (words[Math.floor(Math.random() * words.length)] || cat.label) + ' edit';
  }
  try {
    const vids = await nexraySearch(kw);
    return vids.filter(v => qualityOk(v) && !isPhotoSlider(v)).map(v => {
      const author = v.author?.nickname || (v.author && v.author.unique_id) || 'tiktok';
      const vidId = v.id || v.video_id;
      return {
        url: 'https://www.tiktok.com/@' + author + '/video/' + vidId,
        caption: v.title || '', hashtags: '',
        play: v.data || v.hdplay || v.play || '',
        cid: 'search_' + vidId,
        src: 'search',
        digg_count: v.stats?.likes || v.digg_count || v.likes || 0,
        play_count: v.stats?.views || v.play_count || v.views || 0,
      };
    }).filter(i => {
      if (!i.url.includes('/video/')) return false;
      if (TIKTOK_SEARCH_CATS.has(cat.key)) return true;
      return matchesCat(i, cat);
    });
  } catch { return []; }
}

// ── per-user unseen picker ───────────────────────────────────────────────
// Stable per-source content key: session + category + source + contentId.
// sessionA+naruto+zip+X and sessionB+naruto+zip+X are independent histories.
function contentKeyOf(item) {
  if (!item) return '';
  const vidMatch = String(item.url || '').match(/\/video\/(\d+)/) ||
                   String(item.cid || '').match(/(\d{15,})/);
  if (vidMatch) {
    return 'v:' + vidMatch[1];
  }
  return (item.src || 'other') + ':' + (item.cid || item.url);
}
const _recentCategoryDelivered = new Map();
function getRecentDelivered(catKey) {
  if (!_recentCategoryDelivered.has(catKey)) _recentCategoryDelivered.set(catKey, []);
  return _recentCategoryDelivered.get(catKey);
}
function recordRecentDelivered(catKey, keys) {
  const list = getRecentDelivered(catKey);
  for (const k of keys) {
    if (!list.includes(k)) list.push(k);
  }
  if (list.length > 30) list.splice(0, list.length - 30);
}

function pickUnseen(userJid, catKey, pool, n) {
  const seen = loadSeen();
  const mine = new Set(((seen[userJid] || {})[catKey]) || []);
  let fresh = pool.filter(i => !mine.has(contentKeyOf(i)));
  if (!fresh.length && pool.length) {           // drained → reset this user+cat
    seen[userJid] = seen[userJid] || {}; seen[userJid][catKey] = [];
    saveSeen(seen); fresh = pool.slice();
  }
  // Deduplicate pool items having the exact same video ID
  const deduplicated = [];
  const seenThisBatch = new Set();
  for (const item of fresh) {
    const key = contentKeyOf(item);
    if (!seenThisBatch.has(key)) {
      seenThisBatch.add(key);
      deduplicated.push(item);
    }
  }

  // Filter out photo sliders and videos below 1k likes
  const qualified = deduplicated.filter(item => {
    if (isPhotoSlider(item)) return false;
    const digg = parseStatNum(item.digg_count || item.digg || (item.stats && (item.stats.likes || item.stats.digg_count)) || item.likes || 0);
    if (digg > 0 && digg < 1000) return false;
    return true;
  });
  const candidates = qualified.length >= n ? qualified : deduplicated;

  // Filter out items recently delivered to other users (so user 1 and user 2 don't drop same video)
  const recentDelivered = getRecentDelivered(catKey);
  let available = candidates.filter(i => !recentDelivered.includes(contentKeyOf(i)));
  if (available.length < n) available = candidates;

  // "fetch shuffles from tops rateds one to down":
  // Sort candidates by rating (likes and views)
  available.sort((a, b) => {
    const scoreA = parseStatNum(a.digg_count || 0) * 3 + parseStatNum(a.play_count || 0);
    const scoreB = parseStatNum(b.digg_count || 0) * 3 + parseStatNum(b.play_count || 0);
    return scoreB - scoreA;
  });

  // Top tier window (top 8-10 candidates) shuffled to give users varied top-tier content
  const windowSize = Math.max(n * 4, 8);
  const topTier = available.slice(0, windowSize);
  for (let i = topTier.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [topTier[i], topTier[j]] = [topTier[j], topTier[i]];
  }
  return topTier.slice(0, n);
}
function markSeen(userJid, catKey, keys) {
  const seen = loadSeen();
  seen[userJid] = seen[userJid] || {};
  const cur = new Set(seen[userJid][catKey] || []);
  for (const u of keys) cur.add(u);
  seen[userJid][catKey] = [...cur].slice(-1000);
  saveSeen(seen);
}

// ── route rotation: each request walks routes in a shifted order ─────────
const _rr = new Map(); // userJid -> counter
function routeOrder(userJid, isCreatorCategory = false) {
  if (isCreatorCategory) {
    return ['pages', 'search', 'zip'];
  }
  const base = ['zip', 'pages', 'search'];
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base;
}

// ── creator pages: live only, nothing is stored ─────────────────────────
// Every creator in the category lists (Cruise, Discipline, Free Fire, FYP).
function allCategoryCreators() {
  const out = [];
  for (const cat of Object.values(CATEGORIES)) {
    for (const n of categoryCreators(cat)) out.push({ name: n, group: cat.label });
  }
  return out;
}
function startCreatorLinks() {
  const users = loadUsernames();
  const cats = allCategoryCreators();
  
  // The monitor logs every creator from both lists: video count, followers, and status.
  try {
    const CPS = require('./lib/creatorPageStatus.cjs');
    CPS.addCreatorSource('category-creators', allCategoryCreators);
    CPS.startCreatorPageMonitor({ intervalMs: 15 * 60 * 1000, log: () => {} });
  } catch (e) {  }
}

// ── creator-page delivery: temp file on disk, removed after the send ─────
const CREATOR_MAX_BYTES = 64 * 1024 * 1024;   // WhatsApp video limit
async function downloadCreatorToFile(url, file) {
  const run = async () => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA['User-Agent'] || 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' },
        signal: AbortSignal.timeout(25000),
      });
      if (resp.ok && resp.body) {
        const out = fs.createWriteStream(file);
        let bytes = 0;
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > CREATOR_MAX_BYTES) {
            await reader.cancel();
            out.destroy();
            throw new Error('edit is larger than the WhatsApp limit');
          }
          out.write(value);
        }
        await new Promise((res, rej) => out.end((err) => err ? rej(err) : res()));
        const size = fs.statSync(file).size;
        if (size >= 2048) {
          const head = Buffer.alloc(12);
          const fd = fs.openSync(file, 'r');
          try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
          if (head.subarray(4, 8).toString('ascii') === 'ftyp') return size;
        }
      }
    } catch (e) {}

    if (axios) {
      const r = await axios.get(url, {
        headers: { ...UA, Referer: 'https://www.tiktok.com/' }, responseType: 'stream',
        timeout: 20000, maxContentLength: CREATOR_MAX_BYTES, validateStatus: () => true,
      });
      if (r.status >= 400 || !r.data) {
        try { r.data && r.data.destroy && r.data.destroy(); } catch {}
        return 0;
      }
      let bytes = 0;
      const out = fs.createWriteStream(file);
      await new Promise((resolve, reject) => {
        r.data.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > CREATOR_MAX_BYTES) r.data.destroy(new Error('edit is larger than the WhatsApp limit'));
        });
        r.data.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        r.data.pipe(out);
      });
      const size = fs.statSync(file).size;
      if (size < 2048) return 0;
      const head = Buffer.alloc(12);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
      if (head.subarray(4, 8).toString('ascii') !== 'ftyp') return 0;
      return size;
    }
    return 0;
  };
  try {
    if (_heavyGuard && typeof _heavyGuard.runHeavy === 'function') {
      return await _heavyGuard.runHeavy(run, { tag: 'creator-page-dl', timeoutMs: 120000 });
    }
    return await run();
  } catch (e) { try { fs.rmSync(file, { force: true }); } catch {} return 0; }
}
const NO_REENCODE_CATEGORIES = new Set([
  "fyp", "foryou", "foryoupage",
  "cruise", "cruzz", "techcruzz",
  "feeling",
  "discipline", "discip", "mindset", "motivation",
  "peak"
]);

function shouldSkipReencode(catKey, item) {
  const c = String(catKey || (item && (item.category || item.catKey || item.cat)) || "").toLowerCase().trim();
  return NO_REENCODE_CATEGORIES.has(c);
}

async function deliverItemFromDisk(sock, jid, msg, item, caption, catKey = null) {
  if (!CVD) {  return false; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mias-anime-"));
  const file = path.join(dir, "edit.mp4");
  try {
    const tried = new Set();
    const attempt = async (urls) => {
      for (const url of urls.filter(u => u && !tried.has(u))) {
        tried.add(url);
        if (await downloadCreatorToFile(url, file)) return true;
      }
      return false;
    };
    // Prefer the original HD file (CDN hd=1) so the re-encode starts from full quality.
    // The stored play link is usually an SD copy, so it is only a fallback.
    let ok = false;
    let info = null;
    if (item.url) {
      info = await resolveTikTok(item.url);
      if (info) ok = await attempt([info.hd]);
    }
    if (!ok && item.play) ok = await attempt([item.play]);
    if (!ok && info) ok = await attempt([info.play]);
    if (!ok) return false;

    // Direct delivery without re-encoding for fyp, cruise, feeling, and discipline
    const categoryName = String(catKey || (item && (item.category || item.catKey || item.cat)) || "").toLowerCase().trim();
    if (shouldSkipReencode(catKey, item)) {
      
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || stat.size < 2048) {
        throw new Error("Downloaded video file is empty or corrupted");
      }
      const maxInline = (TTD && TTD.TT_INLINE_VIDEO_MAX_BYTES) || (95 * 1024 * 1024);
      if (stat.size > maxInline) {
        throw new Error("Status video exceeds the 95 MiB size limit; no document was sent.");
      }
      await CVD.sendVideoFromDisk(sock, jid, file, caption, msg);
      return true;
    }

    // All status categories: re-encode to TT command 1.3 HD state with 1.2 boost (clean H.264/AAC 1080p60 faststart)
    let hdEncoded = null;
    if (TTD && typeof TTD.reencodeHdForWhatsApp === "function") {
      try {
        const hdRun = () => TTD.reencodeHdForWhatsApp(file, {
          maxBytes: 95 * 1024 * 1024,
          boost: 1.2,
          sourceQualityBoost: 1.2,
        });
        hdEncoded = (_heavyGuard && typeof _heavyGuard.runHeavy === "function")
          ? await _heavyGuard.runHeavy(hdRun, { tag: "status-hd-reencode", timeoutMs: 120000 })
          : await Promise.race([
              hdRun(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("reencode timeout")), 120000))
            ]);
        
      } catch (err) {
        
        hdEncoded = null;
      }
    }

    // If re-encode succeeded, send re-encoded video, otherwise deliver clean original video
    const sendPath = hdEncoded ? hdEncoded.path : file;
    const statObj = await fs.promises.stat(sendPath).catch(() => null);
    const sendBytes = statObj ? statObj.size : 0;

    try {
      const maxInline = (TTD && TTD.TT_INLINE_VIDEO_MAX_BYTES) || (95 * 1024 * 1024);
      if (sendBytes > maxInline) {
        throw new Error("Status video exceeds the 95 MiB size limit; no document was sent.");
      }
      await CVD.sendVideoFromDisk(sock, jid, sendPath, caption, msg);
      return true;
    } finally {
      if (hdEncoded && typeof hdEncoded.cleanup === "function") {
        try { await hdEncoded.cleanup(); } catch {}
      }
    }
  } catch (e) {
    
    return false;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
const deliverCreatorItemFromDisk = deliverItemFromDisk;

// ── delivery plan: which place each of the two edits comes from ──────────
// Each request shuffles the places, then takes one edit from each place before
// it reuses one. A place whose download fails is skipped for the rest of that
// request. A creator is not used twice and a video is never sent twice.
// Links that failed to deliver are skipped for a while, so dead or placeholder
// links cannot use up the whole delivery budget on every request.
const _deadLinks = new Map();
const DEAD_LINK_TTL_MS = 60 * 60 * 1000;
function markDeadLink(url) { if (url) _deadLinks.set(String(url), Date.now()); }
function isDeadLink(url) {
  const t = _deadLinks.get(String(url || ''));
  if (!t) return false;
  if (Date.now() - t > DEAD_LINK_TTL_MS) { _deadLinks.delete(String(url)); return false; }
  return true;
}
function creatorOf(item) {
  if (item && item.creator) return String(item.creator).toLowerCase();
  const m = String((item && item.url) || '').match(/tiktok\.com\/@([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function makeDeliveryPlan(fresh, initialSeen = []) {
  const buckets = new Map();
  for (const it of fresh) {
    const s = it.src || 'other';
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(it);
  }
  const usedKeys = new Set(initialSeen);
  const usedSrc = new Set();
  const failedSrc = new Set();
  const usedCreators = new Set();
  const rank = (s) => (failedSrc.has(s) ? 2 : (usedSrc.has(s) ? 1 : 0));
  return {
    next() {
      const srcs = [...buckets.keys()];
      for (let i = srcs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [srcs[i], srcs[j]] = [srcs[j], srcs[i]];
      }
      srcs.sort((a, b) => rank(a) - rank(b));   // untried places first, failed places last
      for (const s of srcs) {
        const list = buckets.get(s);
        for (let i = list.length - 1; i >= 0; i--) if (usedKeys.has(contentKeyOf(list[i]))) list.splice(i, 1);
        if (!list.length) continue;
        let idx = list.findIndex((it) => { const c = creatorOf(it); return !c || !usedCreators.has(c); });
        if (idx < 0) idx = 0;
        const [item] = list.splice(idx, 1);
        return { src: s, item, key: contentKeyOf(item), creator: creatorOf(item) };
      }
      return null;
    },
    delivered(c) { usedKeys.add(c.key); usedSrc.add(c.src); if (c.creator) usedCreators.add(c.creator); },
    failed(c) { usedKeys.add(c.key); failedSrc.add(c.src); },
  };
}

// ── Reaction helpers ─────────────────────────────────────────────────────
async function doReact(sock, msg, emoji, P = null) {
  try {
    if (P && typeof P.react === 'function') return await P.react(sock, msg, emoji);
    const jid = msg?.key?.remoteJid;
    if (jid && msg?.key && sock) return await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
  } catch {}
}

function clearReactDelayed(sock, msg, delayMs = 2500, P = null) {
  setTimeout(() => {
    doReact(sock, msg, '', P).catch(() => {});
  }, delayMs);
}

// ── Bot intro audio and greeting ─────────────────────────────────────────
const BOT_AUDIO_PATH = path.join(__dirname, 'assets', 'bot_audio.mp3');
let _botAudioCache = null;

async function getBotAudioBuffer() {
  if (_botAudioCache && _botAudioCache.length > 1000) return _botAudioCache;
  try {
    if (fs.existsSync(BOT_AUDIO_PATH)) {
      const buf = await fs.promises.readFile(BOT_AUDIO_PATH);
      if (buf.length > 1000) {
        _botAudioCache = buf;
        return buf;
      }
    }
  } catch {}
  return null;
}

function isOwnerMessage(sock, msg) {
  if (!msg || !msg.key) return false;
  if (msg.key.fromMe) return true;
  const sender = msg.key.participant || msg.key.participantPn || msg.key.remoteJid || '';
  if (typeof globalThis.__miasIsOwner === 'function') {
    try {
      if (globalThis.__miasIsOwner(sender)) return true;
    } catch {}
  }
  const senderClean = String(sender).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!senderClean) return false;

  const ownerPaths = [
    path.join(__dirname, '..', 'allfunc', 'owner.json'),
    path.join(process.cwd(), 'allfunc', 'owner.json'),
  ];
  for (const op of ownerPaths) {
    try {
      if (fs.existsSync(op)) {
        const owners = JSON.parse(fs.readFileSync(op, 'utf8'));
        if (Array.isArray(owners) && owners.some((o) => {
          const num = String(o).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          return num && (num === senderClean || num.endsWith(senderClean) || senderClean.endsWith(num));
        })) return true;
      }
    } catch {}
  }

  const envOwner = String(process.env.OWNER_NUMBER || process.env.OWNER || '').replace(/[^0-9]/g, '');
  if (envOwner && (envOwner === senderClean || envOwner.endsWith(senderClean) || senderClean.endsWith(envOwner))) {
    return true;
  }
  if (globalThis.__BOT_OWNER_NUMBER) {
    const bOwner = String(globalThis.__BOT_OWNER_NUMBER).replace(/[^0-9]/g, '');
    if (bOwner && (bOwner === senderClean || bOwner.endsWith(senderClean) || senderClean.endsWith(bOwner))) {
      return true;
    }
  }
  return false;
}

const _handledMsgIds = new Map();
function hasHandledMsg(msg) {
  const id = msg?.key?.id;
  if (!id) return false;
  const now = Date.now();
  if (_handledMsgIds.has(id) && (now - _handledMsgIds.get(id) < 15000)) return true;
  _handledMsgIds.set(id, now);
  if (_handledMsgIds.size > 200) {
    for (const [k, v] of _handledMsgIds.entries()) {
      if (now - v > 30000) _handledMsgIds.delete(k);
    }
  }
  return false;
}

async function handleBotAudio(sock, msg, P = null) {
  const jid = msg?.key?.remoteJid;
  if (!sock || !jid) return;
  // hi and bot only answer in direct messages, never in groups.
  if (String(jid).endsWith('@g.us')) return;
  if (hasHandledMsg(msg)) return;

  await doReact(sock, msg, '🌀', P);
  try {
    const audio = await getBotAudioBuffer();
    if (!audio || audio.length < 1000) {
      throw new Error('Configured bot audio file is missing or unreadable');
    }
    await sock.sendMessage(jid, {
      audio,
      mimetype: 'audio/mpeg',
      fileName: 'bot.mp3',
      ptt: false
    }, { quoted: msg });
    await doReact(sock, msg, '✅', P);
    clearReactDelayed(sock, msg, 2500, P);
  } catch (err) {
    await doReact(sock, msg, '❌', P);
    clearReactDelayed(sock, msg, 3000, P);
    const detail = String(err?.message || 'audio unavailable').replace(/[\r\n]+/g, ' ').slice(0, 140);
    const errText = `❌ Failed to play bot audio: ${detail}. Please try again.`;
    if (P && typeof P.sendReply === 'function') {
      await P.sendReply(sock, msg, errText).catch(() => {});
    } else {
      await sock.sendMessage(jid, { text: errText }, { quoted: msg }).catch(() => {});
    }
  }
}

let _statusQueue = null;
let _queueRefillFn = null;

const _attachedSockets = new WeakSet();
function attachSocket(sock) {
  if (!sock || !sock.ev || typeof sock.ev.on !== 'function' || _attachedSockets.has(sock)) return;
  _attachedSockets.add(sock);

  sock.ev.on('messages.upsert', async (evt) => {
    try {
      const messages = evt?.messages || [];
      for (const msg of messages) {
        if (!msg || !msg.message || msg.key?.fromMe) continue;
        const jid = msg.key?.remoteJid || '';
        if (!jid || jid.endsWith('@broadcast') || jid === 'status@broadcast') continue;

        const text = String(
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          ''
        ).trim();
        if (!text) continue;

        const isHi = /^[.!\/#$]?\s*hi(?:[\s!.,~]|$)/i.test(text);
        const isBot = /^[.!\/#$]?\s*bot(?:[\s!.,~]|$)/i.test(text);
        if (!isHi && !isBot) continue;

        // "Buh thr hi should silent for owner only income one"
        if (isHi && !isBot && isOwnerMessage(sock, msg)) {
          continue;
        }

        await handleBotAudio(sock, msg, null);
      }
    } catch {}
  });
}

// ── install ───────────────────────────────────────────────────────────────
module.exports = {
  attachSocket,
  handleBotAudio,
  isOwnerMessage,
  getBotAudioBuffer,
  doReact,
  clearReactDelayed,
  install(P, helpers) {
    if (!axios && helpers.axios) axios = helpers.axios;
    startCreatorLinks();

    if (StatusEditQueue && !_statusQueue) {
      _statusQueue = new StatusEditQueue({ categories: CATEGORIES, logger: console });
      // Rehydrate immediately from repository links and the last-good cache, then
      // let bounded background workers top each category up from live sources.
      for (const [key, cat] of Object.entries(CATEGORIES)) {
        const initialCandidates = [...routeZip(cat), ...loadLastGood(key)];
        for (let i = initialCandidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [initialCandidates[i], initialCandidates[j]] = [initialCandidates[j], initialCandidates[i]];
        }
        for (const candidate of initialCandidates) {
          _statusQueue.enqueue(key, candidate, false);
        }
      }
      _statusQueue.persist();
      _queueRefillFn = async (key) => {
        const cat = CATEGORIES[key];
        if (!cat) return [];
        const [pages, search] = await Promise.all([
          routePages(cat).catch(() => []),
          routeSearch(cat).catch(() => []),
        ]);
        const live = [...(pages || []), ...(search || [])].filter((item) => item && !isDeadLink(item.url));
        if (live.length) saveLastGood(key, live);
        const merged = [...routeZip(cat), ...live, ...loadLastGood(key)]
          .filter((item) => item && !isDeadLink(item.url));
        for (let i = merged.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [merged[i], merged[j]] = [merged[j], merged[i]];
        }
        return merged;
      };
      _statusQueue.start(_queueRefillFn, { intervalMs: 300000, concurrency: 2 });
    }

    async function runEditCmd(catKey, sock, msg) {
      const jid = msg.key.remoteJid;
      const user = (msg.key.participant || msg.key.remoteJid || '').split(':')[0];
      const cat = CATEGORIES[catKey];
      await doReact(sock, msg, '🌀', P);
      // Requests consume the already-prefetched persistent queue. Network lookups
      // run only in background workers, never in this command handler.
      if (_statusQueue && _statusQueue.count(catKey) < 2 && _statusQueue.locks?.has(catKey)) {
        await Promise.race([
          _statusQueue.locks.get(catKey).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      }
      const recentDelivered = getRecentDelivered(catKey);
      const leases = _statusQueue ? _statusQueue.reserve(catKey, 2, (item) => {
        const k = contentKeyOf(item);
        if (recentDelivered.includes(k)) return false;
        if (isPhotoSlider(item)) return false;
        const digg = parseStatNum(item.digg_count || item.digg || 0);
        if (digg > 0 && digg < 1000) return false;
        return true;
      }) : [];
      if (!leases.length) {
        await doReact(sock, msg, '❌', P);
        clearReactDelayed(sock, msg, 3000, P);
        return P.sendReply(sock, msg, `❌ ${cat.label} edits are being refreshed in the background. Please try again shortly.`);
      }

      const seen = loadSeen();
      const userSeen = new Set(((seen[user] || {})[catKey]) || []);
      const reserved = [];
      for (const lease of leases) {
        const item = { ...lease, _queueToken: lease.token };
        if (!userSeen.has(contentKeyOf(item))) {
          reserved.push(item);
        } else {
          _statusQueue?.settle(lease.token, true);
        }
      }
      if (reserved.length < 2) {
        const pool = [...routeZip(cat), ...loadLastGood(catKey)];
        const extra = pickUnseen(user, catKey, pool, 2 - reserved.length);
        reserved.push(...extra);
      }
      if (_statusQueue && _queueRefillFn) void _statusQueue.refill(catKey, _queueRefillFn);
      const plan = makeDeliveryPlan(reserved, userSeen);
      const sent = [];
      const attempted = new Set();
      let fourKError = null;
      while (sent.length < 2) {
        const c = plan.next();
        if (!c) break;
        if (attempted.has(c.key)) continue;
        attempted.add(c.key);
        const caption = String(c.item.caption || c.item.title || (cat.label + ' edit'))
          .replace(/\s+/g, ' ').trim().slice(0, 120) || (cat.label + ' edit');
        let res = false;
        try { res = await deliverItemFromDisk(sock, jid, msg, c.item, caption, catKey); } catch { res = false; }
        const ok = res === true;
        if (ok) {
          plan.delivered(c);
          sent.push(c.key);
          _statusQueue?.settle(c.item._queueToken, true);
        } else {
          if (res && res.error) fourKError = res.error;
          plan.failed(c);
          markDeadLink(c.item.url);
          _statusQueue?.settle(c.item._queueToken, false);
        }
      }
      if (sent.length) {
        markSeen(user, catKey, sent);
        recordRecentDelivered(catKey, sent);
        const username = msg.pushName || (user ? user.split('@')[0] : 'User');
        const rawText = String(msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.body || '').trim();
        const cmd = (rawText.startsWith('.') || rawText.startsWith('/') || rawText.startsWith('!')) ? rawText.split(/\s+/)[0] : ('.' + catKey);
        const vidWord = sent.length === 1 ? '+1 video' : `+${sent.length} videos`;
        console.log(`${username} with the ${cmd} ${vidWord}`);
        await doReact(sock, msg, '✅', P);
        clearReactDelayed(sock, msg, 2500, P);
        if (sent.length < 2 && !fourKError) await P.sendReply(sock, msg, '⚠️ Only one edit could be delivered this time (some sources were down).');
        if (fourKError) await P.sendReply(sock, msg, fourKError);
      } else {
        await doReact(sock, msg, '❌', P);
        clearReactDelayed(sock, msg, 3000, P);
        if (fourKError) await P.sendReply(sock, msg, fourKError);
        else await P.sendReply(sock, msg, `❌ Failed to download ${cat.label} edits: video sources are temporarily busy or unreachable. Please try again in a moment.`);
      }
    }

    const registered = [];
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      if (!cat.files.some(f => { try { return fs.statSync(path.join(editsDir(), f)).size > 0; } catch { return false; } })
          && !['naruto','jjk'].includes(key)) {
        // still register — page/search routes may serve it even without zip links
      }
      try {
        P.cmd(cat.aliases, { desc: `Random ${cat.label} TikTok edits (2 per request)`, category: 'STATUS' },
          async (sock, msg) => runEditCmd(key, sock, msg));
        registered.push(cat.aliases[0]);
      } catch (e) {  }
    }
    try {
      P.cmd(['bot'], { desc: 'Play bot intro audio', category: 'GENERAL' },
        async (sock, msg) => handleBotAudio(sock, msg, P));
      registered.push('bot');
    } catch (e) {}
    return { categories: registered.length, commands: registered };
  },
  CATEGORIES,
  NO_REENCODE_CATEGORIES,
  shouldSkipReencode,
  deliverItemFromDisk,
  pickUnseen,
  markSeen,
  contentKeyOf,
  routeOrder,
  routePages,
  makeDeliveryPlan,
  creatorOf,
  isPhotoSlider,
  qualityOk,
  TIKTOK_SEARCH_CATS,
  getRecentDelivered,
  recordRecentDelivered,
  matchesCat,
  FRANCHISE_EXCLUSIVE_MARKERS,
};
