#!/usr/bin/env node
/**
 * Přehraje záznam **vzorků řeči z běžícího originálu**
 * (`tools/tracesound.py --speech` → `build/sound/word*.json.gz`) proti
 * přepisu `app/speech.js` a porovná **vzorek po vzorku a fázi po fázi**
 * (M6, `sources/docs/disasm_notes.md` §32).
 *
 *   ./tools/matchsound.mjs [--verbose] [soubor.json.gz …]
 *
 * Co se srovnává:
 * - **hodnota**, kterou ovladač `$0880` dává do `$D418` (čtyři bity
 *   hlasitosti SID), a **fáze**, ze které ji dal (`A` rámec dopředu,
 *   `B` pozpátku, `C` ticho náběhu, `D` fáze, která **nepíše nic**,
 *   `E` poslední `$07`)
 * - **bloky**: jeden blok = jedno doplnění (`$08F2`), tedy `A`+`B`+pauza
 *   nebo jen pauza. Bloků musí být stejně a musí jít za sebou — tím se
 *   ukáže, že se stavový automat **po každém doplnění srovná**, i když se
 *   uvnitř bloku liší.
 *
 * ★ **Proč tu vůbec rozdíly jsou.** Ovladač je re-entrantní: doplnění trvá
 * déle než 101 cyklů, NMI se na 6502 nemaskuje, a jestli se přerušení
 * zanoří do úzkého okna uvnitř doplnění, rozhodují **cykly, které
 * procesoru sebere VIC-II** — špatný řádek stojí 40 až 43 cyklů a sprajty
 * další. Model videočip nemá (a mít ho znamená psát cyklově přesný C64),
 * takže se ty rozdíly **nehádají, ale dokládají**: nástroj u každého
 * hledá **jedno zdržení 1 až 70 cyklů** na hranici instrukce kolem bloku,
 * a když ho najde, přepis od něj dál reprodukuje záznam přesně. Nalezené
 * hodnoty vycházejí 41 a 43 — tedy přesně špatný řádek.
 *
 * Rozdíl je **vysvětlený**, když je to **jeden vzorek navíc v jedné fázi
 * bloku** a další blok už zase sedí; `--strict` žádá navíc, aby se ke
 * každému našlo i to zdržení.
 *
 * ## A druhá polovina: **efekty**
 *
 * `--effects` přehraje záznam hry se zápisy do SID
 * (`tools/traceplayer.py --sid` → `build/sound/*.json`) proti `app/sound.js`
 * a srovná **zápis po zápisu v pořadí, snímek po snímku**: které registry,
 * jaké hodnoty a v jakém pořadí. Je to týž tvar, jaký má POKEY u Boulder
 * Dashe (R-040) — hra zvuk **nepřehrává**, ona ho **zapisuje**, a doložit
 * se dá právě ten zápis.
 *
 * ★ **Čtyři věci, na které se přišlo teprve tímhle měřením** (2026-09-21,
 * do té doby hlásilo tisíce rozdílů):
 *
 * 1. **`$9220` nemá `RTS` — propadá do `$9244`.** Mezi nimi je jen
 *    `$9242 INC $4A`, takže každý jedoucí robot zapíše hlas 2 **a hned za
 *    ním hlas 1**. Snímek s dvěma jedoucími roboty má proto pět skupin
 *    zápisů (`$9244` jednou z `$8EEA` a pak dvojice), ne tři.
 * 2. **Pořadí v snímku je opačné, než v jakém to model dělá.** Přerušení
 *    hry je na rastru `$FF`, tedy na konci snímku, a hlavní smyčka běží
 *    před ním; `plFrame` dělá obsluhu první. Srovnává to `SND_IRQ_LINE`
 *    a řazení v `sndTake` (`app/sound.js`).
 * 3. **Obřad umírání krájený na snímky neuměl ztišit.** `dhDie` `$95EC`
 *    i `$965B` má, `dhStart`/`dhFrame` je neměly — a ve hře běží ty druhé.
 * 4. **Ukazatele sprajtů se do stroje sázely o bajt vedle**: záznam
 *    s roboty má `ptr` od `$43F8`, ne od `$43F9`. Adresa se teď bere
 *    ze záznamu.
 *
 * ★ **A dvě přiznané meze**: za **koncem obřadu** se přestává měřit — na
 * stroji obřad **nestojí ani jeden snímek** (drží `SEI`, takže `$8361`
 * netiká), v modelu stojí 33, takže se od jeho konce snímky záznamu
 * a snímky přepisu rozejdou a s nimi míchačka `$84EA`; obřad sám se
 * porovná celý. A na **páce výtahu** taky: jízda šachtou **není snímek,
 * je to krok** (§20), měří ji `tools/matchelevator.mjs` — takže `$85B3`
 * je jediná rutina zvuku, na kterou tohle měřidlo nedosáhne.
 *
 * ## Jak se záznamy natočí
 *
 *   xvfb-run -a ./tools/traceplayer.py --sid --robots --dir build/sound \
 *     --name sidwalk    --entropy 42 --lead 'right:200' --script 'right:200'
 *   … --name sidroom07  --entropy 07 --lead 'right:200' --script 'right:150'
 *   … --name sidshaft42 --entropy 42 --script 'right:30,left:30,fire:3,idle:40'
 *   … --name sidjump99  --entropy 99 --lead 'right:200' \
 *                       --script 'right:20,fire:3,idle:100'
 *
 * ★ Je to **místnost s roboty a smrtí**, **druhá místnost na jiném
 * semínku**, **šachta s chůzí a saltem** a **šachta s bouchnutím do
 * stropu** — u semínka `99` vedle kabiny žádná místnost není, takže
 * `--lead right:200` skončí zase v šachtě.
 */
import '../app/svision/tools/nodeEnv.mjs';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const strict = args.includes('--strict');
const given = args.filter((a) => !a.startsWith('--'));
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');
const Speech = loadClassicScript(path.join(ROOT, 'app/speech.js'));
const speechData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/speech.json'), 'utf8'));

/** how far a stall has to carry the model before it counts as the cause */
const HORIZON = 250, PROVEN = 200;
/** a bad line on a PAL C64 is about this many cycles */
const STALL_MAX = 70;

/**
 * The records to play: what was given on the command line, or every
 * sentence in `build/sound`.
 * @returns {Array<string>} Paths.
 */
function records() {
  if (given.length) {
    return given;
  }
  const dir = path.join(ROOT, 'build/sound');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter((f) => /^word\d+\.json\.gz$/.test(f))
    .sort().map((f) => path.join(dir, f));
}

/**
 * The blocks of a stream of samples: one block is one refill of the
 * player, so it starts where a phase `A` follows something else, where a
 * `C` follows the pad of the block before, or at the closing `E`.
 * @param {string} tags - The phases, one letter a sample.
 * @param {Array|Uint8Array} values - The samples.
 * @returns {Array<{at: number, tags: string, values: Array<number>}>}
 */
function blocksOf(tags, values) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= tags.length; i++) {
    const here = tags[i], before = tags[i-1];
    const starts = i < tags.length
      && ((here === 'A' && before !== 'A')
        || (here === 'C' && (before === 'D' || before === 'C'))
        || here === 'E');
    if (starts || i === tags.length) {
      out.push({at: start, tags: tags.slice(start, i), values: Array.from(values.slice(start, i))});
      start = i;
    }
  }
  return out;
}

/** the model's samples as the recording writes them: `$80` where a phase writes nothing */
function samplesOf(run) {
  return run.out.map((o) => (o.value === null ? 0x80 : o.value));
}

/** the first place two streams part company, or -1 */
function partsAt(record, run, values) {
  const n = Math.min(record.samples.length, values.length);
  for (let i = 0; i < n; i++) {
    if (record.samples[i] !== values[i] || record.phases[i] !== run.out[i].tag) {
      return i;
    }
  }
  return (record.samples.length === values.length) ? -1 : n;
}

/**
 * Looks for the one stall — the cycles the VIC-II took — that makes the
 * model reproduce the recording from `at` onwards.
 * @param {Object} record - The recording.
 * @param {number} word - Which sentence.
 * @param {Object} stalls - The stalls found so far.
 * @param {number} at - Where the streams parted.
 * @param {Object} run - The run that parted there.
 * @returns {?{sample: number, cycles: number}}
 */
function findStall(record, word, stalls, at, run) {
  const refill = run.out[at].refill;
  let block = at;
  while (block > 0 && run.out[block-1].refill === refill) {
    block--;
  }
  const keys = [];
  for (let k = block-4; k <= block+2; k++) {
    if (k >= 0) { keys.push(k); }
  }
  for (let k = Math.max(0, at-3); k <= at; k++) {
    if (!keys.includes(k)) { keys.push(k); }
  }
  const want = Math.min(at+PROVEN, record.samples.length);
  for (const key of keys) {
    for (let cycles = 1; cycles <= STALL_MAX; cycles++) {
      const trial = Object.assign({}, stalls);
      trial[key] = cycles;
      const other = Speech.speechSentence(speechData, word, {stall: trial, until: at+HORIZON});
      if (partsAt(record, other, samplesOf(other)) >= want) {
        return {sample: key, cycles: cycles};
      }
    }
  }
  return null;
}

let words = 0, samples = 0, checks = 0, blocks = 0, differences = 0, unexplained = 0, proven = 0;
let effectRecords = 0, effectFrames = 0, effectWrites = 0;

/**
 * The effects: a recorded run of the game replayed through `app/player.js`,
 * with the writes `app/sound.js` makes compared to the ones the original
 * made, in order, frame by frame.
 * @returns {number} Differences.
 */
function effects() {
  const dir = path.join(ROOT, 'build/sound');
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).sort() : [];
  let bad = 0;
  for (const file of names) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!rec.sid || !rec.frames) {
      continue;
    }
    effectRecords++;
    const base = path.join(dir, file.replace(/\.json$/, ''));
    const m = {mem: new Uint8Array(fs.readFileSync(base+'_ram.bin')),
               color: new Uint8Array(fs.readFileSync(base+'_color.bin')),
               vic: new Uint8Array(fs.readFileSync(base+'_vic.bin').subarray(0, 0x2F))};
    const entropy = parseInt(rec.entropy, 16);
    m.entropy = () => entropy;
    m.noRobots = !rec.robots;
    const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
    let begin = 0;
    while (begin+1 < rec.frames.length && hex(rec.frames[begin].harness)[0x13] !== 1) {
      begin++;
    }
    const first = hex(rec.frames[begin].zp);
    for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
    // ★ **Kam ukazatele sprajtů patří, říká záznam** — bez robotů je to
    // `$43F9`-`$43FB`, s nimi `$43F8`-`$43FF`, protože v `$43F8` je koule
    // (`tools/traceplayer.py`, `DUMPS` a `DUMPS_ROBOTS`). Natvrdo `$43F9`
    // posunulo celou osmici o bajt, takže robot dostal cizí ukazatel
    // a jeho krok po plošinách skončil na mezi o snímky dřív — a poznalo
    // se to teprve na zvuku, protože `matchrobots` čte adresu ze záznamu.
    const ptrAt = parseInt((rec.dumps.find((d) => d.name === 'ptr') || {}).from.slice(1), 16);
    const ptr = hex(rec.frames[begin].ptr);
    for (let i = 0; i < ptr.length; i++) { m.mem[ptrAt+i] = ptr[i]; }
    globalThis.collision.reset(m);
    const stick = [];
    for (const seg of rec.segments) {
      for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
    }
    let differing = 0, last = begin, stopped = '', frames = 0;
    const mine = [];
    for (let f = begin; f+1 < rec.frames.length; f++) {
      const passes = hex(rec.frames[f+1].harness)[0x13];
      let step = globalThis.player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
      // ★ `step.lift` — **jízda výtahem v šachtě běží mimo hlavní smyčku**
      // (`$3A85`, `$3AA4`), takže v ní harness napočítá nula průchodů a je
      // to v pořádku, ne přetečení snímku (§20). Do 2026-09-21 se tu jízda
      // přestávala měřit úplně — a byla to jediná rutina zvuku, kterou
      // nikdo neměřil, takže se v ní schovala chyba (viz `plRide`).
      if (passes !== 1 && !step.moving && !step.riding && !step.searching
          && !step.lift) {
        break;                                                         // §19, stejně jako matchplayer
      }
      if ((step.transition && !step.moving) || step.searched || step.computer) {
        break;
      }
      for (const w of globalThis.sndTake(m)) { mine.push([w[1], w[2]]); }
      effectFrames++; frames++;
      last = f+1;
      // ★ **Za obřadem se přestává měřit** — stejně, jako to dělá
      // `matchrobots` (§31). Obřad samotný se porovná celý, protože jeho
      // zápisy leží v jedné posloupnosti.
      // ★ A **obřad nesmí utrácet snímky záznamu**: na stroji drží `SEI`,
      // takže `$8361` netiká a celý obřad padne **do jediného snímku**
      // záznamu. Model ho krájí na 123 (jednotka je zdržení `$9787`, §31),
      // a kdyby si za každý z nich vzal snímek záznamu, dojde mu záznam
      // dřív, než doblikal — a chybí mu půlka zápisů (stalo se 2026-09-21,
      // když se krájení opravovalo z 33 snímků na 123). Dotočí se proto
      // **na místě**.
      if (step.dying) {
        for (let guard = 0; guard < 400 && step.dying !== 2; guard++) {
          step = globalThis.player.frame(m, stick[f] === undefined ? 0x7F : stick[f],
                                         passes);
          for (const w of globalThis.sndTake(m)) { mine.push([w[1], w[2]]); }
        }
        stopped = 'obřad';
        break;
      }
    }
    // ★ Srovnává se **jedna posloupnost v pořadí**, ne po snímcích, a je to
    // záměr: hranice snímku v záznamu je zásah na `$8361`, tedy uprostřed
    // obsluhy přerušení, takže zápis hlavní smyčky padne do jiného bloku
    // než zápis obsluhy téhož snímku. Pořadí a hodnoty to neruší — a přesně
    // tak to měří i POKEY u Boulder Dashe (R-040).
    const want = [];
    for (let f = begin; f <= last; f++) {
      for (const w of (rec.sid[f] || [])) { want.push(w); }
    }
    // ★ Záznam začíná uprostřed snímku (hranice je zásah na `$8361`), takže
    // na jeho začátku visí zápisy hlavní smyčky snímku **před** tím, ze
    // kterého se vychází. Kolik jich je, se nehádá — hledá se posun, při
    // kterém posloupnosti sednou.
    // ★ A **jeden zápis na shodu nestačí**: `$D418 = $05` píše krok agenta
    // v každém snímku, takže se první zápis přepisu potká hned s prvním
    // zápisem záznamu a posun by vyšel nula. Bere se proto ten posun,
    // který sedne **nejdelším úsekem**.
    let shift = 0, best = -1;
    for (let k = 0; k < 80 && k < want.length; k++) {
      let run = 0;
      while (run < mine.length && k+run < want.length
             && want[k+run][0] === mine[run][0] && want[k+run][1] === mine[run][1]) {
        run++;
      }
      if (run > best) { best = run; shift = k; }
    }
    want.splice(0, shift);
    // ★ Zastavil-li se přepis na konci obřadu, uřízne se i záznam — jeho
    // zbytek patří snímkům, které už proti sobě nestojí (viz smyčka výš).
    let tail = 0;
    if (stopped && want.length > mine.length) {
      tail = want.length-mine.length;
      want.length = mine.length;
    }
    // ★ A na konci záznamu totéž z druhé strany: posun na začátku znamená,
    // že přepis dojde o ten kus dál, než kam záznam sahá.
    if (mine.length > want.length) {
      tail = mine.length-want.length;
      mine.length = want.length;
    }
    effectWrites += want.length;
    checks += Math.max(want.length, mine.length)*2;
    const show = (w) => (w ? '$D4'+w[0].toString(16).padStart(2, '0')+'=$'+w[1].toString(16) : '—');
    for (let i = 0; i < Math.max(want.length, mine.length); i++) {
      const a = want[i], b = mine[i];
      if (a && b && a[0] === b[0] && a[1] === b[1]) {
        continue;
      }
      differing++; bad++;
      if (verbose || differing <= 5) {
        console.log(`  ROZDÍL ${rec.name} zápis ${i}: záznam ${show(a)}, přepis ${show(b)}`);
      }
    }
    console.log(`  ${rec.name}: ${frames} snímků, ${want.length} zápisů v záznamu, `
      + `${mine.length} v přepisu, ${differing} rozdílů`
      + (stopped ? ` (zastaveno na konci: ${stopped}; ${tail} zápisů záznamu dál se neměří)` : ''));
  }
  return bad;
}


if (args.includes('--effects')) {
  globalThis.self = globalThis;
  loadClassicScript(path.join(ROOT, 'app/svision/js/platform/canvas2D/c64/c64Collision.js'));
  for (const f of ['fortressGen', 'fortressMap', 'roomBuild', 'roomsLoader', 'elevator',
                   'shaftBuild', 'transition', 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom',
                   'robots', 'orb', 'collision', 'death', 'sound', 'speech']) {
    loadClassicScript(path.join(ROOT, 'app/'+f+'.js'));
  }
  globalThis.player = loadClassicScript(path.join(ROOT, 'app/player.js'));
  const bad = effects();
  console.log(`matchsound --effects: ${effectRecords} záznamů, ${effectFrames} snímků, `
    + `${effectWrites} zápisů do SID, ${checks} kontrol, ${bad} rozdílů`);
  process.exit(bad);
}

for (const file of records()) {
  const record = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const word = record.word;
  words++;
  // the stalls that were found: each one is a bad line the model has no chip for
  const stalls = {};
  const found = [];
  for (let round = 0; round < 32; round++) {
    const run = Speech.speechSentence(speechData, word, {stall: stalls});
    const at = partsAt(record, run, samplesOf(run));
    if (at < 0) {
      break;
    }
    const stall = findStall(record, word, stalls, at, run);
    if (!stall) {
      break;
    }
    stalls[stall.sample] = stall.cycles;
    found.push(stall);
  }
  const run = Speech.speechSentence(speechData, word, {stall: stalls});
  const values = samplesOf(run);
  const tags = run.out.map((o) => o.tag).join('');
  const mine = blocksOf(tags, values);
  const theirs = blocksOf(record.phases, record.samples);
  samples += record.samples.length;
  checks += record.samples.length*2;               // the value and the phase of each
  blocks += theirs.length;
  if (mine.length !== theirs.length) {
    unexplained++;
    console.log(`  ROZDÍL věta ${word}: bloků ${theirs.length} v záznamu, ${mine.length} v přepisu`);
    continue;
  }
  let differing = 0, odd = 0;
  for (let i = 0; i < theirs.length; i++) {
    const a = theirs[i], b = mine[i];
    if (a.tags === b.tags && a.values.length === b.values.length
        && a.values.every((v, k) => v === b.values[k])) {
      continue;
    }
    differing++;
    // ★ explained: the block has **one phase one sample longer** and
    // nothing else — a single interrupt nested in the refill, which is the
    // only shape §32 allows
    const runs = (s) => (s.match(/(.)\1*/g) || []).map((r) => [r[0], r.length]);
    const ra = runs(a.tags), rb = runs(b.tags);
    let oneMore = ra.length === rb.length && a.values.length === b.values.length+1;
    let stretched = 0;
    for (let k = 0; oneMore && k < ra.length; k++) {
      if (ra[k][0] !== rb[k][0]) { oneMore = false; break; }
      if (ra[k][1] === rb[k][1]) { continue; }
      if (ra[k][1] === rb[k][1]+1 && stretched === 0) { stretched = 1; continue; }
      oneMore = false;
    }
    oneMore = oneMore && stretched === 1;
    if (!oneMore) {
      odd++;
      console.log(`  ROZDÍL věta ${word} blok ${i}: záznam ${a.tags.length} vzorků, přepis ${b.values.length}`);
    } else if (verbose) {
      console.log(`  vysvětleno věta ${word} blok ${i}: jeden vzorek navíc v jedné fázi`);
    }
  }
  differences += differing;
  unexplained += odd;
  proven += found.length;
  if (strict && found.length < differing) {
    unexplained += differing-found.length;
    console.log(`  ROZDÍL věta ${word}: ${differing} rozdílů, zdržení doložené jen u ${found.length}`);
  }
  console.log(`  věta ${word}: ${record.samples.length} vzorků, ${theirs.length} bloků, `
    + `${differing} lišících se, ${found.length} doložených zdržením`
    + (found.length ? ' ('+found.map((f) => f.cycles+' cyklů').join(', ')+')' : ''));
}

console.log(`matchsound: ${words} vět, ${blocks} bloků, ${samples} vzorků, ${checks} kontrol, `
  + `${differences} rozdílů (${proven} doložených zdržením VIC-II), ${unexplained} nevysvětlených`);
process.exit(unexplained);
