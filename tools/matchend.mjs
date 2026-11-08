#!/usr/bin/env node
/**
 * matchend — **konec hry** přepsaný proti konci hry originálu.
 *
 * Akceptace M5 (`MILNIKY.md`): když čas vyprší nebo když se mise povede,
 * neskončí hra „nějak" — skončí **tak, jak ji skončí `$83F2` a `$B77C`**
 * (`app/endGame.js`, `sources/docs/disasm_notes.md` §33): rámeček zbělá,
 * obraz se rozklepe, plocha se rozpadne, a na tabuli je skóre spočítané do
 * poslední stovky a síň slávy přerovnaná.
 *
 * ★ **Jednotka není snímek**, protože od `$8401` drží `SEI` a `CLI` už
 * nepřijde (§33). Záznam je proto po **zastávkách** (`tools/traceend.py`)
 * a přepis se pouští po kusech, aby se dal srovnat na každé z nich:
 *
 * | zastávka | co se před ní v přepisu udělá |
 * |---|---|
 * | `$8401` | nic — jen se ověří, že se stroj shoduje na začátku |
 * | `$840E` ×128 | `begin`, pak jedno `shakeRound` na kolo |
 * | `$8452` | nic navíc: poslední kolo třesu už proběhlo |
 * | `$8491` ×128 | `blank`, pak jedno `dissolveRound` na kolo |
 * | `$84B7` | poslední kolo rozpadu |
 * | `$B873` | `finishDissolve`, `frames` a `labels` — **celá obrazovka** |
 * | `$BCE6` | `score` a `insert` — **skóre, síň slávy a rovnice** |
 * | `$BD60` | `enterName` — jméno na obrazovce i v položce |
 * | `$B87C` | nic navíc |
 * | `$B88D` | `prompt` — spodní řádek |
 *
 * ★ **Třes a rozpad jsou to nejsilnější, co tu je.** Kolo třesu si vezme
 * z míchačky **tři** čísla a kolo rozpadu **šestnáct**; sedí-li `$D011`,
 * `$D016` a obrazovka po každém kole, sedí i všech 2 432 volání míchačky
 * a s nimi celý generátor náhody (§8).
 *
 * ★ **A spodní panel se srovnává taky** (od 2026-09-21, M5 část 2). Dlouho
 * tu stálo, že se u záznamů ze šachty deset spodních řádků vynechává, protože
 * je `$83FE JSR $731C` překreslí a přepis to neumí. Není to potřeba: první
 * zastávka je `$8401`, tedy **za** `$731C`, takže co ta rutina nakreslila, je
 * ve výpisu, ze kterého se stroj sází — a rozpad si přes to kreslí z míchačky
 * jako všude jinde. Bez výjimky je kontrol o 154 800 víc a rozdílů dál nula.
 *
 *     ./tools/matchend.mjs [--dir build/end] [--name endroom42] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/end');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const f of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild', 'transition',
                 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom', 'robots', 'orb', 'collision',
                 'death', 'endGame']) {
  loadClassicScript(new URL(`../app/${f}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
const endGame = globalThis.endGame;
const data = JSON.parse(readFileSync(new URL('../data/end.json', import.meta.url), 'utf8'));

/** co si konec hry vede v nulté stránce */
const WATCHED = [
  [0x1A, 'místo'], [0x43, 'smrt'],
  [0x10, 'kreslicí poloha lo'], [0x11, 'kreslicí poloha hi'],
  [0x14, 'barevná poloha lo'], [0x15, 'barevná poloha hi'],
  [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xD6, 'dílky'], [0xD7, 'hesla'], [0xD8, 'skládačky'],
  [0xD9, 'skóre lo'], [0xDA, 'skóre střed'], [0xDB, 'skóre hi'],
  [0xE4, 'pracovní lo'], [0xE5, 'pracovní střed'], [0xE6, 'pracovní hi'],
  [0xE7, 'číslic vytištěno'],
  // ★ **míchačka**: kdyby se rozešla, rozešel by se s ní třes i rozpad,
  // a tohle je jediné místo, kde je to vidět hned
  [0xEB, 'míchačka lo'], [0xEC, 'míchačka hi'],
];
/**
 * A na které registry sahá. Třetí prvek je maska.
 *
 * ★ **Bit 7 `$D011` se nesrovnává, a je to přiznaná díra**: je to `RST8`,
 * tedy **devátý bit rastrového řádku**, který VIC do registru sám plní. Třes
 * si ho čte (`$8415 AND #$F8 / ORA`) a zapisuje zpátky, takže v záznamu nese
 * to, kde byl v tu chvíli rastr — a to je vlastnost stroje, ne hry. Model
 * rastr v téhle jemnosti nekreslí (totéž dělá `matchdeath` s latchem
 * `$D01E`). Zbylých sedm bitů, tedy **svislý posun i 24/25 řádků**, se
 * srovnává celých.
 *
 * ★ A **nepoužité bity se maskují taky**, protože VIC je při čtení vrací jako
 * jedničky: `$D016` má takové dva (bity 6 a 7), `$D018` jeden (bit 0)
 * a barevné registry čtyři. V záznamu je proto `$D8` tam, kde hra napsala
 * `$18`, a `$03` tam, kde napsala `$02` — a kdo by je srovnával celé, měřil
 * by vlastnost čipu.
 */
const VIC = [[0x11, 'rastr svisle', 0x7F], [0x16, 'rastr vodorovně', 0x3F],
             [0x15, 'svítí sprajty', 0xFF], [0x18, 'sada', 0xFE],
             [0x20, 'rámeček', 0x0F], [0x21, 'pozadí 0', 0x0F],
             [0x22, 'pozadí 1', 0x0F], [0x23, 'pozadí 2', 0x0F]];

const SCREEN = 0x4000, SCREEN_BYTES = 0x400, CELLS = 1000;
const FAME = 0xCF00, FAME_BYTES = 0x80;
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).sort();

let checks = 0, diffs = 0, records = 0, stops = 0, rounds = 0, skipped = 0;
let shakeRounds = 0, dissolveRounds = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.trapOf || rec.frames.length < 6) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  const mix = () => entropy;

  // stroj se sází z **první zastávky**, tedy z okamžiku, kdy konec začíná
  const first = rec.frames[0];
  const put = (hexed, atAddr) => {
    const raw = bytes(hexed);
    for (let i = 0; i < raw.length; i++) { m.mem[atAddr + i] = raw[i]; }
  };
  put(first.zp, 0);
  put(first.screen, SCREEN);
  put(first.fame, FAME);
  const firstColor = bytes(first.color);
  for (let i = 0; i < firstColor.length; i++) { m.color[i] = firstColor[i]; }
  const firstVic = bytes(first.vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }

  const inShaft = m.mem[0x1A] === 0;

  // zastávky v záznamu jsou po `trapOf`; k jednomu číslu pasti jich může být
  // víc (kola), tak se berou po řadě
  const seq = rec.trapOf;
  const next = (want, from) => { for (let i = from; i < seq.length; i++) { if (seq[i] === want) { return i; } } return -1; };

  let bad = 0, compared = 0;
  const compare = (stop, label, what) => {
    if (stop < 0 || !rec.frames[stop]) { return; }
    const want = rec.frames[stop];
    const wantZp = bytes(want.zp), wantVic = bytes(want.vic);
    const report = (text, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 4) {
        console.log(`  ${name} ${label}: ${text} přepis $${mine.toString(16)} `
          + `!= originál $${theirs.toString(16)}`);
      }
    };
    if (what.zp) {
      for (const [addr, text] of WATCHED) {
        checks++;
        if (m.mem[addr] !== wantZp[addr]) {
          report(`${text} ($${addr.toString(16)})`, m.mem[addr], wantZp[addr]);
        }
      }
    }
    if (what.vic) {
      for (const [reg, text, mask] of VIC) {
        checks++;
        if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
          report(`${text} ($d0${reg.toString(16).padStart(2, '0')})`,
                 m.vic[reg] & mask, wantVic[reg] & mask);
        }
      }
    }
    if (what.screen) {
      const wantScreen = bytes(want.screen);
      for (let i = 0; i < SCREEN_BYTES; i++) {
        checks++;
        if (m.mem[SCREEN + i] !== wantScreen[i]) {
          report(`obrazovka $${(SCREEN + i).toString(16)}`, m.mem[SCREEN + i], wantScreen[i]);
        }
      }
    }
    if (what.color) {
      const wantColor = bytes(want.color);
      for (let i = 0; i < wantColor.length; i++) {
        checks++;
        if ((m.color[i] & 0x0F) !== (wantColor[i] & 0x0F)) {
          report(`barva $${(0xD800 + i).toString(16)}`, m.color[i] & 0x0F, wantColor[i] & 0x0F);
        }
      }
    }
    if (what.fame) {
      const wantFame = bytes(want.fame);
      for (let i = 0; i < FAME_BYTES; i++) {
        checks++;
        if (m.mem[FAME + i] !== wantFame[i]) {
          report(`síň slávy $${(FAME + i).toString(16)}`, m.mem[FAME + i], wantFame[i]);
        }
      }
    }
    compared++; stops++;
  };

  const ALL = {zp: true, vic: true, screen: true, color: true, fame: true};
  const SHAKE = {zp: true, vic: true};
  const DISSOLVE = {zp: true, vic: true, screen: true};

  // --- zastávka `$8401` -------------------------------------------------
  compare(next(0, 0), 'zastávka $8401', {zp: true, vic: true, fame: true});

  // ★ `begin` — a **věta 5**; co se řeklo, se srovnává s tím, co má
  // `data/speech.json` u pěti jako volajícího (`$8407`)
  let said = [];
  if (!bad) {
    const out = endGame.begin(m);
    if (out.speech !== undefined) { said.push(out.speech); }
    checks++;
    if (out.speech !== data.speech.timeUp) {
      diffs++; bad++;
      console.log(`  ${name}: začátek konce neřekl větu ${data.speech.timeUp}`);
    }
  }

  // --- 128 kol třesu ----------------------------------------------------
  // ★ **Past je na vrcholu smyčky, ne na jejím konci** (`$840E` i `$8491`),
  // takže zastávka ukazuje stav **před** kolem, které se z ní teprve rozjede.
  // Přepis proto srovnává a **pak** kolo udělá; poslední kolo se srovná až na
  // `$8452`, respektive na `$84B7`.
  // ★ `traceend --stops tail` kola nenatáčí (je jich 256 a každé stojí výpis
  // paměti), takže se pak **jen odehrají** a srovná se až to, co po nich
  // zbude. Jinak by měřidlo hlásilo rozdíl tam, kde chybí záznam, ne shoda.
  const tail = rec.stops === 'tail';
  let cursor = -1;
  for (let r = endGame.SHAKE_ROUNDS - 1; r >= 0 && !bad; r--) {
    if (!tail) {
      const stop = next(1, cursor + 1);
      if (stop < 0) { break; }
      cursor = stop;
      compare(stop, `kolo třesu ${endGame.SHAKE_ROUNDS - r}`, SHAKE);
      if (bad) { break; }
    }
    endGame.shakeRound(m, r, mix);
    rounds++; shakeRounds++;
  }
  if (!bad) { compare(next(2, 0), 'zastávka $8452', SHAKE); }

  // --- 128 kol rozpadu --------------------------------------------------
  if (!bad) { endGame.blank(m); }
  cursor = -1;
  for (let r = endGame.DISSOLVE_ROUNDS - 1; r >= 0 && !bad; r--) {
    if (!tail) {
      const stop = next(3, cursor + 1);
      if (stop < 0) { break; }
      cursor = stop;
      compare(stop, `kolo rozpadu ${endGame.DISSOLVE_ROUNDS - r}`, DISSOLVE);
      if (bad) { break; }
    }
    endGame.dissolveRound(m, mix);
    rounds++; dissolveRounds++;
  }
  if (!bad) { compare(next(4, 0), 'zastávka $84B7', DISSOLVE); }

  // --- tabule -----------------------------------------------------------
  if (!bad) {
    endGame.finishDissolve(m);
    endGame.frames(m, data);
    endGame.labels(m, data);
    // ★ `$B868`: konec, který není vypršením času, řekne **větu 0**
    if (m.mem[0xD4] !== endGame.LAST_HOUR) { said.push(endGame.WORD_GAME_OVER); }
    compare(next(5, 0), 'zastávka $B873', ALL);
  }

  // --- skóre a síň slávy ------------------------------------------------
  let slot = -1;
  if (!bad) {
    endGame.score(m, data);
    slot = endGame.insert(m);
    if (slot === 0 && (m.mem[0xD9] | m.mem[0xDA] | m.mem[0xDB])) {
      endGame.surpass(m, data);
    }
    endGame.fameList(m);
    const stop = next(6, 0);
    if (stop >= 0) {
      compare(stop, 'zastávka $BCE6', ALL);
    } else {
      // ★ skóre se do tabulky nevešlo, takže se jméno nezadává a `$BCE6` se
      // neozvalo; tabule je hotová a srovná se na `$B87C`
      compare(next(8, 0), 'zastávka $B87C', ALL);
    }
  }

  // --- jméno ------------------------------------------------------------
  if (!bad && next(7, 0) >= 0) {
    const keys = (rec.keys || []).map((x) => parseInt(x, 16));
    endGame.enterName(m, data, slot, keys);
    compare(next(7, 0), 'zastávka $BD60', ALL);
    compare(next(8, 0), 'zastávka $B87C', ALL);
  }

  // --- spodní řádek -----------------------------------------------------
  if (!bad) {
    endGame.prompt(m, data);
    compare(next(9, 0), 'zastávka $B88D', ALL);
  }

  const score = `${m.mem[0xDB].toString(16).padStart(2, '0')}`
    + `${m.mem[0xDA].toString(16).padStart(2, '0')}`
    + `${m.mem[0xD9].toString(16).padStart(2, '0')}`;
  console.log(`  ${name}: ${compared} z ${rec.frames.length} zastávek, `
    + `${inShaft ? 'šachta' : 'místnost'}, skóre ${score}, věty [${said}]`
    + (slot >= 0 && slot < endGame.FAME_SHOWN ? `, síň slávy ${slot}` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchend: ${records} záznamů, ${stops} zastávek `
  + `(${shakeRounds} kol třesu, ${dissolveRounds} kol rozpadu), `
  + `${checks} kontrol, ${diffs} rozdílů`
  + (skipped ? `, ${skipped} vynechaných buněk` : ''));
process.exit(diffs ? 1 : 0);
