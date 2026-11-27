'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const EM = require('../lib/editMatch.cjs');
const PAE = require('../precious-anime-edits.cjs');

test('Creator Character-only edits correctly match their franchise', () => {
  const categories = PAE.CATEGORIES;

  // 1. Rayto / Naruto creator character-only edits
  const raytoKakashi = { caption: 'Coldest shinobi in the mist #kakashi #animeedit #4k' };
  const raytoObito = { caption: 'I am in hell #obito #anime #viral' };
  const raytoMadara = { caption: 'Wake up to reality #madara #uchihamadara #edits' };
  const raytoSasuke = { caption: 'I have long since closed my eyes #sasuke #sasukeuchiha' };

  assert.equal(PAE.matchesCat(raytoKakashi, categories.naruto), true, 'Kakashi should match naruto');
  assert.equal(PAE.matchesCat(raytoObito, categories.naruto), true, 'Obito should match naruto');
  assert.equal(PAE.matchesCat(raytoMadara, categories.naruto), true, 'Madara should match naruto');
  assert.equal(PAE.matchesCat(raytoSasuke, categories.naruto), true, 'Sasuke should match naruto');

  // Should NOT leak into other categories
  assert.equal(PAE.matchesCat(raytoKakashi, categories.jjk), false, 'Kakashi must not match jjk');
  assert.equal(PAE.matchesCat(raytoObito, categories.bleach), false, 'Obito must not match bleach');
  assert.equal(PAE.matchesCat(raytoMadara, categories.onepiece), false, 'Madara must not match onepiece');

  // 2. JJK character-only edits (Gojo, Sukuna, Toji)
  const gojoEdit = { caption: 'Throughout heaven and earth #gojo #satorugojo #4kedit' };
  const tojiEdit = { caption: 'The sorcerer killer #toji #tojifushiguro #amv' };
  const sukunaEdit = { caption: 'Enchain #sukuna #ryomensukuna #anime' };

  assert.equal(PAE.matchesCat(gojoEdit, categories.jjk), true, 'Gojo should match jjk');
  assert.equal(PAE.matchesCat(tojiEdit, categories.jjk), true, 'Toji should match jjk');
  assert.equal(PAE.matchesCat(sukunaEdit, categories.jjk), true, 'Sukuna should match jjk');

  assert.equal(PAE.matchesCat(gojoEdit, categories.naruto), false, 'Gojo must not match naruto');
  assert.equal(PAE.matchesCat(tojiEdit, categories.demonslayer), false, 'Toji must not match demonslayer');

  // 3. Demon Slayer character-only edits
  const rengokuEdit = { caption: 'Set your heart ablaze #rengoku #flamehashira #edit' };
  const tanjiroEdit = { caption: 'Hinokami Kagura #tanjiro #tanjirokamado' };
  const muzanEdit = { caption: 'Smooth criminal #muzan #kibutsuji' };

  assert.equal(PAE.matchesCat(rengokuEdit, categories.demonslayer), true, 'Rengoku should match demonslayer');
  assert.equal(PAE.matchesCat(tanjiroEdit, categories.demonslayer), true, 'Tanjiro should match demonslayer');
  assert.equal(PAE.matchesCat(muzanEdit, categories.demonslayer), true, 'Muzan should match demonslayer');
  assert.equal(PAE.matchesCat(rengokuEdit, categories.bleach), false, 'Rengoku must not match bleach');

  // 4. One Piece character-only edits
  const luffyGear5 = { caption: 'Drums of liberation #luffy #gear5 #sunjoyboy' };
  const zoroEdit = { caption: 'Nothing happened #zoro #roronoazoro #anime' };

  assert.equal(PAE.matchesCat(luffyGear5, categories.onepiece), true, 'Gear 5 Luffy should match onepiece');
  assert.equal(PAE.matchesCat(zoroEdit, categories.onepiece), true, 'Zoro should match onepiece');
  assert.equal(PAE.matchesCat(luffyGear5, categories.dragonball), false, 'Luffy must not match dragonball');

  // 5. Attack on Titan character-only edits
  const leviEdit = { caption: 'Humanity strongest soldier #levi #leviackerman #amv' };
  const erenEdit = { caption: 'Tatakae #eren #erenyeager #4k' };

  assert.equal(PAE.matchesCat(leviEdit, categories.aot), true, 'Levi should match aot');
  assert.equal(PAE.matchesCat(erenEdit, categories.aot), true, 'Eren should match aot');
  assert.equal(PAE.matchesCat(leviEdit, categories.naruto), false, 'Levi must not match naruto');

  // 6. Bleach character-only edits
  const aizenEdit = { caption: 'Since when were you under the impression #aizen #sosukeaizen' };
  const ichigoEdit = { caption: 'Getsuga Tenshou #ichigo #ichigokurosaki #bankai' };

  assert.equal(PAE.matchesCat(aizenEdit, categories.bleach), true, 'Aizen should match bleach');
  assert.equal(PAE.matchesCat(ichigoEdit, categories.bleach), true, 'Ichigo should match bleach');
  assert.equal(PAE.matchesCat(aizenEdit, categories.jjk), false, 'Aizen must not match jjk');

  // 7. Solo Leveling character-only edits
  const jinwooEdit = { caption: 'Arise #sungjinwoo #shadowmonarch #4k' };
  assert.equal(PAE.matchesCat(jinwooEdit, categories.sololeveling), true, 'Sung Jinwoo should match sololeveling');
  assert.equal(PAE.matchesCat(jinwooEdit, categories.bleach), false, 'Sung Jinwoo must not match bleach');

  // 8. Blue Lock character-only edits
  const isagiEdit = { caption: 'I will devour you #isagi #isagiyoichi #bllk' };
  assert.equal(PAE.matchesCat(isagiEdit, categories.bluelock), true, 'Isagi should match bluelock');
  assert.equal(PAE.matchesCat(isagiEdit, categories.cote), false, 'Isagi must not match cote');

  // 9. Classroom of the Elite character-only edits
  const ayanokojiEdit = { caption: 'All people are nothing but tools #ayanokoji #kiyotaka' };
  assert.equal(PAE.matchesCat(ayanokojiEdit, categories.cote), true, 'Ayanokoji should match cote');
  assert.equal(PAE.matchesCat(ayanokojiEdit, categories.naruto), false, 'Ayanokoji must not match naruto');
});

test('Cross-franchise crossover protection prevents contamination', () => {
  const categories = PAE.CATEGORIES;

  // A "Big 3" compilation video featuring Luffy, Naruto, Goku
  const big3Video = { caption: 'The legendary Big 3 anime #luffy #naruto #goku #animeedits' };

  // Should match One Piece, Naruto, Dragon Ball
  assert.equal(PAE.matchesCat(big3Video, categories.onepiece), true, 'Matches onepiece');
  assert.equal(PAE.matchesCat(big3Video, categories.naruto), true, 'Matches naruto');
  assert.equal(PAE.matchesCat(big3Video, categories.dragonball), true, 'Matches dragonball');

  // MUST NOT leak into Bleach, JJK, Demon Slayer, or AOT
  assert.equal(PAE.matchesCat(big3Video, categories.bleach), false, 'Big 3 without Ichigo/Bleach must not match bleach');
  assert.equal(PAE.matchesCat(big3Video, categories.jjk), false, 'Big 3 must not match jjk');
  assert.equal(PAE.matchesCat(big3Video, categories.demonslayer), false, 'Big 3 must not match demonslayer');
  assert.equal(PAE.matchesCat(big3Video, categories.aot), false, 'Big 3 must not match aot');
});

test('Generic english words and removed junk tags do not trigger false matches', () => {
  const categories = PAE.CATEGORIES;

  // Words that were previously in bloated tag lists and caused bugs
  const randomLaw = { caption: 'Breaking the law #law #crime #documentary' };
  const randomAce = { caption: 'Got an ace in valorant #ace #clutch #gaming' };
  const randomRam = { caption: 'Upgraded to 32gb ram #ram #pc #setup' };
  const randomAqua = { caption: 'Aqua blue sea water vibes #aqua #ocean #nature' };
  const randomRuby = { caption: 'Ruby gemstone unboxing #ruby #jewelry' };
  const randomScout = { caption: 'Scouts camping in the forest #scouts #camping' };

  assert.equal(PAE.matchesCat(randomLaw, categories.onepiece), false, 'General law must not match onepiece');
  assert.equal(PAE.matchesCat(randomAce, categories.onepiece), false, 'General ace must not match onepiece');
  assert.equal(PAE.matchesCat(randomRam, categories.rezero), false, 'Computer RAM must not match rezero');
  assert.equal(PAE.matchesCat(randomAqua, categories.oshinoko), false, 'Aqua color must not match oshinoko');
  assert.equal(PAE.matchesCat(randomRuby, categories.oshinoko), false, 'Ruby gemstone must not match oshinoko');
  assert.equal(PAE.matchesCat(randomScout, categories.aot), false, 'Camping scouts must not match aot');
});

test('Archive items match their designated category and avoid crossovers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const categories = PAE.CATEGORIES;

  function sampleLines(fileName, maxLines = 15) {
    const p = path.join(__dirname, '../../edits', fileName);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(l => l.includes('tiktok.com'))
      .slice(0, maxLines)
      .map(line => {
        const parts = line.split('\t');
        return {
          url: (line.match(/https?:\/\/[^\s]*tiktok\.com[^\s]*/i) || [])[0],
          caption: parts[3] || '',
          hashtags: parts[4] || '',
        };
      })
      .filter(i => i.caption || i.hashtags);
  }

  const narutoSamples = sampleLines('naruto_boruto.txt');
  const knySamples = sampleLines('demon_slayer.txt');
  const jjkSamples = sampleLines('jjk.txt');

  let narutoMatches = 0;
  for (const item of narutoSamples) {
    if (PAE.matchesCat(item, categories.naruto)) narutoMatches++;
    // Shouldn't cross match to unrelated
    assert.equal(PAE.matchesCat(item, categories.demonslayer), false, 'Naruto item should not match demon slayer');
  }
  assert.ok(narutoMatches > 0, 'Should match real Naruto items');

  let knyMatches = 0;
  for (const item of knySamples) {
    if (PAE.matchesCat(item, categories.demonslayer)) knyMatches++;
    assert.equal(PAE.matchesCat(item, categories.naruto), false, 'Demon slayer item should not match naruto');
  }
  assert.ok(knyMatches > 0, 'Should match real KNY items');

  let jjkMatches = 0;
  for (const item of jjkSamples) {
    if (PAE.matchesCat(item, categories.jjk)) jjkMatches++;
    assert.equal(PAE.matchesCat(item, categories.demonslayer), false, 'JJK item should not match demon slayer');
  }
  assert.ok(jjkMatches > 0, 'Should match real JJK items');
});

test('Chainsaw Man and Tokyo Revengers unique franchise matching', () => {
  const categories = PAE.CATEGORIES;

  const denjiEdit = { caption: 'Bark for me #denji #makima #chainsawman #csm' };
  const mikeyEdit = { caption: 'Invincible Mikey #mikey #manjirosano #tokyorevengers #toman' };

  assert.equal(PAE.matchesCat(denjiEdit, categories.chainsawman), true, 'Denji should match chainsawman');
  assert.equal(PAE.matchesCat(mikeyEdit, categories.tokyorevengers), true, 'Mikey should match tokyorevengers');

  // No crossover
  assert.equal(PAE.matchesCat(denjiEdit, categories.tokyorevengers), false, 'Denji must not match tokyorevengers');
  assert.equal(PAE.matchesCat(mikeyEdit, categories.chainsawman), false, 'Mikey must not match chainsawman');
  assert.equal(PAE.matchesCat(denjiEdit, categories.naruto), false, 'Denji must not match naruto');
  assert.equal(PAE.matchesCat(mikeyEdit, categories.jjk), false, 'Mikey must not match jjk');
});

test('Free Fire captions have hashtags stripped cleanly', () => {
  const rawCaption = 'Chalre Chalre Waal✨ Lone Wolf #freefire #foryou #viral #trending';
  const cleanCaption = rawCaption.replace(/#[a-zA-Z0-9_]+/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(cleanCaption.includes('#'), false, 'Cleaned caption must not have any hashtags');
  assert.equal(cleanCaption, 'Chalre Chalre Waal✨ Lone Wolf');
});
