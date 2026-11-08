#!/usr/bin/env node
/**
 * matchdeath — **umírání** přepsané proti umírání originálu.
 *
 * Akceptace M4 (`MILNIKY.md`): po smrti se hra nevrátí „nějak", vrátí se
 * **tak, jak ji vrátí `$95DA`** (`app/death.js`,
 * `sources/docs/disasm_notes.md` §31): agent se rozpustí, výtahy místnosti
 * se vrátí na začátek, roboti a koule se postaví ze záznamu, agent na
 * vstupní pozici — a hodiny jsou o **deset minut** dál.
 *
 * ★ **Jednotka není snímek**, protože v obřadu drží `SEI` (§31). Záznam je
 * proto po **zastávkách** (`tools/tracedeath.py`) a přepis se pouští po
 * kusech, aby se dal srovnat na každé z nich:
 *
 * | zastávka | co se před ní v přepisu udělá |
 * |---|---|
 * | `$95E8` | nic — jen se ověří, že se stroj shoduje na začátku |
 * | `$9643` ×33 | `copyBlocks` + `flashIntro`, pak jedno `roundBytes` na kolo |
 * | `$966C` | `flash`, `clearBlocks`, u smrti ve výtahu i `eraseLiftColumn` |
 * | `$96F5` | `rebuild` — a tady se srovnává **všechno** |
 * | `$9707` | `resume`; ★ za `CLI` už do stavu sahá přerušení, takže se z něj srovnává jen to, co udělá `$96F6`-`$9703` |
 *
 * ★ Že rozpouštění sedí **po každém kole**, je silnější důkaz, než jak
 * vypadá: v jednom kole se míchačka zeptá **295krát** (49 bajtů × 3 bloky
 * × 2 čísla, plus jedno bliknutí), takže shoda 192 bajtů bloků po kole
 * znamená shodu všech 295 volání.
 *
 *     ./tools/matchdeath.mjs [--dir build/death] [--name deathrobot42] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/death');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const f of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild', 'transition',
                 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom', 'robots', 'orb', 'collision',
                 'death']) {
  loadClassicScript(new URL(`../app/${f}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
const death = globalThis.death;

/** co si obřad vede v nulté stránce */
const WATCHED = [
  [0x43, 'smrt'], [0x47, 'snooze'], [0x3F, 'stav agenta'], [0x51, 'žádost o salto'],
  [0xDE, 'západka tlačítka'], [0x6D, 'koule je'], [0x6E, 'koule skript'],
  [0x54, 'poslední robot'], [0x7E, 'místnost'], [0x7F, 'strana'],
  [0x18, 'záznam lo'], [0x19, 'záznam hi'], [0x81, 'výtahy lo'], [0x82, 'výtahy hi'],
  [0xE4, 'devátý bit stranou'], [0xE5, 'zbytek řádku'],
  // ★ **míchačka**: kdyby se rozešla, rozpouštění by se rozešlo s ní, a
  // tohle je to jediné místo, kde je vidět hned
  [0xEB, 'míchačka lo'], [0xEC, 'míchačka hi'],
  // hodiny — kvůli těm deseti minutám
  [0xD1, 'hodiny snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
];
for (let i = 0; i < 7; i++) { WATCHED.push([0x2C + i, `sprajt agenta ${i}`]); }
for (let r = 0; r < 4; r++) {
  const b = 0x55 + r*6;
  WATCHED.push([b, `robot ${r} program`], [b + 1, `robot ${r} příznaky`],
               [b + 2, `robot ${r} instrukce`], [b + 3, `robot ${r} adresa lo`],
               [b + 4, `robot ${r} adresa hi`], [b + 5, `robot ${r} podsloupec`]);
}
const VIC = [[0x15, 'svítí'], [0x10, 'devátý bit x'], [0x1C, 'multicolor'],
             [0x1D, 'široké'], [0x17, 'vysoké']];
// ★ `$D01E` se uvnitř obřadu **nesrovnává**, a je to přiznaná díra: latch
// plní **rastr**, který po celou dobu obřadu kreslí dál, takže se v něm
// během první stovky řádků usadí `$0F` a zůstane tam. Model rastr v téhle
// jemnosti nekreslí — jeho zameten je jednou za snímek, a v obřadu žádný
// snímek není (§31). Na poslední zastávce před `CLI` se srovnává, protože
// tam ho obřad sám vyčistil (`$96E3`), a tam musí být nula u obou.
for (let i = 0; i < 8; i++) { VIC.push([i*2, `sprajt ${i} x`], [i*2 + 1, `sprajt ${i} y`]); }
for (let i = 0; i < 3; i++) { VIC.push([0x28 + i, `barva sprajtu ${i + 1}`]); }

const BLOCKS = 0x4D80, BLOCK_BYTES = 192;
const RECORDS = 0x0E00, RECORD_BYTES = 0x1000;
const SCREEN = 0x4000, SCREEN_BYTES = 0x400;
const POINTERS = 0x43F8;
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).sort();

let checks = 0, diffs = 0, records = 0, stops = 0, rounds = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.trapOf || rec.frames.length < 3) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  const mix = () => entropy;

  // ★ Stroj se sází z **první zastávky**, tedy z okamžiku, kdy obřad začíná:
  // celá nultá stránka, ukazatele, bloky, záznamy místností, obrazovka,
  // barvy a registry VIC. Od té chvíle si přepis vede stav sám.
  const first = rec.frames[0];
  const put = (hexed, atAddr) => {
    const raw = bytes(hexed);
    for (let i = 0; i < raw.length; i++) { m.mem[atAddr + i] = raw[i]; }
  };
  put(first.zp, 0);
  put(first.ptr, POINTERS);
  put(first.blocks, BLOCKS);
  put(first.records, RECORDS);
  put(first.screen, SCREEN);
  const firstColor = bytes(first.color);
  for (let i = 0; i < firstColor.length; i++) { m.color[i] = firstColor[i]; }
  const firstVic = bytes(first.vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }

  let bad = 0, compared = 0;
  const compare = (stop, label, deep, latch) => {
    const want = rec.frames[stop];
    const wantZp = bytes(want.zp), wantVic = bytes(want.vic), wantPtr = bytes(want.ptr);
    const wantBlocks = bytes(want.blocks);
    const report = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} ${label}: ${what} přepis $${mine.toString(16)} `
          + `!= originál $${theirs.toString(16)}`);
      }
    };
    for (const [addr, text] of WATCHED) {
      checks++;
      if (m.mem[addr] !== wantZp[addr]) {
        report(`${text} ($${addr.toString(16)})`, m.mem[addr], wantZp[addr]);
      }
    }
    const regs = latch ? VIC.concat([[0x1E, 'latch kolizí']]) : VIC;
    for (const [reg, text] of regs) {
      checks++;
      const mask = (reg >= 0x20) ? 0x0F : 0xFF;
      if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
        report(`${text} ($d0${reg.toString(16).padStart(2, '0')})`,
               m.vic[reg] & mask, wantVic[reg] & mask);
      }
    }
    for (let i = 0; i < 8; i++) {
      checks++;
      if (m.mem[POINTERS + i] !== wantPtr[i]) {
        report(`ukazatel sprajtu ${i}`, m.mem[POINTERS + i], wantPtr[i]);
      }
    }
    // ★ **tři bloky, do kterých se agent rozpouští** — jádro tohohle měřidla
    for (let i = 0; i < BLOCK_BYTES; i++) {
      checks++;
      if (m.mem[BLOCKS + i] !== wantBlocks[i]) {
        report(`blok $${(BLOCKS + i).toString(16)}`, m.mem[BLOCKS + i], wantBlocks[i]);
      }
    }
    if (deep) {
      // ★ a na konci i **záznamy místností** (lift reset do nich píše),
      // **obrazovka** a **barvy** — tam, kde se kreslí
      const wantRecords = bytes(want.records), wantScreen = bytes(want.screen),
            wantColor = bytes(want.color);
      for (let i = 0; i < RECORD_BYTES; i++) {
        checks++;
        if (m.mem[RECORDS + i] !== wantRecords[i]) {
          report(`záznam $${(RECORDS + i).toString(16)}`, m.mem[RECORDS + i], wantRecords[i]);
        }
      }
      for (let i = 0; i < SCREEN_BYTES; i++) {
        checks++;
        if (m.mem[SCREEN + i] !== wantScreen[i]) {
          report(`obrazovka $${(SCREEN + i).toString(16)}`, m.mem[SCREEN + i], wantScreen[i]);
        }
      }
      for (let i = 0; i < wantColor.length; i++) {
        checks++;
        if ((m.color[i] & 0x0F) !== (wantColor[i] & 0x0F)) {
          report(`barva $${(0xD800 + i).toString(16)}`, m.color[i] & 0x0F, wantColor[i] & 0x0F);
        }
      }
    }
    compared++;
    stops++;
  };

  compare(0, 'zastávka $95E8', false);
  const how = m.mem[0x43];
  if (!bad && how !== death.BY_FALL) {
    death.copyBlocks(m);                                 // `$9720`
    death.flashIntro(m, mix);                            // `$9610`
    for (let r = 0; r <= death.ROUNDS && !bad; r++) {    // 33 kol
      death.roundBytes(m, mix);                          // `$961F`
      compare(1 + r, `kolo ${r + 1}`, false);
      rounds++;
      death.flash(m, 0, mix);                            // `$9643`
    }
    if (!bad) {
      death.clearBlocks(m);                              // `$964B`
      if (how === death.BY_LIFT) { death.eraseLiftColumn(m); }
      compare(1 + death.ROUNDS + 1, 'zastávka $966C', true);
    }
    if (!bad) {
      death.rebuild(m, mix);                             // `$966C`-`$96F2`
      compare(1 + death.ROUNDS + 2, 'zastávka $96F5', true, true);
    }
    // ★ Za `$96F5` je `CLI` a od něj do stavu sahá obsluha přerušení
    // (kolize, roboti, koule). Poslední zastávka proto srovnává **jen to,
    // co udělá `$96F6`-`$9703`** — agent svítí a západka tlačítka je na
    // jedné; všechno ostatní na `$9707` už není obřadovo.
    if (!bad) {
      death.resume(m);
      const want = bytes(rec.frames[1 + death.ROUNDS + 3].zp);
      checks++;
      if (m.mem[0xDE] !== want[0xDE]) {
        diffs++; bad++;
        console.log(`  ${name} zastávka $9707: západka tlačítka přepis `
          + `$${m.mem[0xDE].toString(16)} != originál $${want[0xDE].toString(16)}`);
      }
      checks++;
      if ((m.vic[0x15] & 0x0E) !== 0x0E) {
        diffs++; bad++;
        console.log(`  ${name} zastávka $9707: agent nesvítí ($${m.vic[0x15].toString(16)})`);
      }
      compared++; stops++;
    }
  }
  console.log(`  ${name}: ${compared} z ${rec.frames.length} zastávek, smrt druhu ${how}`
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchdeath: ${records} záznamů, ${stops} zastávek (${rounds} kol `
  + `rozpouštění), ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
