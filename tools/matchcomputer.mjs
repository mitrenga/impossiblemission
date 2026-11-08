#!/usr/bin/env node
/**
 * matchcomputer — **kapesní počítač** přepsaný proti počítači originálu
 * (`sources/docs/disasm_notes.md` §34).
 *
 * ★ **Tady snímek jednotka je.** `$83EA` na vrcholu smyčky `$3AF5` čeká na
 * `$E0` a obsluha přerušení běží dál, takže jeden průchod smyčky je jeden
 * snímek — na rozdíl od terminálu (§29) a obřadu umírání (§31), které drží
 * `SEI` a měří se zastávkami. Přepis je proto **generátor, který yielduje
 * přesně tam, kde originál volá `$7F6B`**, a měřidlo ho krokuje snímek po
 * snímku přes `player.frame`, tedy i s obsluhou přerušení a hodinami.
 *
 * Srovnává se to, čím počítač je:
 *
 * - **šest přihrádek** `$5C50`-`$5FAF`, tedy okno do sady počítače (§14) —
 *   dílek se v nich **počítá**, ne kreslí (`$9C3A`, §15);
 * - **dva sprajtové bloky** `$4D80`/`$4DC0`, ve kterých nesený dílek jezdí;
 * - **seznam nalezených dílků** a jejich barvy, **záznamy 36 dílků**
 *   (telefon do nich píše) a nárazník undo;
 * - spodní půlka obrazovky i s **ukazateli sprajtů**, a její barvy, protože
 *   listování seznamu je posouvá;
 * - nultá stránka a registry VIC — ruka, značka a ukazatel jsou sprajty.
 *
 *     ./tools/matchcomputer.mjs [--dir build/computer] [--name compopen42]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/computer');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const file of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild',
                    'transition', 'roomLift', 'furniture', 'terminal',
                    'pocketComputer', 'codeRoom', 'controlRoom', 'robots', 'orb', 'collision', 'death']) {
  loadClassicScript(new URL(`../app/${file}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);

/** nultá stránka, na které kapesní počítač stojí (§34) */
const WATCHED = [
  [0x10, 'kreslicí lo'], [0x11, 'kreslicí hi'],
  [0x14, 'barevná lo'], [0x15, 'barevná hi'],
  [0x18, 'ukazatel lo'], [0x19, 'ukazatel hi'],
  [0x1A, 'místo'], [0x3F, 'stav agenta'], [0x43, 'smrt'],
  [0x8F, 'vybraná přihrádka'], [0x90, 'odkud se nese'], [0x91, 'undo'],
  [0x92, 'obsazeno 0'], [0x93, 'obsazeno 1'], [0x94, 'obsazeno 2'],
  [0x95, 'obsazeno 3'], [0x96, 'obsazeno 4'], [0x97, 'obsazeno 5'],
  // ★ Šest barev přihrádek se srovnává **jen po spodním půlbajtu**: přijdou
  // buď z barevné paměti (`$7B27 LDA $DA87 / STA $98`), která má na stroji
  // čtyři bity a v horní půlce to, co zrovna zůstalo na sběrnici VIC, nebo
  // z barevného registru (`$3BE9 LDA SP5COL`), jehož horní půlka se čte
  // jako samé jedničky. Ani jedno se v modelu nemá odkud vzít.
  [0x98, 'barva 0', 0x0F], [0x99, 'barva 1', 0x0F], [0x9A, 'barva 2', 0x0F],
  [0x9B, 'barva 3', 0x0F], [0x9C, 'barva 4', 0x0F], [0x9D, 'barva 5', 0x0F],
  [0x9E, 'barva dílku'], [0x9F, 'režim'],
  [0xA0, 'mez nahoru'], [0xA1, 'mez dolů'], [0xA2, 'mez doleva'], [0xA3, 'mez doprava'],
  [0xA4, 'doznívání zvuku'],
  [0xC3, 'kde v seznamu'],
  [0xC4, 'tvar B lo'], [0xC5, 'tvar B hi'], [0xC6, 'tvar A lo'], [0xC7, 'tvar A hi'],
  [0xC8, 'složeno 0'], [0xC9, 'složeno 1'], [0xCA, 'složeno 2'],
  [0xCB, 'složeno 3'], [0xCC, 'složeno 4'], [0xCD, 'složeno 5'],
  [0xCE, 'složeno 6'], [0xCF, 'složeno 7'], [0xD0, 'složeno 8'],
  [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xD5, 'čas zastaven'], [0xD6, 'dílků'], [0xD7, 'hesel'], [0xD8, 'skládaček'],
  [0xDE, 'západka střelby'], [0xE0, 'čítač snímků'],
  [0xEB, 'míchačka lo'], [0xEC, 'míchačka hi'],
];

/** bloky, které se srovnávají celé: (jméno v záznamu, adresa, popis, maska) */
const BLOCKS = [
  ['panel', 0x3450, 'panel šachty (heslo)', 0xFF],
  ['blocks', 0x4D80, 'sprajtové bloky neseného dílku', 0xFF],
  ['found', 0x4EF5, 'seznam nalezených dílků', 0xFF],
  ['window', 0x5C50, 'šest přihrádek', 0xFF],
  ['records', 0xBFC0, 'záznamy 36 dílků', 0xFF],
  ['buffers', 0xC100, 'nárazník undo', 0xFF, 0, 0x120],
  // ★ a totéž, co u šesti barev: co si telefon schoval, je **barevná
  // paměť**, tedy čtyři bity a nad nimi sběrnice
  ['buffers', 0xC220, 'barvy, co schoval telefon', 0x0F, 0x120, 0xB0],
  ['screen', 0x4280, 'spodní půlka obrazovky', 0xFF],
  ['parked', 0xC690, 'odložená kopie přihrádek', 0xFF],
];

/** ★ a co z registrů VIC se srovnávat nedá — tytéž výjimky jako všude (§12) */
const vicSkip = new Set([0x12, 0x19, 0x1E, 0x1F]);
function vicUnused(reg) {
  if (reg === 0x11) { return 0x80; }
  if (reg === 0x16) { return 0xC0; }
  if (reg === 0x18) { return 0x01; }
  if (reg === 0x1A || reg >= 0x20) { return 0xF0; }
  return 0x00;
}

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).sort();

let checks = 0, diffs = 0, records = 0, frames = 0;
/** ★ pokrytí: která tlačítka počítače záznamy aspoň jednou stiskly. Říká to
 * přepis sám (`out.did`), ne dohad měřidla — nula u `matchcomputer` by jinak
 * dokazovala jen to, co se v záznamu náhodou stalo (jako `scancoverage` u robotů). */
const seen = {open: 0, pick: 0, drop: 0, rotate: 0, flip: 0, trash: 0,
              undo: 0, colour: 0, suspend: 0, scroll: 0, phone: 0, map: 0, solved: 0};

for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.frames || rec.frames.length < 3) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  // ★ záznam má roboty, kouli i kolize přepsané na `RTS` — v šachtě stejně
  // neběží (`$82F8`), ale přepis to musí vědět
  m.noRobots = true;
  m.noCollision = true;

  // ★ Výchozí stav se dosadí **z prvního snímku**: `_ram.bin` je paměť ve
  // chvíli, kdy se harness postavil, a mezi ní a první pastí ještě proběhla
  // půlka obsluhy přerušení. Dosazuje se všechno, co se pak srovnává.
  const first = rec.frames[0];
  const firstZp = bytes(first.zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = firstZp[i]; }
  for (const [block, base, , , from, length] of BLOCKS) {
    if (!first[block]) { continue; }
    const want = bytes(first[block]);
    const start = from || 0, n = length === undefined ? want.length - start : length;
    for (let i = 0; i < n; i++) { m.mem[base + i] = want[start + i]; }
  }
  const firstColor = bytes(first.color);
  for (let i = 0; i < firstColor.length; i++) { m.color[0x280 + i] = firstColor[i] & 0x0F; }
  const firstVic = bytes(first.vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, compared = 0, opened = 0, skipped = 0, skip = 0, why = '';
  for (let f = 0; f + 1 < rec.frames.length; f++) {
    const passes = bytes(rec.frames[f + 1].harness)[0x43];
    const before = m.mem[0x8F], mode = m.mem[0x9F], scroll = m.mem[0xC3],
          solved = m.mem[0xD8];
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    if (out.computer === 1 && !opened) { opened = 1; seen.open++; }
    if (out.did && seen[out.did] !== undefined) { seen[out.did]++; }
    // ★ **Mapa se do snímku nevejde.** `$B63B` přehází osm set šedesát čtyři
    // bajtů sady a nakreslí sto padesát buněk, takže past na `$8361` padne
    // doprostřed té práce a výpis je z rozdělaného stavu — táž mez, jakou má
    // `matchplayer` v těžké místnosti (§19) a `$9C3A` u listování. Snímek,
    // ve kterém přepis mapu dodělá, a ten za ním se proto nesrovnávají;
    // od dalšího jsou stroj i přepis zase hotoví a srovnává se dál.
    if (out.computer === 2) { skip = 2; }
    // ★ A totéž u složené skládačky: `$80B6` vymaže dvě stě osmdesát osm
    // bajtů a dvakrát složí obrázek (`$9C3A`), což se do snímku nevejde —
    // přepis ten snímek přizná sám (`overrun`) a od dalšího se srovnává dál.
    if (out.overrun) { skip = 1; }

    if (skip > 0) { skip--; skipped++; continue; }
    const want = rec.frames[f + 1];
    const wantZp = bytes(want.zp);
    frames++; compared++;
    const say = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 6) {
        console.log(`  ${name} snímek ${f + 1}: ${what} přepis `
          + `$${mine.toString(16)} != originál $${theirs.toString(16)}`);
      }
    };
    for (const [addr, label, zpMask] of WATCHED) {
      const mask = zpMask === undefined ? 0xFF : zpMask;
      checks++;
      if ((m.mem[addr] & mask) !== (wantZp[addr] & mask)) {
        say(`${label} ($${addr.toString(16)})`, m.mem[addr] & mask, wantZp[addr] & mask);
      }
    }
    const wantVic = bytes(want.vic);
    for (let reg = 0; reg < 0x2F; reg++) {
      if (vicSkip.has(reg)) { continue; }
      const mask = 0xFF & ~vicUnused(reg);
      checks++;
      if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
        say(`VIC $d0${reg.toString(16).padStart(2, '0')}`,
            m.vic[reg] & mask, wantVic[reg] & mask);
      }
    }
    const wantColor = bytes(want.color);
    for (let i = 0; i < wantColor.length; i++) {
      checks++;
      if ((m.color[0x280 + i] & 0x0F) !== (wantColor[i] & 0x0F)) {
        say(`barva $${(0xDA80 + i).toString(16)}`,
            m.color[0x280 + i] & 0x0F, wantColor[i] & 0x0F);
      }
    }
    for (const [block, base, label, mask, from, length] of BLOCKS) {
      if (!want[block]) { continue; }
      const wantBlock = bytes(want[block]);
      const start = from || 0, n = length === undefined ? wantBlock.length - start : length;
      for (let i = 0; i < n; i++) {
        checks++;
        if ((m.mem[base + i] & mask) !== (wantBlock[start + i] & mask)) {
          say(`${label} $${(base + i).toString(16)}`,
              m.mem[base + i] & mask, wantBlock[start + i] & mask);
        }
      }
    }
    if (bad && !verbose) { why = 'rozdíl'; break; }
  }
  console.log(`${name}: ${compared} snímků${skipped ? ` (+${skipped} přeskočených na rozdělané práci)` : ''}`
    + `${why ? ' (' + why + ')' : ''}, ${bad} rozdílů`);
}

const cover = Object.keys(seen).filter((k) => seen[k] > 0);
console.log(`matchcomputer: ${records} záznamů, ${frames} snímků, `
  + `${checks} kontrol, ${diffs} rozdílů`);
console.log(`  pokrytí: ${cover.length} z ${Object.keys(seen).length} — `
  + Object.keys(seen).map((k) => `${k} ${seen[k]}`).join(', '));
process.exit(diffs ? 1 : 0);
