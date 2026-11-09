// =========================================================================
//  precious-anime-edits.cjs  ·  PRECIOUS v24 — anime edits engine
// ─────────────────────────────────────────────────────────────────────────
//  Powers commands like .naruto / .jjk / .demonslayer / .aot / .onepiece …
//
//  Behaviour (per the owner's spec):
//   • reacts ☄️ on every request
//   • drops TWO edits per request
//   • an edit is NEVER repeated for the same user (per-user seen list,
//     persisted to edits/_seen.json; auto-resets when a category is drained)
//   • each request rotates across 3 routes so different users get different
//     videos from different places:
//        1) the classified links zip files  (edits/<category>.txt)
//        2) TikTok page videos of the usernames in edits/_usernames.txt
//        3) random public TikTok search (multi-keyword, quality-filtered)
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
const NX = require('./lib/nexrayGate.cjs');
let axios = (typeof globalThis !== 'undefined' && globalThis.axios) ? globalThis.axios : null;
try { if (!axios) axios = require('axios'); } catch {}

// Creator pages are read LIVE at request time (creatorVideoStore only fetches;
// no link or video is saved). Creator-page videos are downloaded to a temp
// file on disk and that folder is removed after the send succeeds or fails.
const os = require('os');
let CVS = null;
try { CVS = require('./lib/creatorVideoStore.cjs'); } catch (e) {
  console.log('[anime-edits] creator page reader unavailable:', e && e.message);
}
let CVD = null;
try { CVD = require('./lib/tiktokDiskDelivery.cjs'); } catch (e) {
  console.log('[anime-edits] disk delivery unavailable:', e && e.message);
}
// Makes each downloaded edit play in WhatsApp (H.264 remux, or H.264 CRF 18 re-encode
// for HEVC/other codecs; resolution and frame rate are kept).
let WP = null;
try { WP = require('./lib/whatsappPlayable.cjs'); } catch (e) {
  console.log('[anime-edits] playable normalizer unavailable:', e && e.message);
}
let TTD = null;
try { TTD = require('./lib/ttDelivery.cjs'); } catch (e) {
  console.log('[anime-edits] ttDelivery unavailable:', e && e.message);
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
                   tags: ['naruto','boruto','sasuke','uchiha','itachi','kakashi','sakura','hinata','konoha','hokage','kurama','kyuubi','jiraiya','tsunade','orochimaru','akatsuki','obito','madara','minato','kushina','gaara','rocklee','neji','shikamaru','kawaki','sarada','mitsuki','momoshiki','otsutsuki','uzumaki','uzuhiko','baryonmode','narutoshippuden','narutoshipuden','narutoedit','narutoedits','borutoedit','borutonarutonextgeneration','borutotwobluevortex','sharingan','rinnegan','rasengan','chidori','susanoo','kage'] },
  jjk:           { files: ['jjk.txt','jujutsu_kaisen.txt'],         label: 'Jujutsu Kaisen',
                   aliases: ['jjk','jujutsukaisen','jujutsu'],
                   tags: ['jjk','jujutsu','jujutsukaisen','gojo','satoru','sukuna','ryomen','yuji','itadori','megumi','fushiguro','nobara','kugisaki','nanami','toji','maki','toge','inumaki','geto','suguru','kenjaku','mahito','choso','yuta','okkotsu','hakari','kashimo','shibuya','hollowpurple','domainexpansion','jjkedit','jjkedits'] },
  demonslayer:   { files: ['demon_slayer.txt'],                     label: 'Demon Slayer',
                   aliases: ['demonslayer','ds','kny','kimetsunoyaiba'],
                   tags: ['demonslayer','kimetsunoyaiba','kny','tanjiro','nezuko','zenitsu','inosuke','rengoku','giyu','shinobu','tengen','muichiro','mitsuri','obanai','sanemi','gyomei','akaza','douma','kokushibo','muzan','hashira'] },
  aot:           { files: ['attack_on_titan.txt'],                  label: 'Attack on Titan',
                   aliases: ['aot','attackontitan','shingeki','snk'],
                   tags: ['aot','attackontitan','shingeki','snk','eren','yeager','mikasa','levi','ackerman','armin','erwin','reiner','annie','zeke','hange','titan','rumbling','survey','scouts'] },
  onepiece:      { files: ['one_piece.txt'],                        label: 'One Piece',
                   aliases: ['onepiece','op'],
                   tags: ['onepiece','luffy','zoro','sanji','nami','usopp','chopper','robin','franky','brook','jinbei','shanks','kaido','bigmom','whitebeard','ace','sabo','law','doflamingo','gear5','strawhat','onepieceedit','onepieceedits'] },
  dragonball:    { files: ['dragon_ball.txt'],                      label: 'Dragon Ball',
                   aliases: ['dragonball','db','dbz','dbs'],
                   tags: ['dragonball','dbz','dbs','goku','vegeta','gohan','piccolo','trunks','frieza','cell','broly','beerus','whis','jiren','gogeta','vegito','supersaiyan','ssj','ultrainstinct','kamehameha'] },
  bleach:        { files: ['bleach.txt'],                           label: 'Bleach',
                   aliases: ['bleach'],
                   tags: ['bleach','ichigo','rukia','byakuya','renji','aizen','ulquiorra','grimmjow','kenpachi','toshiro','hitsugaya','uryu','orihime','yoruichi','urahara','shinigami','hollow','espada','bankai','tybw'] },
  blackclover:   { files: ['black_clover.txt'],                     label: 'Black Clover',
                   aliases: ['blackclover','bc'],
                   tags: ['blackclover','asta','yuno','noelle','yami','mereoleona','fuegoleon','licht','zagred','lucifero','antimagic','grimoire'] },
  mha:           { files: ['my_hero_academia.txt'],                 label: 'My Hero Academia',
                   aliases: ['mha','myheroacademia','bnha','bokunohero'],
                   tags: ['mha','myheroacademia','bnha','deku','midoriya','bakugo','todoroki','uraraka','kirishima','allmight','shigaraki','dabi','toga','aizawa','hawks','endeavor','mirko','oneforall'] },
  mushokutensei: { files: ['mushoku_tensei.txt'],                   label: 'Mushoku Tensei',
                   aliases: ['mushokutensei','mt'],
                   tags: ['mushokutensei','mushoku','rudeus','roxy','sylphiette','sylphy','eris','greyrat','ruijerd','orsted','hitogami'] },
  sololeveling:  { files: ['solo_leveling.txt'],                    label: 'Solo Leveling',
                   aliases: ['sololeveling','sl'],
                   tags: ['sololeveling','sungjinwoo','jinwoo','shadowmonarch','igris','beru','ashborn','chahaein'] },
  cote:          { files: ['classroom_of_the_elite.txt'],           label: 'Classroom of the Elite',
                   aliases: ['cote','classroomoftheelite'],
                   tags: ['classroomoftheelite','cote','ayanokoji','kiyotaka','horikita','suzune','kushida','ichinose','sakayanagi','ryuen','karuizawa'] },
  tomodachigame: { files: ['tomodachi_game.txt'],                   label: 'Tomodachi Game',
                   aliases: ['tomodachigame','tomodachi'],
                   tags: ['tomodachigame','tomodachi','yuuichi','katagiri'] },
  horimiya:      { files: ['horimiya.txt'],                         label: 'Horimiya',
                   aliases: ['horimiya'],
                   tags: ['horimiya','hori','miyamura'] },
  oshinoko:      { files: ['oshi_no_ko.txt'],                       label: 'Oshi no Ko',
                   aliases: ['oshinoko','onk'],
                   tags: ['oshinoko','aihoshino','aqua','ruby','kana','arima','akane','memcho'] },
  rezero:        { files: ['re_zero.txt'],                          label: 'Re:Zero',
                   aliases: ['rezero','rz'],
                   tags: ['rezero','re:zero','subaru','emilia','rem','ram','beatrice','roswaal','echidna'] },
  vinlandsaga:   { files: ['vinland_saga.txt'],                     label: 'Vinland Saga',
                   aliases: ['vinlandsaga','vinland'],
                   tags: ['vinlandsaga','vinland','thorfinn','askeladd','canute','thorkell'] },
  spiderman:     { files: ['marvel_spiderman.txt'],                 label: 'Marvel/Spider-Man',
                   aliases: ['spiderman','marvel','avengers','mcu'],
                   tags: ['spiderman','marvel','avengers','peterparker','milesmorales','gwen','tobey','tomholland','venom','mcu','ironman','captainamerica','thor','hulk','thanos','loki','deadpool','wolverine'] },
  invincible:    { files: ['invincible.txt'],                       label: 'Invincible',
                   aliases: ['invincible'],
                   tags: ['invincible','omniman','markgrayson','viltrumite','atomeve'] },
  bluelock:      { files: ['blue_lock.txt'],                        label: 'Blue Lock',
                   aliases: ['bluelock','bllk'],
                   tags: ['bluelock','bllk','isagi','bachira','chigiri','kunigami','nagi','reo','barou','rin','itoshi','sae','shidou','karasu','otoya','yukimiya','ego'] },
  onepunchman:   { files: ['one_punch_man.txt'],                    label: 'One Punch Man',
                   aliases: ['onepunchman','opm'],
                   tags: ['onepunchman','opm','saitama','genos','garou','tatsumaki','fubuki','boros','metalbat'] },
  sonic:         { files: ['sonic.txt'],                            label: 'Sonic',
                   aliases: ['sonic'],
                   tags: ['sonic','sonicthehedgehog','shadowthehedgehog','tails','knuckles','eggman'] },
  fireforce:     { files: ['fire_force.txt'],                       label: 'Fire Force',
                   aliases: ['fireforce','firef'],
                   tags: ['fireforce','shinra','arthur','benimaru','joker','tamaki','shinrabanshoman'] },
  cruise:        { files: ['cruise.txt'],                           label: 'Cruise',
                   aliases: ['cruise','cruzz','techcruzz'],
                   usernames: ['kingoftechcruzz','mr_vawulencee','kellyreacts02','mrdonduke'],
                   tags: ['cruise','cruzz','vawulence','kelly','comedy','funny','viral','cruisevideo','cruisetime'] },
  discipline:    { files: ['discipline.txt'],                       label: 'Discipline',
                   aliases: ['discipline','discip'],
                   usernames: ['rude_advice','jesse.serna.02','fam0us.mikeey','marcushullaster','breakuptoresilience','aidenheaney','risenexx','churchill___._','quietauthority.exe','mindful_mo','big.body485','relentless__mentality'],
                   tags: ['discipline','motivation','mindset','grind','focus','mentality','resilience','hardwork','growth','sigma'] },
  freefire:      { files: ['freefire.txt'],                         label: 'Free Fire',
                   aliases: ['freefire','ff','freef'],
                   usernames: ['nexus.120fps_','zoya.120fps','.nur._ff','o1zhik_19','e_s_t_ff','prince.aep5','tik_ff_n','demi_ae1','iamnasboyff','mrvawulencefff','chris_dline4','lyonnn3d_','otc4mena'],
                   tags: ['freefire','ff','ffedit','garenafreefire','freefireedit','ffhighlights','120fps'] },
  fyp:           { files: ['fyp.txt'],                              label: 'FYP',
                   aliases: ['fyp','foryou','foryoupage'],
                   usernames: ['undead.aep','mentalistfilms','kitostunna','edits.moral','stizzy.mac4','interestingdiscoveriesus','dyuo1200','ragzfr','elyasclaire','patrickjane.viral.videos','factdrop_01','ductuvu8','noisy.neighbor.en','vlados_adventure','mxtn65','maven.stark','mrpio_','solosurvivalking'],
                   tags: ['fyp','foryou','foryoupage','viral','edit','edits','trending','aep','4kedit'] },
  feeling:       { files: ['feeling.txt'],                           label: 'Feeling',
                   aliases: ['feeling'],
                   usernames: ['sandip_sayzz','stevenyeun.intl','doom_yywk'],
                   tags: ['feeling','feelings','emotional','mood','sad','heartbreak','vibes','quotes'] },
};

// ── tiny fs helpers ───────────────────────────────────────────────────────
function seenPath() { return path.join(editsDir(), '_seen.json'); }
function loadSeen() { try { return JSON.parse(fs.readFileSync(seenPath(), 'utf8')); } catch { return {}; } }
function saveSeen(s) { try { fs.writeFileSync(seenPath(), JSON.stringify(s)); } catch {} }

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
      items.push({ url: url.trim(), caption, hashtags });
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
function categoryCreators(cat) {
  if (!cat) return [];
  try {
    const p = path.join(editsDir(), 'creators', `${cat.key}.txt`);
    return fs.readFileSync(p, 'utf8').split(/\r?\n/)
      .map(s => s.trim().replace(/^@/, '')).filter(s => s && !s.startsWith('#'));
  } catch {
    return (cat.usernames || []).map(n => String(n).replace(/^@/, '').trim()).filter(Boolean);
  }
}

function loadUsernames() {
  const p = path.join(editsDir(), '_usernames.txt');
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/)
      .map(s => s.trim().replace(/^@/, '')).filter(s => s && !s.startsWith('#'));
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
    const { fetchTikTokInfo } = await _sharedTikTokApi;
    const info = await fetchTikTokInfo(videoUrl);
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
    console.log('[anime-edits][resolve] TikTok provider chain failed:', (e && e.message) || 'request failed');
    return null;
  }
}
async function nexraySearch(keywords) {
  const nx = await NX.nexrayList('https://api.nexray.eu.cc/search/tiktok?q=' + encodeURIComponent(keywords), 20000);
  if (nx.list.length) return nx.list;
  if (!require('./lib/tikwmGate.cjs').isTikwmEnabled()) return [];
  try {
    const d = await getJson('https://www.tikwm.com/api/feed/search?keywords=' + encodeURIComponent(keywords) + '&count=20&hd=1', 15000);
    const arr = d && d.data && d.data.videos;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function tikwmSearch(keywords) { return nexraySearch(keywords); }

// ── franchise validation ─────────────────────────────────────────────────
function textOf(item) {
  return String((item.caption || '') + ' ' + (item.hashtags || '') + ' ' + (item.title || '')).toLowerCase().replace(/[#_\-]/g, '');
}
const FRANCHISE_EXCLUSIVE_MARKERS = {
  naruto: ['naruto', 'narutoshippuden', 'boruto', 'sasuke', 'itachi', 'kakashi', 'madara', 'obito', 'hokage', 'minato', 'sharingan', 'uzumaki', 'uchiha'],
  demonslayer: ['demonslayer', 'kimetsunoyaiba', 'kny', 'tanjiro', 'nezuko', 'zenitsu', 'inosuke', 'rengoku', 'muzan', 'akaza', 'hashira', 'giyu', 'shinobu'],
  onepiece: ['onepiece', 'luffy', 'zoro', 'sanji', 'nami', 'kaido', 'shanks', 'wano'],
  jujutsukaisen: ['jujutsukaisen', 'jjk', 'gojo', 'sukuna', 'yuji', 'megumi', 'geto'],
  attackontitan: ['attackontitan', 'aot', 'shingekinokyojin', 'eren', 'levi', 'mikasa'],
  dragonball: ['dragonball', 'dbz', 'dbs', 'goku', 'vegeta', 'gohan', 'kakarot'],
  bleach: ['bleach', 'ichigo', 'aizen', 'rukia', 'bankai', 'tybw'],
};

function matchesCat(item, cat) {
  return EM.matchesCategory(item, cat, FRANCHISE_EXCLUSIVE_MARKERS);
}
function qualityOk(v) {
  const digg = Number(v.digg_count || v.digg || 0);
  const plays = Number(v.play_count || v.plays || 0);
  if (!digg && !plays) return true;               // no stats → don't judge
  return digg >= 1000 || plays >= 10000;          // no low-life videos
}

// ── routes ────────────────────────────────────────────────────────────────
function routeZip(cat) {
  const out = [];
  for (const f of cat.files || []) out.push(...loadLinkFile(f));
  return out.filter(i => categoryCreators(cat).length ? true : matchesCat(i, cat))
    .map(i => ({ ...i, src: 'zip', cid: 'zip_' + i.url }));
}
const NO_SHARED_CREATOR_FILES = new Set(['cruise.txt', 'discipline.txt', 'fyp.txt', 'freefire.txt', 'feeling.txt']);
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
  console.log(`[anime-edits][pages] ${cat.label}: category creators ${catNames.length ? catCands.length : 0} videos, edits/_usernames.txt ${fileOnly.length} creators → ${fileCands.length} videos (${fromFile.length} match ${cat.label})`);
  return [...fromCat, ...fromFile];
}
async function routeSearch(cat) {
  const words = cat.aliases.filter(a => a.length > 2);
  const kw = (words[Math.floor(Math.random() * words.length)] || cat.label) + ' edit';
  try {
    const vids = await nexraySearch(kw);
    return vids.filter(v => qualityOk(v)).map(v => {
      const author = v.author?.nickname || (v.author && v.author.unique_id) || 'tiktok';
      const vidId = v.id || v.video_id;
      return {
        url: 'https://www.tiktok.com/@' + author + '/video/' + vidId,
        caption: v.title || '', hashtags: '',
        play: v.data || v.hdplay || v.play || '',
        cid: 'search_' + vidId,
        src: 'search',
        digg_count: v.stats?.likes || v.digg_count,
        play_count: v.stats?.views || v.play_count,
      };
    }).filter(i => i.url.includes('/video/') && matchesCat(i, cat));   // keyword search must match the category for every category
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
  // shuffle
  for (let i = deduplicated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deduplicated[i], deduplicated[j]] = [deduplicated[j], deduplicated[i]];
  }
  return deduplicated.slice(0, n);
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
    return ['pages', 'search', 'zip', 'gc'];
  }
  const base = ['zip', 'pages', 'search', 'gc'];
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
  console.log(`[anime-edits][fetch] Creator pages registered: ${users.length} in edits/_usernames.txt + ${cats.length} category creators (read live per request; no links saved)`);
  // The monitor logs every creator from both lists: video count, followers, and status.
  try {
    const CPS = require('./lib/creatorPageStatus.cjs');
    CPS.addCreatorSource('category-creators', allCategoryCreators);
    CPS.startCreatorPageMonitor({ intervalMs: 15 * 60 * 1000, log: console.log });
  } catch (e) { console.log('[anime-edits] creator page monitor unavailable:', e && e.message); }
}

// ── creator-page delivery: temp file on disk, removed after the send ─────
const CREATOR_MAX_BYTES = 64 * 1024 * 1024;   // WhatsApp video limit
async function downloadCreatorToFile(url, file) {
  const run = async () => {
    const r = await axios.get(url, {
      headers: { ...UA, Referer: 'https://www.tiktok.com/' }, responseType: 'stream',
      timeout: 20000, maxContentLength: CREATOR_MAX_BYTES, validateStatus: () => true,
    });
    if (r.status >= 400 || !r.data) {
      try { r.data && r.data.destroy && r.data.destroy(); } catch {}
      console.log(`[anime-edits][download] HTTP ${r.status} from ${(() => { try { return new URL(url).host; } catch { return 'bad-url'; } })()}`);
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
    if (size < 2048) { console.log(`[anime-edits][download] file too small (${size} bytes)`); return 0; }
    const head = Buffer.alloc(12);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    if (head.subarray(4, 8).toString('ascii') !== 'ftyp') { console.log('[anime-edits][download] not an MP4 file'); return 0; }
    return size;
  };
  try {
    if (_heavyGuard && typeof _heavyGuard.runHeavy === 'function') {
      return await _heavyGuard.runHeavy(run, { tag: 'creator-page-dl', timeoutMs: 120000 });
    }
    return await run();
  } catch (e) { console.log(`[anime-edits][download] failed: ${(e && e.message) || e}`); try { fs.rmSync(file, { force: true }); } catch {} return 0; }
}
const NO_REENCODE_CATEGORIES = new Set([
  "fyp", "foryou", "foryoupage",
  "cruise", "cruzz", "techcruzz",
  "feeling",
  "discipline", "discip",
]);

function shouldSkipReencode(catKey, item) {
  // All status menu categories use the HD re-encode option with 1.2 quality boost
  return false;
}

async function deliverItemFromDisk(sock, jid, msg, item, caption, catKey = null) {
  if (!CVD) { console.log('[anime-edits][deliver] disk delivery module is not loaded'); return false; }
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
      console.log(`[anime-edits][direct] sending ${categoryName || "edit"} untouched (no re-encode): ${file}`);
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
        console.log(`[anime-edits][hd] 1.3 HD state re-encoded: ${hdEncoded.path} (${hdEncoded.bytes} bytes)`);
      } catch (err) {
        console.warn(`[anime-edits][hd] HD re-encode skipped/timed out: ${err?.message}, delivering source video directly`);
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
    console.log("[anime-edits][delivery] disk delivery failed:", (e && e.message) || e);
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
const DELIVERY_BUDGET_MS = 90 * 1000;   // stop starting new attempts after this
const MAX_DELIVERY_TRIES = 12;          // a failed candidate is skipped and the next one tried
function creatorOf(item) {
  if (item && item.creator) return String(item.creator).toLowerCase();
  const m = String((item && item.url) || '').match(/tiktok\.com\/@([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function makeDeliveryPlan(fresh) {
  const buckets = new Map();
  for (const it of fresh) {
    const s = it.src || 'other';
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(it);
  }
  const usedKeys = new Set();
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

// Fetches fresh candidates when the first pool is used up. Skips anything already
// tried in this request and any link that recently failed to deliver.
async function fetchMoreCandidates(catKey, cat, user, zipItems, attempted) {
  const named = (label, p) => Promise.resolve(p).catch((e) => {
    console.log(`[anime-edits][refetch] ${cat.label} ${label} failed: ${(e && e.message) || e}`);
    return [];
  });
  const parts = await Promise.all([
    named('pages', routePages(cat)),
    named('search', routeSearch(cat)),
  ]);
  console.log(`[anime-edits][refetch] ${cat.label} sources: pages ${parts[0].length}, search ${parts[1].length}`);
  const all = [...(zipItems || []), ...parts.flat()].filter((i) => i && !isDeadLink(i.url));
  const candidates = all.filter((i) => !attempted.has(contentKeyOf(i)));
  const seen = new Set(((loadSeen()[user] || {})[catKey]) || []);
  const unseen = candidates.filter((i) => !seen.has(contentKeyOf(i)));
  return unseen.length ? unseen : candidates;
}

// ── install ───────────────────────────────────────────────────────────────
module.exports = {
  install(P, helpers) {
    if (!axios && helpers.axios) axios = helpers.axios;
    startCreatorLinks();

    async function runEditCmd(catKey, sock, msg) {
      const jid = msg.key.remoteJid;
      const user = (msg.key.participant || msg.key.remoteJid || '').split(':')[0];
      const cat = CATEGORIES[catKey];
      await P.react(sock, msg, '☄️').catch(() => {});
      // Prefer local verified links. Don't wait on external APIs when the
      // local pool already has enough usable edits for this request.
      const zipItems = (routeZip(cat) || []).filter((i) => !isDeadLink(i.url));
      let networkParts = [];
      if (zipItems.length < 2) {
        const netPromise = Promise.all([
          routePages(cat).catch(() => []),
          routeSearch(cat).catch(() => []),
        ]);
        networkParts = await Promise.race([
          netPromise,
          new Promise((r) => setTimeout(() => r([[], []]), 10000)),
        ]);
      }
      const pool = [zipItems, ...networkParts].flat().filter((i) => !isDeadLink(i.url));
      if (!pool.length) {
        await P.react(sock, msg, '❌').catch(() => {});
        return P.sendReply(sock, msg, `❌ No ${cat.label} edits available right now. Try again in a bit.`);
      }
      const fresh = pickUnseen(user, catKey, pool, pool.length);
      const countBySrc = {};
      for (const i of pool) countBySrc[i.src || 'other'] = (countBySrc[i.src || 'other'] || 0) + 1;
      console.log(`[anime-edits][pick] ${cat.label} for ${user}: pool ${JSON.stringify(countBySrc)}`);
      let plan = makeDeliveryPlan(fresh);
      const sent = [];
      const attempted = new Set();   // every candidate tried in this request, delivered or not
      let refetched = false;
      let fourKError = null;
      const deadline = Date.now() + DELIVERY_BUDGET_MS;
      let tries = 0;
      while (sent.length < 2 && tries < MAX_DELIVERY_TRIES && Date.now() < deadline) {
        let c = plan.next();
        if (!c && !refetched) {
          // The first pool is used up or failed: fetch new candidates once and keep going.
          refetched = true;
          const more = await fetchMoreCandidates(catKey, cat, user, zipItems, attempted);
          console.log(`[anime-edits][refetch] ${cat.label} for ${user}: ${more.length} new candidates`);
          if (more.length) { plan = makeDeliveryPlan(more); c = plan.next(); }
        }
        if (!c) break;
        if (attempted.has(c.key)) continue;
        attempted.add(c.key);
        tries++;
        const where = c.src + (c.creator ? ' @' + c.creator : '');
        const caption = String(c.item.caption || c.item.title || (cat.label + ' edit'))
          .replace(/\s+/g, ' ').trim().slice(0, 120) || (cat.label + ' edit');
        // Disk only: the edit is downloaded to a temp folder, sent from disk, and
        // that folder is removed after the send succeeds or fails. No RAM fallback.
        let res = false;
        try { res = await deliverItemFromDisk(sock, jid, msg, c.item, caption, catKey); } catch (e) {
          console.log(`[anime-edits][deliver] error from ${where}: ${(e && e.message) || e}`);
          res = false;
        }
        const ok = res === true;
        if (ok) {
          plan.delivered(c);
          sent.push(c.key);
          console.log(`[anime-edits][sent] ${cat.label} for ${user}: edit ${sent.length}/2 from ${where}`);
        } else {
          // Failed candidate: remember it, skip it, and move on to the next one.
          if (res && res.error) fourKError = res.error;
          plan.failed(c);
          markDeadLink(c.item.url);
          console.log(`[anime-edits][failed] ${cat.label} for ${user}: ${where} did not deliver, skipping to next`);
        }
      }
      if (sent.length) {
        markSeen(user, catKey, sent);
        await P.react(sock, msg, '✅').catch(() => {});
        if (sent.length < 2 && !fourKError) await P.sendReply(sock, msg, '⚠️ Only one edit could be delivered this time (some sources were down).');
        if (fourKError) await P.sendReply(sock, msg, fourKError);
      } else {
        await P.react(sock, msg, '❌').catch(() => {});
        if (fourKError) await P.sendReply(sock, msg, fourKError);
        else await P.sendReply(sock, msg, `❌ TikTok download APIs are busy right now — try again in a moment.`);
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
      } catch (e) { console.log('[anime-edits] register failed for', key, e && e.message); }
    }
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
};
