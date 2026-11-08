#!/usr/bin/env node
/**
 * matchroomlift — jízda výtahem **v místnosti** přepsaná proti jízdě
 * originálu.
 *
 * `matchplayer` dokazuje, že se agent hýbe kódem originálu, ale o výtahu
 * v místnosti (§25) skoro nic neříká: srovnává nultou stránku a **jediný
 * řádek obrazovky**, zatímco celá jízda je vidět jenom na obrazovce — na
 * sloupci plošin, který se překresluje o řádek za dva snímky. Kdyby se
 * plošiny kreslily špatně, kdyby se posouvala jen ta, na které agent stojí,
 * nebo kdyby se do barev sázelo něco jiného než `$84`, nula u `matchplayer`
 * by to nepoznala.
 *
 * Tohle měřidlo tedy srovnává **celou obrazovku místnosti a celé její
 * barvy** po každém snímku, a k tomu nultou stránku (včetně `$10`/`$11`
 * a `$14`/`$15`, což je kreslicí poloha, a `$83`/`$85`, což jsou západky),
 * ukazatele sprajtů a registry VIC — tam leží svislá poloha agenta, kterou
 * jízda posouvá po čtyřech pixelech (`$AEC5`, `$AED8`).
 *
 *     ./tools/matchroomlift.mjs [--dir build/roomlift] [--name lift42a] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/roomlift');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const file of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild',
                    'transition', 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom', 'robots', 'orb', 'collision', 'death']) {
  loadClassicScript(new URL(`../app/${file}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);

/**
 * Nultá stránka: to, co srovnává `matchplayer` (§19), a k tomu čtyři bajty,
 * které jsou vlastní **jízdě** — kreslicí poloha `$10`/`$11` a barevná
 * `$14`/`$15`. Ta je jediný stav, který jízda nese mezi svými dvěma
 * půlkami, takže bez ní by se nepoznalo, že se kreslí na správné místo.
 */
const WATCHED = [
  [0x10, 'kreslicí lo'], [0x11, 'kreslicí hi'],
  [0x14, 'barevná lo'], [0x15, 'barevná hi'],
  [0x1A, 'místo'], [0x2C, 'sprajt 1 x'], [0x2D, 'sprajt 1 y'],
  [0x2E, 'sprajt 2 x'], [0x2F, 'sprajt 2 y'], [0x30, 'sprajt 3 x'],
  [0x31, 'sprajt 3 y'], [0x32, 'devátý bit'],
  [0x3E, 'tik'], [0x3F, 'stav'], [0x41, 'pád'], [0x42, 'dosedl'],
  [0x43, 'smrt'], [0x50, 'natočení'], [0x51, 'salto'],
  [0x52, 'řádek pod agentem'], [0x53, 'sloupec pod agentem'],
  [0x81, 'záznam lo'], [0x82, 'záznam hi'],
  [0x83, 'západka nahoru'], [0x84, 'barva dlaždice'], [0x85, 'západka dolů'],
  [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xDE, 'západka střelby'], [0xE0, 'snímek'],
  [0xE4, 'E4'], [0xE5, 'E5'], [0xE6, 'E6'],
];
const POINTERS = 0x43F8;
const SCREEN = 0x4000;
/** registry VIC, ve kterých leží svislá poloha tří sprajtů agenta */
const VIC = [[0x03, 'sprajt 1 y'], [0x05, 'sprajt 2 y'], [0x07, 'sprajt 3 y'],
             [0x15, 'svítí'], [0x1C, 'multicolor'], [0x10, 'devátý bit x']];

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, frames = 0, rides = 0, stopped = 0;
/**
 * ★ Pokrytí, ne shoda: která rozhodnutí `$AC81` se v záznamech aspoň jednou
 * udělala. Bez tohohle by nula znamenala jen to, co se v záznamu náhodou
 * stalo — stejně jako u `tools/scancoverage.mjs` u robotů.
 */
const seen = {up: 0, down: 0, top: 0, bottom: 0, latched: 0, released: 0};
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.frames || rec.frames.length < 2) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  m.noRobots = true;                       // záznam má `$8ECA` na `RTS` (M3)

  const first = bytes(rec.frames[0].zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
  const firstPtr = bytes(rec.frames[0].ptr);
  for (let i = 0; i < firstPtr.length; i++) { m.mem[POINTERS + i] = firstPtr[i]; }
  // ★ Obrazovka je vstup i výstup: jízda do ní kreslí a kolize se jí ptá na
  // podlahu, takže se musí začít z té, kterou má originál.
  const firstScreen = bytes(rec.frames[0].screen);
  for (let i = 0; i < firstScreen.length; i++) { m.mem[SCREEN + i] = firstScreen[i]; }
  const firstColor = bytes(rec.frames[0].color);
  for (let i = 0; i < firstColor.length; i++) { m.color[i] = firstColor[i] & 0x0F; }
  const firstVic = bytes(rec.frames[0].vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }

  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, halted = 0, compared = 0, riding = 0;
  for (let f = 0; !halted && f + 1 < rec.frames.length; f++) {
    const passes = bytes(rec.frames[f + 1].harness)[0x13];
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    if (out.riding) { riding++; }
    const lift = out.roomLift;
    if (lift && lift.at >= 0) {
      if (lift.ride) { seen[lift.wants > 0 ? 'up' : 'down']++; }
      else if (lift.refused) { seen[lift.refused]++; }
      else if (!lift.wants) { seen.released++; }
    }
    // ★ Jízda **zdrží hlavní smyčku**, takže v jejích snímcích harness
    // napočítá nula průchodů (§25) — to se měří dál. Cokoli jiného než jeden
    // průchod mimo jízdu je místnost, ve které originál smyčku nestíhá (§19),
    // a tam se srovnávat nedá.
    if (passes !== 1 && !out.riding) { halted = f + 1; break; }
    if (out.searched || out.transition || out.computer) { halted = f + 1; break; }
    const want = bytes(rec.frames[f + 1]. zp);
    const wantPtr = bytes(rec.frames[f + 1].ptr);
    const wantScreen = bytes(rec.frames[f + 1].screen);
    const wantColor = bytes(rec.frames[f + 1].color);
    const wantVic = bytes(rec.frames[f + 1].vic);
    frames++; compared++;
    const say = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} snímek ${f + 1}: ${what} přepis $${mine.toString(16)}`
          + ` != originál $${theirs.toString(16)}`);
      }
    };
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== want[addr]) { say(`${label} ($${addr.toString(16)})`, m.mem[addr], want[addr]); }
    }
    for (let i = 0; i < wantPtr.length; i++) {
      checks++;
      if (m.mem[POINTERS + i] !== wantPtr[i]) {
        say(`ukazatel sprajtu $${(POINTERS + i).toString(16)}`, m.mem[POINTERS + i], wantPtr[i]);
      }
    }
    for (const [reg, label] of VIC) {
      checks++;
      if (m.vic[reg] !== wantVic[reg]) { say(`VIC ${label} ($d0${reg.toString(16).padStart(2, '0')})`, m.vic[reg], wantVic[reg]); }
    }
    for (let i = 0; i < wantScreen.length; i++) {
      checks++;
      if (m.mem[SCREEN + i] !== wantScreen[i]) {
        say(`obrazovka ${Math.floor(i / 40)}/${i % 40}`, m.mem[SCREEN + i], wantScreen[i]);
      }
    }
    for (let i = 0; i < wantColor.length; i++) {
      checks++;
      if ((m.color[i] & 0x0F) !== (wantColor[i] & 0x0F)) {
        say(`barva ${Math.floor(i / 40)}/${i % 40}`, m.color[i] & 0x0F, wantColor[i] & 0x0F);
      }
    }
    if (bad && !verbose) { break; }
  }
  if (halted) { stopped++; }
  rides += riding;
  console.log(`  ${name}: ${compared} z ${rec.frames.length - 1} snímků, `
    + `${riding} z nich jízda, skript ${rec.script}`
    + (halted ? `, od snímku ${halted} se neměří` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchroomlift: ${records} záznamů, ${frames} snímků `
  + `(${rides} ve jízdě), ${checks} kontrol, ${diffs} rozdílů`
  + (stopped ? `; ${stopped} záznamů se nedoměřilo` : ''));
const missed = Object.keys(seen).filter((k) => !seen[k]);
console.log('  pokryto: ' + Object.keys(seen).map((k) => `${k} ${seen[k]}×`).join(', ')
  + (missed.length ? ` — NEVYZKOUŠENO: ${missed.join(', ')}` : ''));
process.exit(diffs ? 1 : 0);
