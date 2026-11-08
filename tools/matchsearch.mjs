#!/usr/bin/env node
/**
 * matchsearch — prohledávání nábytku přepsané proti prohledávání originálu.
 *
 * `$97F1` je šest míst, na kterých se čeká na snímek, a mezi nimi se hýbe
 * **znaková sada** (§27): okno nad agentem není obrázek, jsou to znaky
 * `$00`-`$1F`, jejichž glyfy se v tu chvíli přepisují na `$5000`. Měřidlo
 * proto srovnává po každém snímku:
 *
 * - **znakovou sadu** `$5000`-`$50FF` — tam okno doopravdy je;
 * - **obrazovku a barvy** celé místnosti — okno samo, a mazání nábytku;
 * - **záznamy nábytku** `$4F55` a **seznam nálezů** `$4EF5` s barvami;
 * - **co bylo pod oknem** (`$C100`), aby se poznalo, že se to vrátilo;
 * - nultou stránku včetně kreslicí polohy, čítače dílků a terminálů;
 * - ukazatele sprajtů a registry VIC.
 *
 * A k tomu hlásí **pokrytí**: která rozhodnutí `$98F1` se v záznamech aspoň
 * jednou udělala. Bez toho by nula dokazovala jen to, co se náhodou stalo.
 *
 *     ./tools/matchsearch.mjs [--dir build/search] [--name piece07] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/search');
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
  [0x18, 'ukazatel pruhu lo'], [0x19, 'ukazatel pruhu hi'],
  [0x1A, 'místo'], [0x2C, 'sprajt 1 x'], [0x2D, 'sprajt 1 y'],
  [0x2E, 'sprajt 2 x'], [0x2F, 'sprajt 2 y'], [0x30, 'sprajt 3 x'],
  [0x31, 'sprajt 3 y'], [0x32, 'devátý bit'],
  [0x3E, 'tik'], [0x3F, 'stav'], [0x41, 'pád'], [0x42, 'dosedl'],
  [0x43, 'smrt'], [0x50, 'natočení'], [0x51, 'salto'],
  [0x52, 'řádek pod agentem'], [0x53, 'sloupec pod agentem'],
  [0x7A, 'řádek'], [0x7C, 'ukazatel lo'], [0x7D, 'ukazatel hi'],
  [0x81, 'záznam lo'], [0x82, 'záznam hi'],
  [0x83, 'západka nahoru'], [0x85, 'západka dolů'],
  [0x86, 'offset v záznamu'], [0x87, 'nábytek lo'], [0x88, 'nábytek hi'],
  // ★ co prohledávání **napočítalo**: dílky, terminály a který kus se hledá
  [0xD6, 'dílků'], [0xD7, 'terminálů'],
  [0xE4, 'E4'], [0xE5, 'E5'], [0xE6, 'E6'], [0xEA, 'který kus'],
  [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xDE, 'západka střelby'], [0xE0, 'snímek'],
];
const POINTERS = 0x43F8;
const SCREEN = 0x4000;
/** bloky, které se srovnávají celé — a jejich adresa v paměti stroje */
const BLOCKS = [['charset', 0x5000, 'znaková sada', 0xFF],
                ['found', 0x4EF5, 'seznam nálezů', 0xFF],
                ['records', 0x4F55, 'záznamy nábytku', 0xFF],
                ['under', 0xC100, 'co je pod oknem', 0xFF]];
/**
 * ★ **Barvy uschované pod oknem se srovnávají jen po spodním půlbajtu.**
 * `$9BFC` je čte z barevné paměti (`LDA ($14),Y` nad `$D8xx`) a na stroji má
 * barevná paměť **jen čtyři bity** — horní půlbajt je to, co zrovna zůstalo
 * na sběrnici, takže se v záznamu mění od bajtu k bajtu (`$CF`, `$9F`, `$01`)
 * a zopakovat se nedá. Zpátky (`$9C1B`) se zapisuje do téže paměti, kde na
 * horním půlbajtu nezáleží — nic se tím tedy neztrácí, a je to jediná výjimka
 * v celém měřidle.
 */
const UNDER_COLOR = [0xC120, 0xC140];
/** registry VIC, ve kterých je vidět agent */
const VIC = [[0x03, 'sprajt 1 y'], [0x05, 'sprajt 2 y'], [0x07, 'sprajt 3 y'],
             [0x15, 'svítí'], [0x1C, 'multicolor'], [0x10, 'devátý bit x'],
             [0x18, 'sada a obrazovka']];

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, frames = 0, rides = 0, stopped = 0;
/** kolikrát který nález padl — `$98F1` rozlišuje pět věcí a čtyři umíme */
const kinds = new Map();
/**
 * ★ **Jedno místo, kde se měřit nedá, a je pojmenované.** Nález dílku pouští
 * `$995E JSR $9C3A`, které skládá obrázek dílku ze dvou tvarů a karty (§15) —
 * kreslení kapesního počítače, tedy M5. A je to práce, která se originálu
 * **do snímku nevejde**: otáčí 144 bajtů až třicetkrát, takže výpis stavu
 * padne doprostřed ní (§19) a v tom snímku je originál sám se sebou
 * rozdělaný. Záznam s dílkem se proto na tom snímku uzavře — a až po něj
 * sedí všechno včetně toho, že dílek padl a který to je.
/**
 * ★ Pokrytí, ne shoda: která rozhodnutí `$AC81` se v záznamech aspoň jednou
 * udělala. Bez tohohle by nula znamenala jen to, co se v záznamu náhodou
 * stalo — stejně jako u `tools/scancoverage.mjs` u robotů.
 */
const seen = {bar: 0, nothing: 0, piece: 0, password: 0, gaveUp: 0, finished: 0};
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
  // ★ znaková sada, záznamy nábytku a seznam nálezů jsou **vstup i výstup**:
  // prohledávání je čte i přepisuje, takže se musí začít z těch, které má
  // originál
  for (const [name, at] of BLOCKS) {
    const want = bytes(rec.frames[0][name]);
    for (let i = 0; i < want.length; i++) { m.mem[at + i] = want[i]; }
  }

  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, halted = 0, compared = 0, searching = 0, found = '', why = '';
  for (let f = 0; !halted && f + 1 < rec.frames.length; f++) {
    const passes = bytes(rec.frames[f + 1].harness)[0x13];
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    if (out.searching) { searching++; }
    if (out.searching === 1) { seen.bar++; }
    if (out.searching === 2) {
      seen.finished++;
      if (out.gaveUp) { seen.gaveUp++; }
    }
    if (m.pl && m.pl.search && m.pl.search.found) { found = m.pl.search.found; }
    // ★ Jízda **zdrží hlavní smyčku**, takže v jejích snímcích harness
    // napočítá nula průchodů (§25) — to se měří dál. Cokoli jiného než jeden
    // průchod mimo jízdu je místnost, ve které originál smyčku nestíhá (§19),
    // a tam se srovnávat nedá.
    if (passes !== 1 && !out.searching) { halted = f + 1; break; }
    // ★ `$AA40` (řídicí místnost) a `$A771` (kódová místnost) přepsané
    // nejsou; přepis to přizná řetězcem v `searched` a měřidlo se tam zastaví
    if (out.searched || out.transition || out.computer) { halted = f + 1; break; }
    // ★ a tady se zastaví nález dílku, viz `PIECE` výš
    if (out.partial) { halted = f + 1; why = out.partial; break; }
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
    for (const [name, at, label] of BLOCKS) {
      const want = bytes(rec.frames[f + 1][name]);
      for (let i = 0; i < want.length; i++) {
        const where = at + i;
        const mask = (where >= UNDER_COLOR[0] && where < UNDER_COLOR[1]) ? 0x0F : 0xFF;
        checks++;
        if ((m.mem[where] & mask) !== (want[i] & mask)) {
          say(`${label} $${where.toString(16)}`, m.mem[where] & mask, want[i] & mask);
        }
      }
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
  if (found) { kinds.set(found, (kinds.get(found) || 0) + 1); }
  rides += searching;
  console.log(`  ${name}: ${compared} z ${rec.frames.length - 1} snímků, `
    + `${searching} z nich prohledávání${found ? ' (' + found + ')' : ''}, skript ${rec.script}`
    + (halted ? `, od snímku ${halted} se neměří${why ? ' (' + why + ': $9C3A je M5)' : ''}` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchsearch: ${records} záznamů, ${frames} snímků `
  + `(${rides} v prohledávání), ${checks} kontrol, ${diffs} rozdílů`
  + (stopped ? `; ${stopped} záznamů se nedoměřilo` : ''));
for (const what of ['nothing', 'piece', 'password']) {
  if (kinds.has(what)) { seen[what] = kinds.get(what); }
}
const missed = Object.keys(seen).filter((k) => !seen[k]);
console.log('  pokryto: ' + Object.keys(seen).map((k) => `${k} ${seen[k]}×`).join(', ')
  + (missed.length ? ` — NEVYZKOUŠENO: ${missed.join(', ')}` : ''));
process.exit(diffs ? 1 : 0);
