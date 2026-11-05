// Footer lines matched to what a quote is about.
// Each topic is a keyword rule. The first topic that matches a quote supplies its footer lines;
// a quote with no match keeps its theme footers. {name} becomes the @tag or display name.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOPICS = [
  {
    key: 'breakup',
    re: /\b(ex|exes|breakup|break-up|heartbreak|moving on|closure|goodbye|let go)\b/i,
    footers: [
      '{name}, you can close this chapter without a dramatic ending.',
      '{name}, closure is something you give yourself, not something they owe you.',
      '{name}, letting go is a skill, and you are practicing it right now.',
      '{name}, missing them does not mean going back.',
    ],
  },
  {
    key: 'trust',
    re: /\b(trust|trusts|trusting|lie|lies|liar|lying|honest|honesty|truth|promise|promises)\b/i,
    footers: [
      '{name}, trust is earned in small actions, so keep watching those.',
      '{name}, when their words and actions do not match, believe the actions.',
      '{name}, give trust slowly and take it back the moment it is broken.',
      '{name}, honesty today protects your peace tomorrow.',
    ],
  },
  {
    key: 'respect',
    re: /\b(respect|respects|respectful|boundary|boundaries|dignity|permission)\b/i,
    footers: [
      '{name}, respect goes both ways, so demand it and show it.',
      '{name}, your boundaries are not a punishment for anyone.',
      '{name}, do not explain your no to people who only respect your yes.',
      '{name}, treat others well, and do not accept less in return.',
    ],
  },
  {
    key: 'fake',
    re: /\b(fake|fakes|faking|pretend|pretends|pretending|two-faced|mask|masks|flatter|flattery|sweet)\b/i,
    footers: [
      '{name}, not everyone who smiles at you is on your side.',
      '{name}, be wary of people who are sweet only when it benefits them.',
      '{name}, fake energy drains you, so stop feeding it.',
      '{name}, watch who stays consistent when there is no audience.',
    ],
  },
  {
    key: 'friends',
    re: /\b(friend|friends|friendship|friendships|loyal|loyalty|circle|acquaintance|acquaintances)\b/i,
    footers: [
      '{name}, a real friend shows up, even when it costs them something.',
      '{name}, keep your circle small, sincere, and loyal.',
      '{name}, friendship is proven in the hard seasons, not the easy ones.',
      '{name}, tell the friends who are real that you appreciate them today.',
    ],
  },
  {
    key: 'self',
    re: /\b(worth|deserve|deserves|deserving|self-love|self-respect|confidence|value|valued)\b/i,
    footers: [
      '{name}, you do not have to earn basic kindness from yourself.',
      '{name}, your worth was never up for a vote.',
      '{name}, show up for yourself the way you show up for others.',
      '{name}, believe you deserve the good things you are working toward.',
    ],
  },
  {
    key: 'love',
    re: /\b(love|loves|loved|partner|partners|relationship|relationships|romantic|dating|crush|commitment|marriage|heart|hearts)\b/i,
    footers: [
      '{name}, love should feel safe, not like a test you keep failing.',
      '{name}, a partner should add peace to your life, not take it.',
      '{name}, choose someone who makes your heart calmer, not louder.',
      '{name}, healthy love does not ask you to shrink.',
    ],
  },
  {
    key: 'alone',
    re: /\b(alone|solitude|lonely|loneliness|sanctuary|living alone|own company)\b/i,
    footers: [
      '{name}, your own company can be your strongest comfort.',
      '{name}, enjoy the quiet, lock up, and keep your guard up.',
      '{name}, your space is your sanctuary, so guard it well.',
      '{name}, being alone is not the same as being lonely.',
    ],
  },
  {
    key: 'observe',
    re: /\b(watch|watching|notice|noticing|observe|observing|study|studying|attention|actions|behavior|behaviour|character|listen|listening)\b/i,
    footers: [
      '{name}, watch what people do more than what they say.',
      '{name}, actions reveal character, so pay attention to them.',
      '{name}, notice the people who notice you.',
      '{name}, be careful with anyone who studies you too closely.',
    ],
  },
  {
    key: 'darkness',
    re: /\b(dark|darkness|sad|sadness|pain|painful|grief|grieving|storm|storms|heavy|cry|crying|hopeless|hope|hopes)\b/i,
    footers: [
      '{name}, you do not have to carry it alone. Reach out to someone.',
      '{name}, stay with the light, even a small one.',
      '{name}, hard days pass, and you are still here.',
      '{name}, if it gets too heavy, tell someone you trust right away.',
    ],
  },
  {
    key: 'rest',
    re: /\b(sleep|sleeping|rest|resting|tired|exhausted|exhaustion|body|bodies|night|nights|water|breathe|breath)\b/i,
    footers: [
      '{name}, rest is not laziness, so give yourself some tonight.',
      '{name}, drink some water, sleep well, and let your body catch up.',
      '{name}, your body keeps the score, so listen when it asks for rest.',
      '{name}, a calm night can fix more than you think.',
    ],
  },
  {
    key: 'peace',
    re: /\b(peace|peaceful|calm|calmer|silence|silent|gentle|gently)\b/i,
    footers: [
      '{name}, peace is worth more than being right.',
      '{name}, choose calm over chaos when you can.',
      '{name}, protect your peace, even when it feels inconvenient.',
      '{name}, let the quiet be a place to recover.',
    ],
  },
  {
    key: 'growth',
    re: /\b(grow|grows|growing|growth|learn|learned|learning|lesson|lessons|change|changes|changing|healing|heal|healed|progress|improve|improving)\b/i,
    footers: [
      '{name}, every lesson you keep is a step forward.',
      '{name}, growth can feel slow, but it is still growth.',
      '{name}, change one habit today and keep going.',
      '{name}, healing is progress, even on the messy days.',
    ],
  },
  {
    key: 'money_work',
    re: /\b(money|pay|paid|spend|spent|spending|energy|work|works|working|career|goal|goals|earn|earned|effort|hustle|budget)\b/i,
    footers: [
      '{name}, protect your energy as carefully as your money.',
      '{name}, small steady effort beats big promises you never keep.',
      '{name}, spend your time where your goals actually live.',
      '{name}, work hard, but do not confuse busy with progress.',
    ],
  },
  {
    key: 'time',
    re: /\b(time|patience|patient|season|seasons|tomorrow|wait|waiting|eventually|someday|later|slowly|timing|calendar)\b/i,
    footers: [
      '{name}, patience is part of the plan, not a delay.',
      '{name}, things can change slowly, so keep moving anyway.',
      '{name}, this season will not last forever.',
      '{name}, the right timing has its own calendar.',
    ],
  },
  {
    key: 'celebrate',
    re: /\b(celebrate|celebrating|proud|pride|joy|joyful|happy|happiness|win|wins|laugh|laughing|smile|smiling|cheer)\b/i,
    footers: [
      '{name}, celebrate the small wins today.',
      '{name}, be proud of how far you have come.',
      '{name}, joy is allowed, so let yourself enjoy this.',
      '{name}, share the good news with someone who will cheer for you.',
    ],
  },
  {
    key: 'courage',
    re: /\b(choose|choice|choices|choosing|decide|decision|decisions|courage|brave|fear|afraid|risk)\b/i,
    footers: [
      '{name}, your choices are yours, so make them on purpose.',
      '{name}, courage is doing it scared, one choice at a time.',
      '{name}, decide what you will accept, then act on it.',
      '{name}, fear is not a reason to stay where you are unhappy.',
    ],
  },
];

// Footer lines for the first topic that matches the quote, or null when none does.
function topicFootersFor(quote) {
  const text = String(quote || '');
  for (const topic of TOPICS) {
    if (topic.re.test(text)) return topic.footers;
  }
  return null;
}

// Hand-written footers, one per quote: mias/quote_footers.tsv, lines of "<quote key>\t<footer>".
// The key is the first 12 hex chars of the quote's SHA-1, so a quote edited later simply falls back to topic and theme footers.
const HAND_FILE = path.join(__dirname, '..', 'quote_footers.tsv');
function quoteKey(quote) {
  return crypto.createHash('sha1').update(String(quote), 'utf8').digest('hex').slice(0, 12);
}
function loadHandFooters(file = HAND_FILE) {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const footer = line.slice(tab + 1).trim();
      if (footer) map.set(line.slice(0, tab).trim(), footer);
    }
  } catch {
    // Missing file: every quote uses topic or theme footers.
  }
  return map;
}
const HAND_FOOTERS = loadHandFooters();

// The hand-written footer for a quote as a one-item list, or null when the quote has none yet.
function handFooterFor(quote) {
  const footer = HAND_FOOTERS.get(quoteKey(quote));
  return footer ? [footer] : null;
}

module.exports = { TOPICS, topicFootersFor, handFooterFor, quoteKey, HAND_FOOTERS };
