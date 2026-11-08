#!/usr/bin/env node
/**
 * matchcollision — kolize sprajtů přepsané proti kolizím originálu.
 *
 * Akceptace M4 (`MILNIKY.md`): agent neumírá „když to vypadá, že se dotkl",
 * umírá **tak, jak o tom rozhodne `$D01E` a `$94FA`** (`app/collision.js`,
 * `sources/docs/disasm_notes.md` §30).
 *
 * ★ Proč je to vlastní měřidlo a nestačí `matchrobots`: latch `$D01E`
 * **čtení nuluje**, takže ve výpisu paměti po něm nic nezbude — v místnosti
 * je na `$8361` vždycky nula, ať se stalo cokoli. Záznam proto vzniká
 * `traceplayer.py --collision`, který obě `LDA $D01E` uvnitř `$94FA`
 * přepíše na stub a do `$0334`-`$0337` zapíše **co která přečetla a
 * kolikrát**. Tady se srovnává právě to: přepis musí latch plnit i vyprazdňovat
 * ve stejném pořadí jako stroj, jinak mu kolize přijdou o snímek pozdě.
 *
 * Srovnává se na každém snímku:
 *
 *   - **co `$94FA` přečetlo** na `$9517` a kolikrát se tam četlo;
 *   - **co v latchi zbylo** (`$D01E` ve výpisu VIC);
 *   - **následky**: `$43` smrt, `$47` snooze, `$6D` koule a `$D015`;
 *   - a celá nultá stránka robotů a koule, aby se nedalo „trefit kolizi"
 *     za cenu rozsypaného světa.
 *
 *     ./tools/matchcollision.mjs [--dir build/collision] [--name collwalk42] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/collision');
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
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);

/** kde harness vede okénko kolizí; blok `harness` začíná na `$0320` */
const H_PASSES = 0x13, H_READ_9508 = 0x14, H_READ_9517 = 0x15,
      H_COUNT_9508 = 0x16, H_COUNT_9517 = 0x17;

/** následky kolize a stav, ve kterém se musí ozvat */
const WATCHED = [
  [0x43, 'smrt'], [0x47, 'snooze'], [0x6D, 'koule je'], [0x54, 'poslední robot'],
  [0x6E, 'koule skript'], [0x6F, 'koule zbývá'], [0x70, 'koule čeká'],
  [0x71, 'koule hrana'], [0x85, 'západka dolů'],
  // ★ `$7A`-`$7D` jsou odkládací pásmo `$8CC3`, a obsluha si je kolem kolizí
  // a robotů **schová a vrátí** (`$832E`). Že to přepis dělá taky, je tady
  // vidět: bez toho se rozejdou hned.
  [0x7A, 'buňka lo'], [0x7B, 'buňka hi'], [0x7C, 'adresa lo'], [0x7D, 'adresa hi'],
];
// ★ `$72`/`$73` se **nesrovnávají**, a je to přiznaná díra, ne pohodlí:
// píše do nich `$9482`, tedy kód robotů a koule, a ten je v `app/orb.js`
// přepsaný jen z půlky (vlastní poznámka toho souboru). Kolize do nich sahá
// jen ve větvi `$9539`, a tu hlídá „co $94FA přečetlo".

for (let r = 0; r < 4; r++) {
  const b = 0x55 + r*6;
  WATCHED.push([b, `robot ${r} program`], [b + 1, `robot ${r} příznaky`],
               [b + 2, `robot ${r} instrukce`]);
}
const VIC = [[0x1E, 'latch $d01e'], [0x15, 'svítí'], [0x10, 'devátý bit x']];
for (let i = 0; i < 8; i++) { VIC.push([i*2, `sprajt ${i} x`], [i*2 + 1, `sprajt ${i} y`]); }

const POINTERS = 0x43F8;
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).sort();

let checks = 0, diffs = 0, records = 0, frames = 0, reads = 0, deaths = 0, hits = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.collision) { console.log(`${name}: natoč ho s --collision`); continue; }
  if (!rec.frames || rec.frames.length < 2) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;

  let begin = 0;
  while (begin + 1 < rec.frames.length
         && bytes(rec.frames[begin].harness)[H_PASSES] !== 1) { begin++; }
  const first = bytes(rec.frames[begin].zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
  const firstPtr = bytes(rec.frames[begin].ptr);
  for (let i = 0; i < firstPtr.length; i++) { m.mem[POINTERS + i] = firstPtr[i]; }
  const firstVic = bytes(rec.frames[begin].vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }

  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  // ★ Okénko je totéž, co má harness na stroji: co `$94FA` z latche přečetlo
  // a kolikrát. Vede ho `app/collision.js` v `m.co`, protože po čtení už
  // v latchi nic není a zpětně se to zjistit nedá.
  m.co = {value: 0, count: 0, sites: []};
  // ★ A **jeden zameten navíc na začátku**: obraz, který se kreslil, než
  // záznam začal. Bez něj by první `$833D` četlo prázdno, kdežto stroj v něm
  // má agentovy tři sprajty přes sebe (§30).
  globalThis.collision.sweep(m);

  let bad = 0, compared = 0, overrun = 0, mine = 0;
  for (let f = begin; !overrun && f + 1 < rec.frames.length; f++) {
    const want = bytes(rec.frames[f + 1].zp);
    const wantH = bytes(rec.frames[f + 1].harness);
    const passes = wantH[H_PASSES];
    m.co.value = 0; m.co.count = 0; m.co.sites.length = 0;
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    if (passes !== 1 && !out.moving) { overrun = f + 1; break; }
    if (out.transition || out.moving || out.searched || out.computer
        || out.lift) { break; }
    // ★ **Žádná zarážka na `$47` tu není, a je to nález, ne opomenutí.**
    // Dlouho tu stála s odůvodněním „blesk agenta omráčí" — jenže takový
    // kód v originálu **není**: do `$47` píšou právě čtyři místa (`$95C6`
    // smrt, `$96C1` obřad, `$A0E4` snooze z terminálu a `$A24A`
    // **clona přechodu**) a všechna čtyři přepsaná jsou. Co vypadalo jako
    // omráčení, byl pokaždé odchod z místnosti: `$47` spadne na nulu,
    // `$D015` zhasne a smyčka se zastaví, protože běží clona (§21).
    // Robotův blesk **zabíjí**, neomračuje — rozhoduje o tom `$9539` (§30).
    frames++; compared++;
    if (m.co.count) { reads++; }
    if (m.mem[0x43] && !mine) { mine = f + 1; deaths++; }
    if (m.co.value) { hits++; }

    const wantVic = bytes(rec.frames[f + 1].vic);
    const report = (what, got, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} snímek ${f + 1}: ${what} přepis $${got.toString(16)} `
          + `!= originál $${theirs.toString(16)}`);
      }
    };
    // ★ co `$94FA` přečetlo a kolikrát — jádro tohohle měřidla
    // ★ Stroj i přepis vedou okénko **po místech**: `$9508` je ta cesta,
    // která latch jen uklízí, `$9517` ta, ze které plyne rozhodnutí.
    const mine9508 = m.co.sites.filter((s) => s === 0x9508);
    const mine9517 = m.co.sites.filter((s) => s === 0x9517);
    checks++;
    if (mine9517.length !== wantH[H_COUNT_9517]) {
      report('kolikrát se $d01e četlo na $9517', mine9517.length, wantH[H_COUNT_9517]);
    }
    checks++;
    if (mine9508.length !== wantH[H_COUNT_9508]) {
      report('kolikrát se $d01e četlo na $9508', mine9508.length, wantH[H_COUNT_9508]);
    }
    checks++;
    if (m.co.value !== (wantH[H_READ_9517] || wantH[H_READ_9508])) {
      report('co $94FA přečetlo z $d01e', m.co.value,
             wantH[H_READ_9517] || wantH[H_READ_9508]);
    }
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== want[addr]) {
        report(`${label} ($${addr.toString(16)})`, m.mem[addr], want[addr]);
      }
    }
    for (const [reg, label] of VIC) {
      checks++;
      if (m.vic[reg] !== wantVic[reg]) {
        report(`${label} ($d0${reg.toString(16).padStart(2, '0')})`,
               m.vic[reg], wantVic[reg]);
      }
    }
    if (bad && !verbose) { break; }
    // ★ Po smrti měřit nemá co: `$95DA` je celý obřad (§31) a dokud přepsaný
    // není, běží originál proti jinému světu. Záznam se uzavře a je vidět,
    // na kolikátém snímku.
    if (m.mem[0x43]) { break; }
  }
  console.log(`  ${name}: ${compared} z ${rec.frames.length - 1 - begin} snímků`
    + (overrun ? `, od snímku ${overrun} originál smyčku nestíhá` : '')
    + (mine ? `, smrt na snímku ${mine}` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchcollision: ${records} záznamů, ${frames} snímků, ${reads} čtení `
  + `$d01e (z toho ${hits} s kolizí), ${deaths} smrtí, ${checks} kontrol, `
  + `${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
