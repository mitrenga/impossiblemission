#!/usr/bin/env node
/**
 * matchplayer — krok agenta přepsaný proti kroku agenta originálu.
 *
 * Akceptace M3 (`MILNIKY.md`): agent se nehýbe „podobně", hýbe se **kódem
 * originálu** (`app/player.js`, `sources/docs/disasm_notes.md` §19). Důkaz
 * má stejný tvar jako u pevnosti a u místnosti: vezme se paměť stroje
 * v okamžiku, kdy záznam začíná, dosadí se do ní nultá stránka z prvního
 * snímku, a pak se **snímek po snímku** pouští přepis a srovnává se s tím,
 * co měl originál (`tools/traceplayer.py`).
 *
 * Srovnává se **to, co je o agentovi vidět**: poloha tří sprajtů a devátý
 * bit, hrany, stav, natočení, rychlost, tik, pád, smrt, místo, hodiny,
 * ukazatele sprajtů a scratch, který si stavitel kroku píše do nulté
 * stránky. Tedy ne celá nultá stránka: zvuk, roboti a míchačka do M3
 * nepatří a jejich bajty se hýbou samy od sebe.
 *
 *     ./tools/matchplayer.mjs [--dir build/player] [--name walk] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/player');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
loadClassicScript(new URL('../app/roomBuild.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/elevator.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/shaftBuild.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/transition.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/roomLift.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/furniture.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/terminal.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/pocketComputer.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/codeRoom.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/controlRoom.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/robots.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/orb.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/collision.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/death.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);

/**
 * Co se srovnává a jak se to jmenuje v `disasm_notes.md` §19. Adresa je
 * v nulté stránce, kromě ukazatelů sprajtů, které leží v obrazovce.
 */
const WATCHED = [
  [0x1A, 'místo'], [0x18, 'sprajt lo'], [0x19, 'sprajt hi'],
  [0x2C, 'sprajt 1 x'], [0x2D, 'sprajt 1 y'], [0x2E, 'sprajt 2 x'],
  [0x2F, 'sprajt 2 y'], [0x30, 'sprajt 3 x'], [0x31, 'sprajt 3 y'],
  [0x32, 'devátý bit'], [0x33, 'nová horní'], [0x34, 'nová dolní'],
  [0x35, 'nová levá'], [0x36, 'nová pravá'], [0x37, 'střed y'], [0x38, 'střed x'],
  [0x39, 'krok'], [0x3A, 'levá'], [0x3B, 'pravá'], [0x3C, 'dolní'], [0x3D, 'horní'],
  [0x3E, 'tik'], [0x3F, 'stav'], [0x40, 'dělič'], [0x41, 'pád'], [0x42, 'dosedl'],
  [0x43, 'smrt'], [0x50, 'natočení'], [0x51, 'salto'],
  // ★ `$AC81` je pátý krok smyčky místnosti a počítá tohle **každý průchod**,
  // ať pod agentem něco je, nebo není (§23)
  [0x52, 'řádek pod agentem'], [0x53, 'sloupec pod agentem'],
  [0x81, 'záznam místnosti lo'], [0x82, 'záznam místnosti hi'],
  [0x83, 'západka otevírání'], [0x85, 'západka prohledávání'],
  [0x79, 'devátý bit scratch'], [0x7A, 'řádek'], [0x7C, 'ukazatel lo'],
  [0x7B, 'ukazatel hi scratch'], [0x7D, 'ukazatel hi'],
  [0xC1, 'zvonek'], [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'],
  [0xD4, 'hodiny'], [0xDE, 'západka'],
  [0xE0, 'snímek'], [0xE4, 'E4'], [0xE5, 'E5'], [0xE6, 'E6'], [0xE7, 'E7'],
  [0xE8, 'E8'],
  // ★ **Dva posuvné registry, ze kterých roboti berou výšku** (`$84EA`,
  // `app/sound.js`). Hlídané od 2026-09-20: do té doby je nekontroloval
  // nikdo, přepis je nechával stát na jedničce a hlas 1 měl proto frekvenci
  // nula — robot byl němý až na jedno pípnutí (`ZADANI.md` §10.14).
  [0xE1, 'šum E1'], [0xE3, 'šum E3'],
];
/**
 * ★ `$E4` a `$E5` se dřív srovnávaly **jen v místnosti**: v šachtě je
 * přepisuje kresba kabiny (`$3A18 JSR $73E4` → `$B757`) každý průchod a ta
 * nebyla přepsaná. Od výtahu (§20) je (`app/elevator.js`), takže se srovnávají
 * všude a seznam výjimek je prázdný.
 */
const ROOM_ONLY = [];
/**
 * ★ **Kreslicí poloha `$10`/`$11` a `$14`/`$15` se tady nesrovnává**, a je to
 * vědomé: zkusilo se to 2026-09-20 a vyšlo z toho **16 rozdílů v 8 záznamech**
 * — všechny na jednom místě, v posledním kroku stírání místnosti (§21), kde má
 * přepis `$3FD8` a originál ještě `$4000`. Je to **fázový posun o jeden
 * snímek** v `trCoverStep`, ne chyba kreslení (srovnávaný řádek obrazovky
 * i vše ostatní sedí), a patří k přechodu, ne k výtahu. Pro **jízdu výtahem
 * v místnosti** ty čtyři bajty srovnává `tools/matchroomlift.mjs`, kde jsou
 * na nule. Zapsané v `ZADANI.md` §10.9.
 */
const POINTERS = 0x43F9;
/** dvanáctý řádek obrazovky hry — jediný vstup pohybu mimo nultou stránku */
const ROW = 0x41E0;

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, frames = 0, overruns = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.frames || rec.frames.length < 2) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  // ★ Entropie: originál mísí do zdiva šachty rastrový řádek (`EOR $D012` na
  // `$82E3`, §8), záznam tam má dosazený pevný bajt — tak ať ho přepis
  // dostane taky, jinak se míchačka rozejde, jakmile se šachta staví (§22).
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  // ★ záznam bez robotů má `$8ECA` přepsané na `RTS` (M3) — přepis to musí
  // vědět, jinak by roboty hýbal proti záznamu, ve kterém stojí
  m.noRobots = !rec.robots;

  // ★ Ze kterého snímku se dá vyjít: z prvního, který je z **dokončeného
  // průchodu** (`harness[$13]` = 1). Bez rozjezdu jich harness první snímek
  // napočítá nula — past se postaví uprostřed snímku a vrchol smyčky na něj
  // ten snímek už nedojde — takže se o jeden posune. Není to originál, který
  // by nestíhal, je to okamžik, kdy se past postavila.
  let begin = 0;
  while (begin + 1 < rec.frames.length
         && bytes(rec.frames[begin].harness)[0x13] !== 1) { begin++; }
  const first = bytes(rec.frames[begin].zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
  const firstPtr = bytes(rec.frames[begin].ptr);
  for (let i = 0; i < firstPtr.length; i++) { m.mem[POINTERS + i] = firstPtr[i]; }

  // joystick snímek po snímku: úseky skriptu za sebou
  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, stopped = 0, overrun = 0, compared = 0;
  if (bytes(rec.frames[begin].harness)[0x13] !== 1) { overrun = begin; }
  for (let f = begin; !overrun && f + 1 < rec.frames.length; f++) {
    // ★ Kolikrát se hlavní smyčka za ten snímek otočila, říká záznam:
    // v těžké místnosti originál jeden průchod do snímku nevejde a snímek
    // vynechá (§19). Je to rychlost 6510, ne logika, takže to harness měří
    // a přepis se tím řídí — obsluha přerušení běží tak jako tak.
    const passes = bytes(rec.frames[f + 1].harness)[0x13];
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    // ★ A `out.lift` — **jízda výtahem v šachtě běží mimo hlavní smyčku**
    // (`$3A85`, `$3AA4`), takže je nula průchodů v pořádku, ne přetečení
    // snímku. Od 2026-09-21, kdy se jízda z `plLoop` přestěhovala ven.
    if (passes !== 1 && !out.moving && !out.riding && !out.searching && !out.lift) {
      // ★ Tady se srovnávat nedá, a není to chyba přepisu: v místnosti
      // s hodně nábytkem **jeden průchod smyčkou originálu do snímku
      // nevejde** (§19), takže výpis stavu padne doprostřed rozdělané
      // práce — stav agenta už je nový, ale ukazatele sprajtů ještě staré.
      // Záznam se v tom místě uzavře a kolik snímků dal, je vidět.
      // ★ Nula průchodů ale znamená i **přechod mezi místností a šachtou**
      // (§21) a **jízdu výtahem v místnosti** (§25) — obojí přepis umí,
      // pozná se to podle `moving` a `riding` a měří se dál.
      overrun = f + 1;
      break;
    }
    // ★ Přechod, který přepis **provede**, záznam neukončí; ukončí ho jen
    // ten, který umí jen nahlásit (zatím místnost → šachta).
    if ((out.transition && !out.moving) || out.searched || out.computer
        || out.lift) { stopped = f + 1; break; }
    const want = bytes(rec.frames[f + 1].zp), wantPtr = bytes(rec.frames[f + 1].ptr);
    frames++; compared++;
    const watched = m.mem[0x1A] ? WATCHED.concat(ROOM_ONLY) : WATCHED;
    for (const [addr, label] of watched) {
      checks++;
      if (m.mem[addr] === want[addr]) { continue; }
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} snímek ${f + 1}: ${label} ($${addr.toString(16)}) `
          + `přepis $${m.mem[addr].toString(16)} != originál $${want[addr].toString(16)}`);
      }
    }
    for (let i = 0; i < wantPtr.length; i++) {
      checks++;
      if (m.mem[POINTERS + i] !== wantPtr[i]) {
        diffs++; bad++;
        if (verbose || bad <= 3) {
          console.log(`  ${name} snímek ${f + 1}: ukazatel sprajtu $${(POINTERS + i).toString(16)} `
            + `přepis $${m.mem[POINTERS + i].toString(16)} != originál $${wantPtr[i].toString(16)}`);
        }
      }
    }
    const wantRow = bytes(rec.frames[f + 1].row);
    for (let i = 0; i < wantRow.length; i++) {
      checks++;
      if (m.mem[ROW + i] !== wantRow[i]) {
        diffs++; bad++;
        if (verbose || bad <= 3) {
          console.log(`  ${name} snímek ${f + 1}: obrazovka $${(ROW + i).toString(16)} `
            + `přepis $${m.mem[ROW + i].toString(16)} != originál $${wantRow[i].toString(16)}`);
        }
      }
    }
    if (bad && !verbose) { break; }
  }
  if (overrun) { overruns++; }
  console.log(`  ${name}: ${compared} z ${rec.frames.length - 1 - begin} snímků, skript ${rec.script}`
    + (overrun ? `, od snímku ${overrun} originál smyčku nestíhá` : '')
    + (stopped ? `, přepis se zastavil na snímku ${stopped} (přechod, prohledávání, počítač nebo výtah)` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchplayer: ${records} záznamů, ${frames} snímků, ${checks} kontrol, `
  + `${diffs} rozdílů`
  + (overruns ? `; v ${overruns} záznamech originál smyčku nestíhá a od toho `
      + `snímku se neměří (disasm_notes.md §19)` : ''));
process.exit(diffs ? 1 : 0);
