// Node-hosted menu helpers. No sockets, sessions, timers or startup side effects.
export const REMOVED_MENU_CATEGORIES = new Set(['GAMES', 'TEXTMAKER', 'STALK', 'LOGO', 'FUN', 'INTELLIGENCE', 'ANIMATION', 'TTS', 'UTILITY']);

// Menu-only selections. These never change registration, authorization or handlers.
export const SEARCH_MENU_EXCLUSIONS = new Set(`
apksearch applemusic basketball berita-antara berita-cnbc berita-cnn berita-detik
berita-kompas berita-liputan6 berita-republika berita-tempo berita-tribun berita-viva
igsearch imdbsearch nik recommend scsearch search-apkpure search-applemusic
search-bukalapak search-canva search-capcut search-font search-deezer search-gimage
search-font8 search-github search-google search-gnews search-instagram search-islamqa
search-jkt48 search-lirik search-npm search-pinterest search-playstore search-reddit
search-scholar search-shopee search-soundcloud search-spotify search-tokopedia
search-tiktok search-stickerwa search-twitter search-wallpaper search-wikipedia
search-wiktionary search-youtube search-ytmusic sportsnews spotisearch telegramchan
tiksearch trending ud trending2 wagroupsearch currency movie
`.trim().split(/\s+/));
// "apple music" is an existing display label for the registered applemusic name.
export const MENU_DISPLAY_LABELS = Object.freeze({ 'apple music': 'applemusic' });
export const TOOLS_MENU_EXCLUSIONS = new Set(`
acutetext alightmotion allstyles artoid brokenlink circlednegtext circledtext
cjkthaitext codecompile currency curvy1text curvy2text curvy3text dbase decfile
detectlanguage dnslookup ebase emojidecrypt emojiencrypt emojigif emojimix encfile
enhance3 entoid faceswap fauxcyrillic fauxethiopic fdroid fullwidthtext getfile
hdvideo2 hostcheck html2img htmlencode htmlencrypt idtoen img2qr jatoid jsobfuscate
kotoid mathbolditalic mathboldscript mathboldtext mathdoublestruck mathfraktur
mathmonospace mathsansbold mathsansbolditalic mathsansitalic mathsanstext nikparse
nsfw-check ocr parenthesized price reencode remux removebg2 removebg removebg3 removevocal
reversedtext rockdotstext sendemail setjs skip-adlinksumo smallcapstext spamngl
squarednegtext squaredtext ssweb strokedtext subdomain-finder subscripttext
superscripttext sync syncstatus syntaxcheck tagtext textgif textimage textmp4
tiktok-earnings tiktok-hashtags tktranscript trackip translate trt truecaller
tttranscript upload-nx upscale2 upscale3 upscale4 upscale5 upscale6 usernamegen
uuid vcc vcfcast vcfread virtual-number virtual-number2 webinfo webphishing
webtozip whatsmusic winrate-mlbb wink yt-summarize yt-summarize2 yt-transcribe
`.trim().split(/\s+/));
export function menuExclusionReport(commands, aliases = new Map()) {
  const resolve = name => {
    const key = MENU_DISPLAY_LABELS[name] || name;
    const entry = commands.get(key);
    const canonical = String(entry?.canonical || aliases.get(key) || key).toLowerCase();
    return commands.has(canonical) ? canonical : null;
  };
  const report = {};
  for (const [label, selection] of [['search', SEARCH_MENU_EXCLUSIONS], ['tools', TOOLS_MENU_EXCLUSIONS]]) {
    report[label] = { matched: [], unmatched: [], mappings: [] };
    for (const name of selection) {
      const canonical = resolve(name);
      if (!canonical) report[label].unmatched.push(name);
      else { report[label].matched.push(name); report[label].mappings.push({ selected: name, canonical }); }
    }
  }
  return report;
}
function menuHiddenCanonicals(commands, aliases) {
  const report = menuExclusionReport(commands, aliases);
  return new Set([...report.search.mappings, ...report.tools.mappings].map(item => item.canonical));
}

// Presentation-only labels; API/command metadata and handlers stay untouched.
const LEGACY_LABELS = {
  GENERAL: 'INFO', MENU: 'INFO', AI: 'INTELLIGENCE', ANIME: 'ANIMATION',
  'NEXRAY-AI': 'INTELLIGENCE', 'NEXRAY-ANIME': 'ANIMATION',
  'NEXRAY-CANVAS': 'MEDIA', 'NEXRAY-DOWNLOADER': 'DOWNLOAD',
  'NEXRAY-EDITOR': 'MEDIA', 'NEXRAY-EPHOTO': 'LOGO',
  'NEXRAY-FUN': 'FUN', 'NEXRAY-GAMES': 'GAMES', 'NEXRAY-INFO': 'INFO',
  'NEXRAY-MAKER': 'TEXTMAKER', 'NEXRAY-NEWS': 'SEARCH',
  'NEXRAY-PAYMENT': 'INFO', 'NEXRAY-PRIMBON': 'MISC',
  'NEXRAY-RANDOM': 'MISC', 'NEXRAY-SEARCH': 'SEARCH',
  'NEXRAY-STALKER': 'STALK', 'NEXRAY-TEXTPRO': 'TEXTMAKER',
  'NEXRAY-TOOLS': 'TOOLS', 'NEXRAY-UPLOADER': 'TOOLS',
};
export const ORIGINAL_PHASE1_QUOTES = Object.freeze([
  'Ambition becomes a future when you give it a place in your daily routine.',
  'A life lesson is useful only when your next choice remembers it.',
  'Growth is the quiet agreement to stop defending the habits that hold you back.',
  'Discipline keeps building after excitement has left the room.',
  'Patience is not standing still; it is giving honest work time to take root.',
  'Betrayal reveals a boundary you are allowed to rebuild more carefully.',
  'Cheating is a choice someone made, not a verdict on your worth.',
  'Trust grows where small promises are kept without an audience.',
  'Self-respect means you do not have to abandon yourself to keep somebody close.',
  'Independence is learning to carry your future without closing your heart.',
  'A healthy relationship leaves room for two people to keep becoming themselves.',
  'Build a better future with decisions your tired tomorrow will thank you for.',
  'Let your ambition make you consistent before it makes you visible.',
  'A lesson learned gently is still worth keeping when life becomes loud.',
  'You can outgrow a chapter without pretending it never mattered.',
  'The smallest promise you keep to yourself can become the strongest foundation.',
  'Waiting wisely means preparing for the door, not staring at it.',
  'After betrayal, choose discernment rather than a lifetime of suspicion.',
  'Loyalty is not a speech about love; it is what happens when love is unobserved.',
  'Rebuilding trust needs changed patterns, not more polished apologies.',
  'Your peace does not need a courtroom before you are allowed to protect it.',
  'Standing on your own feet does not mean refusing a helping hand.',
  'Choose relationships where honesty does not have to compete with comfort.',
  'The future improves every time you finish one useful thing today.',
]);
const CATEGORY_ALIASES = { GAME: 'GAMES', STALKER: 'STALK', GROUPS: 'GROUP', TOOL: 'TOOLS', DOWNLOADS: 'DOWNLOAD', DL: 'DOWNLOAD', MAIN: 'INFO', SYSTEM: 'INFO', SETTING: 'SETTINGS' };
export function normalizeMenuCategory(value, categories = []) {
  const key = String(value || '').trim().toUpperCase().replace(/^CAT_/, '');
  if (key === 'AI' && Array.isArray(categories) && categories.some(c => String(c?.name || '').toUpperCase() === 'AI')) {
    return 'AI';
  }
  return LEGACY_LABELS[key] || CATEGORY_ALIASES[key] || key;
}
export function boldCommand(value) {
  // WhatsApp's supported bold markup, not a claim of custom fonts/colours.
  return '*' + String(value || '').toUpperCase().replace(/[*_~`\r\n]/g, '') + '*';
}
// Already represented in the settings UI: hide duplicate MISC menu rows only.
export const SETTINGS_MISC_DUPLICATES = new Set([
  'antiedit', 'antied', 'noedit', 'antidelete', 'antidel', 'nodelete',
  'antibug', 'antibomb', 'antifreeze', 'antihang', 'antimention',
  'autoblock', 'autobio', 'autoreact', 'cmdreact', 'autoread',
  'autotyping', 'autorecording', 'alwaysonline', 'blockcalls',
  'antibroadcast', 'anticall', 'antiviewonce', 'antivonce',
]);
export function isMenuEntryVisible(name, entry, context = {}) {
  if (normalizeMenuCategory(entry?.category) === 'MISC' && SETTINGS_MISC_DUPLICATES.has(String(name).toLowerCase())) return false;
  if (!entry || typeof entry.handler !== 'function' || entry.disabled || entry.enabled === false || entry.hidden || entry.internal || /^Internal\b/i.test(entry.desc || '')) return false;
  if (context.owner === undefined) return true; // registry-wide audits, not a user response
  if (entry.creatorOnly && !context.creator) return false;
  // Existing v38 wrappers guard settings/customization even where ownerOnly
  // metadata is absent. Mirror that visibility rule without touching guards.
  // Every user sees the full command list. Owner-only and admin-only entries
  // are still enforced when a command runs (index.js dispatch); this only
  // controls what the menu lists. Creator-only tools stay hidden from others.
  if (entry.groupOnly && !context.group) return false;
  if (!context.owner && context.banned?.has(name)) return false;
  if (context.safeMode && context.risky?.has(name)) return false;
  return true;
}
export function canonicalMenuEntries(commands, aliases = new Map(), categories = [], context = {}) {
  const shared = new Map();
  for (const cat of categories) {
    const category = normalizeMenuCategory(cat.name, categories);
    if (REMOVED_MENU_CATEGORIES.has(category)) continue;
    for (const name of cat.cmds || []) {
      const key = String(name).toLowerCase();
      const entry = commands.get(key);
      const canonical = String(entry?.canonical || aliases.get(key) || key).toLowerCase();
      if (!shared.has(canonical)) shared.set(canonical, category);
    }
  }
  const unique = new Map();
  const hidden = menuHiddenCanonicals(commands, aliases);
  for (const [name, entry] of commands) {
    if (!isMenuEntryVisible(name, entry, context)) continue;
    const canonical = String(entry.canonical || aliases.get(name) || name).toLowerCase();
    if (hidden.has(canonical) && !['tg-sticker', 'time'].includes(canonical)) continue;
    // A deleted canonical must not be advertised by a dangling alias.
    const primary = commands.get(canonical);
    if (!isMenuEntryVisible(canonical, primary, context)) continue;
    const rawCategory = normalizeMenuCategory(primary.category || shared.get(canonical) || 'MISC', categories);
    const category = REMOVED_MENU_CATEGORIES.has(rawCategory) ? shared.get(canonical) : rawCategory;
    if (!category || REMOVED_MENU_CATEGORIES.has(category)) continue;
    const definition = categories.find(cat => normalizeMenuCategory(cat.name, categories) === category);
    if ((definition?.adult || ['ADULT', 'HENTAI', 'NSFW'].includes(category)) && context.owner !== undefined && (!context.adultMode || context.safeMode)) continue;
    if (!unique.has(canonical) || name === canonical) unique.set(canonical, { name: canonical, category, entry: primary });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function activeMenuCategories(commands, aliases, categories, context = {}) {
  const entries = canonicalMenuEntries(commands, aliases, categories, context);
  const grouped = new Map();
  for (const item of entries) {
    if (!grouped.has(item.category)) {
      const previous = categories.find(cat => normalizeMenuCategory(cat.name, categories) === item.category);
      grouped.set(item.category, { ...previous, name: item.category, emoji: previous?.emoji || '📁', cmds: [] });
    }
    grouped.get(item.category).cmds.push(item.name);
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function resolveMenuCategory(args, categories) {
  if (!Array.isArray(args) || !args.length) return null;
  const raw = args.join(' ').trim().toUpperCase().replace(/^CAT_/, '');
  const hasExplicit = Array.isArray(categories) && categories.some(cat => String(cat?.name || '').toUpperCase() === raw);
  if (!hasExplicit && Object.hasOwn(LEGACY_LABELS, raw)) return null;
  const wanted = normalizeMenuCategory(raw, categories);
  if (!wanted || REMOVED_MENU_CATEGORIES.has(wanted)) return null;
  const exact = categories.find(cat => cat.name === wanted);
  if (exact) return exact;
  const matches = categories.filter(cat => cat.name.startsWith(wanted));
  return matches.length === 1 ? matches[0] : null;
}
export function formatMenuCategory(cat) {
  const rule = '────────────────────';
  const heading = '*' + String(cat.name).toUpperCase() + '*  (' + cat.cmds.length + ')';
  const visible = heading.replace(/[\*\u200b]/g, '');
  const centered = ' '.repeat(Math.max(0, Math.floor((rule.length - [...visible].length) / 2))) + heading;
  return [rule, centered,
    ...cat.cmds.map(name => '± ' + boldCommand(name))].join('\n');
}
export function quoteSection(quote) {
  return '> _"' + String(quote ?? '') + '"_\n\n';
}
export function createMenuQuoteSelector(getQuotes, random = Math.random) {
  const previous = new Map();
  return function select(userId = 'global') {
    const key = String(userId || 'global');
    let pool;
    try { pool = [...new Set(getQuotes().filter(q => typeof q === 'string' && q.length))]; } catch { pool = []; }
    if (!pool.length) return 'You are closer than you think. Keep going.';
    const candidates = pool.length > 1 ? pool.filter(q => q !== previous.get(key)) : pool;
    let index = 0;
    try { const n = random(); if (Number.isFinite(n) && n >= 0 && n < 1) index = Math.floor(n * candidates.length); } catch {}
    const quote = candidates[index] || candidates[0];
    if (previous.size >= 2000 && !previous.has(key)) previous.delete(previous.keys().next().value);
    previous.set(key, quote);
    return quote;
  };
}
export const MENU_REACTIONS = Object.freeze({ MAIN: '📋', ALL: '🏷️', INTELLIGENCE: '🤖', ANIMATION: '🍥', DOWNLOAD: '📥', GROUP: '👥', AUDIO: '🎵', TOOLS: '🔧', OWNER: '🔐', SETTINGS: '⚙️', CONFIG: '🎛️', CREATOR: '👑', CONVERT: '🔄', DEBUG: '🐛', STATUS: '🎬', INFO: '📊', MEDIA: '🖼️', MISC: '📁', SEARCH: '🔍', SESSION: '🔑', TTS: '🔊', UTILITY: '🛠️', WHATSAPP: '📱', AI: '🤖', ANIME: '🍥', ADULT: '🔞', HENTAI: '❤️‍🔥', NSFW: '🚨', NEXRAY: '⚡', 'NEXRAY-CANVAS': '🎴' });
// Reactions are separate from menu text. Main/all retain the requested 💔;
// category requests use their existing supported category-specific reactions.
// P3 fix: ".menu" (MAIN) -> 🏷️, ".allmenu" (ALL) -> 🖇️. Each category returns
// its own mapped reaction so a category never falls back to the main-menu emoji.
export function menuReaction(category) {
  const raw = String(category || '').toUpperCase();
  if (!raw || raw === 'MAIN') return '\uD83C\uDFF7\uFE0F'; // 🏷️
  if (raw === 'ALL') return '\uD83D\uDD17\uFE0F';          // 🖇️
  return MENU_REACTIONS[normalizeMenuCategory(raw)] || '\uD83C\uDFF7\uFE0F';
}
export function installMenuCategoryPolicy(commands, aliases, categories, legacyNames = [], isDisabled = () => false) {
  // Category removal is presentation-only. Never delete handlers or alias maps.
  void legacyNames;
  const removed = new Set(), ambiguous = new Set();
  const denied = () => false;
  const originalSet = commands.set.bind(commands);
  commands.set = function(name, entry) {
    if (isDisabled(name)) entry = { ...entry, disabled: true, enabled: false };
    return originalSet(name, entry);
  };
  function clean() {
    for (const cat of categories) if (REMOVED_MENU_CATEGORIES.has(normalizeMenuCategory(cat.name, categories))) removed.add(cat.name);
    categories.splice(0, categories.length, ...categories.filter(cat => !REMOVED_MENU_CATEGORIES.has(normalizeMenuCategory(cat.name, categories))));
    return { removed: [...removed].sort(), ambiguous: [...ambiguous].sort(), exclusions: menuExclusionReport(commands, aliases) };
  }
  clean();
  return { denied, clean, removed, ambiguous };
}
// Legacy UI identifiers resolve into the same premium renderer, never a static list.
export async function forwardPremiumMenu(sock, jid, msg, args = []) {
  if (typeof globalThis.__MIAS_PREMIUM_MENU__ !== 'function') throw new Error('Command registry is not ready; menu unavailable');
  if (!msg?.key?.remoteJid || !msg.key.id || msg.key.remoteJid !== jid) throw new Error('Original menu request is required');
  const categoryAliases = { cat_system: 'info', cat_dl: 'download', cat_groups: 'group' };
  const routed = args.map(value => categoryAliases[value] || String(value).replace(/^cat_/, ''));
  return globalThis.__MIAS_PREMIUM_MENU__(sock, msg, routed, false);
}
// Classify explicit delivery rejections separately from unavailable pictures.
export function isCaptionLimitError(error) {
  return /(?:caption|text|message).*(?:too long|length limit|exceeds.{0,25}(?:limit|maximum)|maximum length)|(?:too long|length limit).*caption/i.test(String(error?.message || error));
}
export function splitMenuText(text, limit) {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError('Menu chunk limit must be an integer >= 2');
  const chunks = []; let rest = String(text || '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit - 1);
    if (cut < limit / 2) cut = limit;
    else cut += 1;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
export async function deliverMenuCaption(sock, msg, text, pictureSources, sendReply, mentions = []) {
  const jid = msg.key.remoteJid;
  // Conservative delivery budget, not an assertion about every WhatsApp client.
  // Ordinary menus stay in one caption; oversized output is bounded BEFORE send.
  const safeChunks = splitMenuText(text, 16000);
  const caption = safeChunks[0] || '';
  const sendText = async value => {
    for (const chunk of splitMenuText(value, 4000)) await sendReply(sock, msg, chunk);
  };
  const finish = async () => { for (const chunk of safeChunks.slice(1)) await sendText(chunk); };
  for (const source of pictureSources) {
    let image;
    try { image = await source(); } catch { continue; }
    if (!image) continue;
    try { await sock.sendMessage(jid, { image, caption, ...(mentions.length ? { mentions } : {}) }, { quoted: msg }); }
    catch (error) {
      if (!isCaptionLimitError(error)) continue;
      // Only an explicit rejection proves a continuation is necessary. Keep
      // the quote/header in the first image and preserve every character.
      for (const limit of [4096, 2048, 1024]) {
        if (caption.length <= limit) continue;
        const chunks = splitMenuText(caption, limit);
        try { await sock.sendMessage(jid, { image, caption: chunks[0], ...(mentions.length ? { mentions } : {}) }, { quoted: msg }); }
        catch (retryError) { if (isCaptionLimitError(retryError)) continue; break; }
        for (const chunk of chunks.slice(1)) await sendText(chunk);
        await finish();
        return;
      }
      continue;
    }
    await finish();
    return;
  }
  return sendText(text);
}

// ── Download branding footer ────────────────────────────────────────────────
// Applied ONLY to downloaded-media captions by the shared delivery helpers.
// A zero-width space keeps WhatsApp from turning the line into a quote block,
// so the visible text stays exactly "> POWERED BY JUST X".
export const JUST_X_FOOTER = '> POWERED BY JUST X';
export function withJustXFooter(caption) {
  const text = String(caption ?? '');
  if (text.includes('POWERED BY JUST X')) return text; // never duplicate
  const footer = '\u200B' + JUST_X_FOOTER;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? trimmed + '\n\n' + footer : footer;
}
