// .quote command + daily 12am quote helpers.
// Pure functions only: the socket, the timer and the send live in mias/index.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { topicFootersFor, handFooterFor } = require('./quoteFooters.cjs');

// Themed quotes. Each theme has its own footer lines; {name} becomes the @tag.
const THEMES = {
  breakup: {
    footers: ['{name}, you are allowed to move on at your own pace.', '{name}, stay soft but do not go back.', '{name}, keep your heart and let go of the chains.'],
    quotes: [
      'Moving on is not forgetting them. It is deciding they no longer get your tomorrows.',
      'You can miss someone and still know that going back would cost you more.',
      'The day you stop checking their profile is not a dramatic day. It just arrives quietly.',
      'Heartbreak is a bad teacher, but it leaves you with a clearer list of what you will not accept again.',
      "You don't need closure from the person who caused the pain. You need to close the tab in your mind.",
      'Every version of you that survived that breakup is stronger than the one who was scared to lose them.',
      'Some people are a lesson, not a forever. Learn it, pack it, and keep walking.',
      'Stop auditioning for someone who already chose to leave.',
      'Healing looks boring from the outside: eating, sleeping, working, laughing again. That is the work.',
      'A new season does not need their permission to begin.',
      'Missing them is a feeling. Going back is a decision. You are allowed to feel one without doing the other.',
      'Be gentle with the version of you that stayed too long. They were doing their best with what they knew.',
      'The right person will not make you earn peace after a breakup. Neither should you.',
      'One day you will laugh at this heartbreak, probably while telling someone else how you survived it.',
      "Don't rush to date again just to prove you are over them. Rush to become whole.",
      'Their new life is not a verdict on your worth. It is a sign they are no longer your story.',
      'The goodbye hurts most when you keep rereading the ending. Close the book and start the next chapter.',
      'Cutting off a toxic ex is not cruelty. It is protection that looks like silence.',
      'You are not behind. Healing has its own calendar, and it does not care about other people\'s timelines.',
      'Walk away with your dignity intact. The rest will fade with time.',
      'Peace after a breakup feels small at first. Then one day it is the biggest thing you have.',
      "Don't keep the door open for someone who only visits when they are lonely.",
      'A broken heart is still a heart. It can learn to trust again, slowly and with wiser eyes.',
      'The memories will come back. Let them pass like weather instead of building a house in them.',
      'Tomorrow you can be lighter than you were yesterday. Start there.',
    ],
  },
  darkness: {
    footers: ['{name}, stay with the light, even a small one.', '{name}, you do not have to carry it alone. Reach out.', '{name}, stay safe, one hour at a time.'],
    quotes: [
      'Darkness is loud when you are alone with it. Say one true thing to someone who can hear you.',
      'Some nights are only long. They do not have to become your whole life.',
      'You do not need to be fine to deserve help. You only need to ask for it.',
      'Sadness can visit without moving in. Keep one small routine alive while it stays.',
      'The sun did not come back because the night argued with it. It came back because time kept moving.',
      'Survival is also a kind of strength, even when it looks like getting through one hour at a time.',
      'If a thought tells you that you are a burden, remember that burdens are shared, not hidden.',
      'Stay near the people who make the room feel less heavy, even if you cannot explain why you are tired.',
      'You are not weak for crying in a room that feels too small. You are human in a hard season.',
      'Darkness says nothing will change. It is a liar, but a persistent one. Do not argue with it alone.',
      'Put your feet on the floor, drink some water, open a window. Small things pull you back to the present.',
      'Hope can be quiet. Sometimes it looks like one more morning and one more try.',
      'Your pain is real, and your future is still real too.',
      'You can hold grief and gratitude in the same hand. Both can be true today.',
      'Asking for help is not failing at being strong. It is using the strength you have.',
      'Let the heavy days be heavy without deciding who you are based on them.',
      'A dark room still has a door. Find it, even if you need a hand to show you where it is.',
      'Your mind lies more convincingly when you are exhausted. Rest before you make big conclusions.',
      'Some storms do not end in one night. Keep your umbrella and keep your people close.',
      'If you feel unsafe with your own thoughts, reach out now and tell someone you trust.',
      'Being sad does not cancel the good things still waiting for you.',
      'Be patient with slow healing. Dark seasons thin out one day at a time.',
      'Light often returns through small openings: a message, a walk, a song, a kind face.',
      'You have survived every hard day so far. That is evidence you can keep going.',
      'You do not have to see the whole staircase. Just take the next step.',
    ],
  },
  studying: {
    footers: ['{name}, watch first and trust later.', '{name}, read the actions, not only the speech.', '{name}, be careful with anyone who studies you too closely.'],
    quotes: [
      'Watch what people do when they think nothing is at stake. That is when their character speaks.',
      'Words are cheap. Consistency is expensive. Study the difference.',
      'Notice how someone treats the waiter, the stranger, and the person who can do nothing for them.',
      'Good people admit mistakes without making you pay for them.',
      'Pay attention to the person who asks about you all the time but never shares anything about themselves.',
      'A person who is kind only when they want something is not kind. They are strategic.',
      'Listen for the story someone repeats. The one they tell most often shows what they value.',
      'When someone changes around certain people, learn what those people bring out in them.',
      'Do not ignore a pattern just because the first meeting was nice.',
      'Give someone a small no and see how they take it. That tells you more than a long conversation.',
      'People reveal intentions in small slips. Keep track of the slips.',
      'Study how someone reacts to your success. Real friends celebrate, opportunists measure.',
      'The way someone talks about absent people is how they will one day talk about you.',
      'Quiet people are not always empty. Watch them closely and you will see a lot.',
      'Trust is built from repeated behaviour, not from one dramatic speech.',
      'A smooth tongue can hide a rough heart. Look at the hands, not only the voice.',
      'Notice how you feel after spending time with someone. Your body often knows before your mind does.',
      'Someone who respects your boundaries early will usually respect them later.',
      'Check whether their promises match their calendar. Time is where honesty shows.',
      'Do not confuse charm with character. Charm wins the room; character keeps the promise.',
      'Pay attention to the people they talk down to. That is a preview of how they will treat you.',
      'Be curious, not paranoid. Observe calmly and let people show you who they are.',
      'Patterns tell the truth that single moments hide. Count them.',
      'Good people do not need you to be small for them to feel big.',
      'The more someone asks you to prove loyalty, the more you should notice who is doing the proving.',
    ],
  },
  living_alone: {
    footers: ['{name}, lock up, stay alert, and enjoy your own company.', '{name}, your space is your strength.', '{name}, enjoy the quiet and keep your guard up.'],
    quotes: [
      'Living alone is not being lonely. It is learning how your own company feels when nobody is performing.',
      'A quiet home can teach you what peace sounds like when it is yours.',
      'Lock the door, check the windows, and then enjoy the silence you worked for.',
      'Make your space feel like somewhere someone who respects themselves lives.',
      'Cooking for one is still worth doing well. You are someone worth feeding properly.',
      'Solitude shows you which habits you chose and which ones chose you.',
      'Night loneliness is a visitor. Have a plan for it so it does not sit down.',
      'Your routine is the scaffold of your peace when nobody else is around to hold it up.',
      'Keep emergency numbers saved and a trusted person in the loop. Independence works best with a safety net.',
      'Decorate for yourself, not for guests you have not met yet.',
      'Being alone teaches you to stop waiting for permission to enjoy your own life.',
      'A clean kitchen and a made bed can be the first win of a difficult day.',
      'Learn to be the person you would want as a flatmate: kind, honest, and reliable.',
      'Quiet evenings are a chance to read, sketch, or think without interruption. Use them well.',
      'Stay alert but not afraid. Good habits make a home feel safe.',
      'You do not need someone to approve your plans. You are the one living them.',
      'Your space says how you treat yourself. Let it say you matter.',
      'Some of your best conversations will be with yourself. Make them honest and kind.',
      'Solitude is fertile ground. Plant something you can grow into.',
      'Balance time alone with time with people who love you. Both keep you well.',
      'Celebrate small wins even when nobody is watching. You are allowed to be proud without an audience.',
      'A plant on the windowsill can be enough company on a slow day.',
      'Living alone is a school for responsibility. Pass each test with patience.',
      'When the house is quiet, listen for what you actually want. That voice is worth hearing.',
      'Loneliness and solitude can feel the same on Monday and very different by Sunday. Choose your rhythm.',
    ],
  },
  self_love: {
    footers: ['{name}, you deserve your own kindness.', '{name}, love yourself on purpose today.', '{name}, you are worth showing up for.'],
    quotes: [
      'Loving yourself is not arrogance. It is refusing to speak to yourself in ways you would never accept from anyone else.',
      'You do not have to earn the basic kindness you show yourself.',
      'Your body carried you through every hard day. Treat it like a teammate.',
      'Stop waiting for someone else to give you the love you can start giving yourself today.',
      'Self-respect looks like keeping promises to yourself, even the small ones.',
      'Speak to yourself like someone you are responsible for protecting.',
      'You are allowed to take up space, ask for what you need, and rest without guilt.',
      'The way you treat your own mistakes teaches everyone else how to treat you.',
      'Celebrate your progress even when it looks slow from where you stand.',
      'Learn what makes you feel alive and make time for it without asking permission.',
      'Forgive yourself on purpose. Grudges against yourself are heavy luggage.',
      'You are not a problem to fix. You are a person to know better.',
      'Eat well, sleep, move, and laugh. These are love in practical form.',
      'Set boundaries that protect your energy. Loving yourself often sounds like the word no.',
      'Stop comparing your middle to someone else\'s highlight reel.',
      'Your worth does not rise and fall with how many people approve of you today.',
      'Pick one thing you appreciate about yourself and say it out loud. Repeat it tomorrow.',
      'You can be a work in progress and still deserve respect.',
      'Do not wait to be perfect before you start being kind to yourself. Start with real.',
      'The person you are becoming deserves the same care you give the people you love.',
      'Love yourself enough to leave what keeps shrinking you.',
      'Your voice matters. Use it to say what you feel and what you need.',
      'Be proud of the courage it took to show up today, even if nobody clapped.',
      'You are not too much. You are exactly enough for the right people and places.',
      'Make peace with your past self. They were trying to survive, and they did.',
    ],
  },
  beware_bad_people: {
    footers: ['{name}, stay safe and keep your guard up.', '{name}, be careful of whoever is too sweet too fast.', '{name}, protect your peace.'],
    quotes: [
      'Not everyone who smiles at you wishes you well. Watch the actions behind the smile.',
      'When someone shows you who they are, believe the first time.',
      'Be careful with people who gain from your confusion.',
      'Someone who isolates you from your people is building a cage with soft words.',
      'The person who always has a story about being the victim may be the one causing the harm.',
      'Quick intimacy with a stranger can be a warning, not a gift.',
      'Protect your passwords, your location, and your private business. Not everyone deserves the details.',
      'Trust earned slowly is worth more than affection offered fast.',
      'If someone makes you doubt your memory or your feelings, step back and gather the facts.',
      'The kindest-sounding people sometimes ask the most questions. Answer less than you think you should.',
      'Notice when someone is angry that you have boundaries. That anger is information.',
      'Bad people often hide behind charm. Let time be your filter.',
      'Do not lend what you are not ready to lose, whether money, favours, or secrets.',
      'A person who feels entitled to your time will treat your no as a challenge.',
      'Be wary of pressure that rushes your decisions. Good opportunities can wait for clear thinking.',
      'If you feel uneasy around someone, take the feeling seriously enough to look into it.',
      'Some people hunt for your weakness and call it compassion. Stay calm, but stay present.',
      'Do not share your plans with people who celebrate your slip-ups.',
      'Watch who tries to pull you away from the people who tell you the truth.',
      'Stay alert in new spaces, and keep your phone and your wits close.',
      'Bad energy spreads. Limit how long you sit with people who drain you on purpose.',
      'A liar needs your trust more than you need their company. Withhold it until it is earned.',
      'Ask yourself what they want from you. If the answer keeps changing, be careful.',
      'Protect your peace like a locked door. Not everyone has a key.',
      'A wolf does not always show teeth at first. Watch the patience and the hunger.',
    ],
  },
  girls: {
    footers: ['{name}, respect goes both ways. Stay classy.', '{name}, stay safe and choose wisely.', '{name}, treat people the way you want to be treated.'],
    quotes: [
      'Treat a girl like a person first, not a prize to win or a story to tell.',
      'A girl who knows her worth will not stay for someone who only shows up when it is convenient.',
      'Being honest with a girl is kinder than being interesting.',
      'Listen when she says no. Respect in small moments is what makes you trustworthy.',
      'Do not confuse attention with interest. Read the signals and be patient.',
      'A girl\'s time, body, and feelings belong to her. Treat them with care.',
      'Compliments land best when they are specific and sincere, not a pressure tactic.',
      'Know the difference between being liked and being respected. Aim for respect.',
      'Being mysterious is not the same as being careful with your words. Be clear.',
      'A good girl will notice how you talk about your exes. Speak about them with grace.',
      'Give her room to be herself. Insecurity is not affection.',
      'Do not make her your entertainment. Make her feel safe with you.',
      'The right connection grows when both people feel free to leave without guilt.',
      'If she has to beg for your consistency, the problem is not her standards. Show up.',
      'Respect her friends and family. The way you treat her circle says a lot about your heart.',
      'Do not punish her for having standards. Standards are a sign of self-respect.',
      'A girl does not owe you a reply, a date, or a smile. Accept that and you grow.',
      'Your words should match your actions, especially when someone trusts you.',
      'If she is laughing, listening, and warm, she is probably interested. If she is quiet and short, respect the distance.',
      'Do not treat a girl\'s feelings as a joke. Hearts remember how they were treated.',
      'Build her up with real encouragement, not with jealousy or control.',
      'A relationship that needs you to shrink her is not love. It is a cage with nice wallpaper.',
      'Being kind when nobody is watching is how someone learns they can trust you.',
      'Give her your presence, not just your text messages.',
      'The girl who walks away from disrespect is showing strength, and she deserves admiration, not blame.',
    ],
  },
  life: {
    footers: ['{name}, keep moving, one good day at a time.', '{name}, make today count.', '{name}, stay blessed and stay sharp.'],
    quotes: [
      'Life rarely arrives on schedule, so keep your heart ready even when the plan changes.',
      'You are not behind. Your path is simply not the one you pictured.',
      'Small consistent steps beat dramatic promises every time.',
      'Life gets clearer when you stop waiting for certainty before you act.',
      'Every ending is a doorway if you are willing to walk through it.',
      'Your past is a lesson, not a life sentence.',
      'Gratitude makes ordinary days feel like gifts.',
      'The people who stay with you through hard seasons teach you what loyalty looks like.',
      'You will not control everything. You can control how you show up.',
      'Failure is information. Use it, then try again with better eyes.',
      'Make peace with the pace of your life. Some growth is quiet.',
      'Time keeps moving whether you act or not. Choose one thing you can do today.',
      'Happiness often hides in small routines: a warm drink, a good song, a kind word.',
      'Do not measure your life by someone else\'s highlights. Measure it by your own honest growth.',
      'Hard lessons usually come with the strength to carry them.',
      'You do not need to see the whole road to take the first step.',
      'Spend less energy on what people think and more on who you are becoming.',
      'Life is not a race you win by being first. It is a path you walk with purpose.',
      'Let curiosity lead you. The best discoveries come from questions, not certainties.',
      'Protect your mornings. How you start the day often shapes how you carry it.',
      'A good life is built on honest work, kind people, and rest you do not have to apologise for.',
      'Change is uncomfortable, but it is also where your next version begins.',
      'Stop postponing joy until everything is perfect. Joy is allowed in the middle of the mess.',
      'Keep your word to yourself. Discipline is love with a plan.',
      'One day you will look back and see that the hard days were shaping you into someone steadier.',
    ],
  },
  bad_relationships: {
    footers: ['{name}, stay safe. Your worth is not up for debate.', '{name}, leave the door open for peace, not for pain.', '{name}, be careful of love that costs you yourself.'],
    quotes: [
      'A relationship that makes you smaller every month is not a test of your patience.',
      'If you keep explaining your feelings and nothing changes, you are not being heard.',
      'Love should not feel like a daily negotiation over your basic dignity.',
      'Jealousy dressed up as love is still control. Name it for what it is.',
      'You can care deeply about someone and still see that the relationship is hurting you.',
      'Stop waiting for the person who hurts you to become the person you need. Start asking what you deserve.',
      'A partner who keeps score of your mistakes is not building a future with you.',
      'Constant apologies for things you did not do are a warning sign, not a relationship skill.',
      'Feeling lonely inside a relationship is one of the heaviest kinds of loneliness.',
      'Love that needs you to shrink is not love. Walk away and let your light come back.',
      'Red flags do not disappear because you want them to. Believe what keeps repeating.',
      'A healthy relationship can handle honesty, boundaries, and calm disagreement.',
      'You are allowed to leave a relationship that leaves you exhausted and unseen.',
      'Do not stay for the version of them you hope to find. Stay for the one who shows up.',
      'Manipulation often looks like confusion, guilt, or silence. Trust what you observe.',
      'Love does not require you to lose your friends, your goals, or your self-respect.',
      'Unfair fights teach you to be careful. Respect teaches you to be yourself.',
      'A partner who makes you question your sanity needs a closer look, and maybe a goodbye.',
      'Being chosen is not the same as being treated well. Look at both.',
      'The right partner makes peace feel normal. The wrong one makes calm feel suspicious.',
      'You can love someone and still choose to protect yourself from them.',
      'Do not confuse intensity with intimacy. Real closeness feels safe.',
      'Ask whether this relationship is making you a better version of yourself or a more worried one.',
      'Healing begins when you admit what the relationship really is, not what you wish it could be.',
      'Let go of the relationship that keeps you on edge, and make room for one that lets you breathe.',
    ],
  },
  bad_friends: {
    footers: ['{name}, beware of fake loyalty.', '{name}, stay safe. Real friends show up.', '{name}, keep your circle small and sincere.'],
    quotes: [
      'A friend who only calls when they need something is not a friend. They are a service.',
      'Real friends celebrate your wins without jealousy. Watch who cannot do that.',
      'Do not share your secrets with someone who enjoys your problems more than your progress.',
      'Some friendships end not with a fight but with you finally seeing clearly.',
      'A friend who laughs at your pain is not helping you heal.',
      'Fake loyalty sounds loud in public and disappears in private.',
      'If your friend always has an excuse for hurting you, the excuse is the pattern.',
      'Keep the friends who speak well of you when you are not in the room.',
      'The friend who pushes you into risks you never agreed to is not protecting you.',
      'Stop explaining your worth to people who refuse to see it.',
      'A good friend tells you the truth gently. A bad friend tells you what you want to hear to keep you close.',
      'A friend who gossips about others will eventually gossip about you.',
      'You do not owe endless patience to someone who constantly drains you.',
      'Quality friendships are built on steady care, not on who has the best stories.',
      'Be careful with people who celebrate your downfall in the disguise of concern.',
      'A friend who competes with you is not always an ally. Notice how they react to your progress.',
      'Loyal friends give you space to grow and do not punish you for changing.',
      'It is okay to outgrow friendships that no longer match who you are becoming.',
      'The people who stand up for you when you are absent are the ones worth keeping.',
      'Peer pressure is a crowd asking you to abandon yourself. Say no.',
      'Do not let a group make you feel small for having your own opinion.',
      'Your circle should make your life lighter, not heavier.',
      'A friend who keeps you away from your family or your goals is not a true friend.',
      'Choose friends who are good for your spirit, not just good for the moment.',
      'Loyalty is proven in hard times, not only in good ones. Watch who shows up when it costs them.',
    ],
  },
  life_changes: {
    quotes: [],
    footers: ['{name}, change can feel like loss before it feels like growth.', '{name}, you are allowed to outgrow the life you used to live.', '{name}, let the new season start, even if you are not ready yet.', '{name}, every change you survive adds to who you are.'],
  },
  cheating: {
    quotes: [],
    footers: ['{name}, cheating is a choice someone made, not a test you failed.', '{name}, when someone stops loving you, believe it and stop begging.', '{name}, you deserve a partner who does not need you to stay blind.', '{name}, walk away with your dignity, not with their explanations.'],
  },
  hard_times: {
    quotes: [],
    footers: ['{name}, hard times show you who is really in your corner.', '{name}, do not take it personally when people step back in your struggle.', '{name}, the people who vanish in pain were never your real support.', '{name}, hold your head up and ask for help from the right people.'],
  },
  betrayal: {
    quotes: [],
    footers: ['{name}, betrayal hurts most when it comes from people you trusted.', '{name}, learn the pattern, then decide who gets access to you.', '{name}, forgive if you need peace, but do not hand them the keys again.', '{name}, protect your secrets until trust has been earned back.'],
  },
  men_distance: {
    quotes: [],
    footers: ['{name}, keep your distance from drama, it always costs more than it pays.', '{name}, some people are not closeness material, and that is fine.', '{name}, walk away from anything that keeps you small or stressed.', '{name}, discipline means saying no to things you know are poison.'],
  },
  social_media: {
    quotes: [],
    footers: ['{name}, a polished feed is not the full story, so judge people by how they treat you.', '{name}, protect your attention and your peace online.', '{name}, online attention is not the same as real affection.'],
  },
  self_respect: {
    quotes: [],
    footers: ['{name}, own your part and keep your standards high.', '{name}, respect yourself first, then let others meet that standard.', '{name}, keep your word and your behaviour fair.'],
  },
  red_flags: {
    quotes: [],
    footers: ['{name}, patterns tell the truth, so watch them closely.', '{name}, trust the behaviour you keep seeing, not the story you hope for.', '{name}, healthy signs are consistent, not occasional.'],
  },
  protecting_peace: {
    quotes: [],
    footers: ['{name}, peace is worth more than winning every argument.', '{name}, you do not have to answer every provocation.', '{name}, protect your peace, even when it feels inconvenient.'],
  },
  broke_building: {
    quotes: [],
    footers: ['{name}, build your future before you spend to look successful.', '{name}, be honest about what you can afford.', '{name}, a healthy partner respects honest effort, not just expensive gifts.'],
  },
  choosing_partner: {
    quotes: [],
    footers: ['{name}, choose someone whose actions make trust easier, not harder.', '{name}, chemistry is exciting, but respect is essential.', '{name}, love should add peace to your life, not take it.'],
  },
  men_self_control: {
    quotes: [],
    footers: ['{name}, your self-control is a quiet kind of strength.', '{name}, you do not need validation from others to feel whole.', '{name}, manage your urges with discipline and respect for yourself and others.', '{name}, build a life where your peace does not depend on anyone else.'],
  },
};

const GENERIC_FOOTERS = ['{name}, stay safe.', '{name}, take care of yourself today.', '{name}, keep this one close.'];

const THEME_OF = new Map();
for (const [theme, def] of Object.entries(THEMES)) {
  for (const q of def.quotes) THEME_OF.set(q, theme);
}

// Optional extra quotes: one per line in mias/quotes_custom.txt.
// Blank lines and lines starting with # are ignored. Missing file = no extras.
const CUSTOM_FILE = path.join(__dirname, '..', 'quotes_custom.txt');
function loadCustomQuotes(file = CUSTOM_FILE) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(s => s.replace(/"/g, '').trim())
      .filter(s => s && !s.startsWith('#'));
  } catch {
    return [];
  }
}

const THEMED_QUOTES = Object.values(THEMES).flatMap(def => def.quotes);
// Large themed pool: mias/quotes_10k.txt. A "# theme: <key>" line sets the theme of the quotes under it, so each quote gets its theme's footers.
const TENK_FILE = path.join(__dirname, '..', 'quotes_10k.txt');
function loadThemedFile(file = TENK_FILE) {
  let theme = '';
  const out = [];
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^#\s*theme:\s*([a-z_]+)/i.exec(line);
      if (m) { theme = THEMES[m[1]] ? m[1] : ''; continue; }
      if (line.startsWith('#')) continue;
      const quote = line.replace(/"/g, '').trim();
      if (quote) out.push({ theme, quote });
    }
  } catch {
    return [];
  }
  return out;
}
const TENK_QUOTES = loadThemedFile();
for (const { theme, quote } of TENK_QUOTES) {
  if (theme && !THEME_OF.has(quote)) THEME_OF.set(quote, theme);
}

const QUOTE_POOL = Object.freeze([...new Set([...THEMED_QUOTES, ...TENK_QUOTES.map(x => x.quote), ...loadCustomQuotes()])]);

function digitsOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

// Footer lines for a quote: its hand-written footer, else the topic footers when its wording matches a topic, else its theme footers.
function footerOptions(quote) {
  const hand = handFooterFor(quote);
  if (hand) return hand;
  const topic = topicFootersFor(quote);
  if (topic) return topic;
  const theme = THEME_OF.get(quote);
  return theme ? THEMES[theme].footers : GENERIC_FOOTERS;
}

function pickFooter(quote, random = Math.random) {
  const list = footerOptions(quote);
  const n = random();
  const index = Number.isFinite(n) && n >= 0 && n < 1 ? Math.floor(n * list.length) : 0;
  return list[Math.min(index, list.length - 1)];
}

// The card the user asked for: a "THIS IS FOR YOU" header, the quote, then a themed footer line.
function buildQuoteCard({ jid, quote, name, random = Math.random }) {
  const num = digitsOf(jid);
  // A display name (the bot owner's pushname) is shown as plain text. Strip WhatsApp formatting characters so it cannot break the card.
  const label = String(name || '').replace(/[*_~`\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const tag = label || (num ? '@' + num : 'friend');
  const mentions = !label && num ? [num + '@s.whatsapp.net'] : [];
  const footer = pickFooter(quote, random).split('{name}').join(tag);
  const text = '*THIS IS FOR YOU* ' + tag + '\n\n_"' + quote + '"_\n\n> ' + footer;
  return { text, mentions };
}

const GMT_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function gmtParts(date = new Date()) {
  const p = {};
  for (const part of GMT_FORMAT.formatToParts(date)) p[part.type] = part.value;
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

const LAGOS_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function lagosParts(date = new Date()) {
  const p = {};
  for (const part of LAGOS_FORMAT.formatToParts(date)) p[part.type] = part.value;
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

// True once per GMT calendar day, ONLY during the 12:xx hour (12 GMT / 12:00 UTC).
// Must never trigger on connection or outside 12 GMT.
function shouldSendDailyQuote(date, lastSentDate) {
  const { dateKey, hour } = gmtParts(date);
  return hour === 12 && dateKey !== lastSentDate;
}

module.exports = {
  loadThemedFile,
  TENK_QUOTES,
  THEMES,
  QUOTE_POOL,
  GENERIC_FOOTERS,
  loadCustomQuotes,
  footerOptions,
  pickFooter,
  buildQuoteCard,
  gmtParts,
  lagosParts,
  shouldSendDailyQuote,
  digitsOf,
};
