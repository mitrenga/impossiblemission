#!/usr/bin/env node
/**
 * matchspecial — **dvě zvláštní místnosti** přepsané proti originálu
 * (`sources/docs/disasm_notes.md` §35).
 *
 * Nábytek, který drží `$FB`, je **kódová místnost** `$A771` (v pevnosti
 * jsou dvě, `$11` a `$1B`), a který drží `$FE`, je **řídicí** `$AA40`
 * (jedna, místnost 5). Obojí běží s puštěnou obsluhou přerušení, takže
 * jednotkou je **snímek** — jako u kapesního počítače (§34).
 *
 * Srovnává se:
 *
 * - **deska** `$A8BE`, třicet dva políček, a **šestnáct zamíchaných tónů**
 *   `$B21F` — z toho plyne, že míchačka jde krok za krokem se strojem;
 * - **panel šachty** `$3430`-`$3470`, do kterého kódová místnost při výhře
 *   přidá jedno počitadlo (a řídicí v něm čte devět písmen hesla);
 * - **obrazovka** `$4000`-`$43FF` a barevná paměť — tedy i konzole řídicí
 *   místnosti a blikání, které si bere náhodu ze `$84EA`;
 * - **obrázek řídicí místnosti** `$C000`-`$C3FF`, který se do banky 3
 *   kopíruje zpod I/O (`$71FB`);
 * - **sprajtový blok** `$4D80`, nultá stránka a registry VIC.
 *
 *     ./tools/matchspecial.mjs [--dir build/special] [--name code11a]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/special');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const file of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild',
                    'transition', 'roomLift', 'furniture', 'terminal',
                    'pocketComputer', 'codeRoom', 'controlRoom',
                    'robots', 'orb', 'collision', 'death']) {
  loadClassicScript(new URL(`../app/${file}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);

/** nultá stránka, na které obě místnosti stojí */
const WATCHED = [
  [0x10, 'kreslicí lo'], [0x11, 'kreslicí hi'],
  [0x14, 'barevná lo'], [0x15, 'barevná hi'],
  [0x18, 'ukazatel lo'], [0x19, 'ukazatel hi'],
  [0x74, 'úroveň'], [0x75, 'úroveň $11'], [0x76, 'úroveň $1B'],
  [0x77, 'běh'], [0x78, 'poslední tón'], [0x7E, 'místnost'],
  [0xA0, 'mez nahoru'], [0xA1, 'mez dolů'], [0xA2, 'mez doleva'], [0xA3, 'mez doprava'],
  [0xA4, 'doznívání zvuku'],
  [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xDC, 'mise hotová'], [0xDE, 'západka střelby'], [0xE0, 'čítač snímků'],
  [0xE1, 'posuvný registr'], [0xE3, 'druhý posuvný registr'],
  [0xE4, 'pracovní'], [0xE5, 'pracovní'],
  [0xEB, 'míchačka lo'], [0xEC, 'míchačka hi'],
];

/**
 * ★ **Co se po prvním snímku dosadí ze záznamu.** Výpis číslo nula se bere
 * **na vstupu do místnosti** (`$A771`, `$AA40`), ne na `$8361` jako všechny
 * ostatní — bez něj by přepis začal až za zamícháním šestnácti tónů a za
 * rozházením desky a míchačka by se rozešla hned. Jenže vstup do místnosti
 * není okamžik obsluhy přerušení: mezi ním a prvním `$8361` stroj obsluhu
 * **nedoběhl** (`$8361 INC $E0` se teprve chystá), zatímco přepis ji dělá
 * celou. Účetnictví obsluhy se proto jednou dosadí a od druhého snímku
 * jdou obě strany krok za krokem.
 */
const RESYNC = [0xD1, 0xD2, 0xD3, 0xD4, 0xE0, 0xE1, 0xE3, 0xA4];

/** bloky, které se srovnávají celé */
const BLOCKS = [
  ['panel', 0x3430, 'panel šachty', 0xFF],
  ['tones', 0xB21F, 'šestnáct zamíchaných tónů', 0xFF],
  ['board', 0xA8BE, 'deska třiceti dvou políček', 0xFF],
  ['blocks', 0x4D80, 'sprajtový blok', 0xFF],
  ['screen', 0x4000, 'obrazovka', 0xFF],
  ['picture', 0xC000, 'obrázek řídicí místnosti', 0xFF],
];

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
/** ★ pokrytí: co záznamy aspoň jednou udělaly */
const seen = {codeOpen: 0, tone: 0, click: 0, won: 0, gaveUp: 0,
              controlRefused: 0, controlOpen: 0, picture: 0, spoke: 0, board: 0};

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
  m.noRobots = true;
  m.noCollision = true;

  const first = rec.frames[0];
  const firstZp = bytes(first.zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = firstZp[i]; }
  for (const [block, base] of BLOCKS) {
    if (!first[block]) { continue; }
    const want = bytes(first[block]);
    for (let i = 0; i < want.length; i++) { m.mem[base + i] = want[i]; }
  }
  const firstColor = bytes(first.color);
  for (let i = 0; i < firstColor.length; i++) { m.color[i] = firstColor[i] & 0x0F; }
  const firstVic = bytes(first.vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  // ★ **Záznam je jen ta jedna rutina.** `tracespecial.py` do ní skáče
  // rovnou (`r pc=$A771`), takže hlavní smyčka neběží a prohledávání
  // nábytku, které by ji ve hře otevřelo, tu není — proto se pouští
  // `player.frame` s **nulou průchodů**, tedy sama obsluha přerušení,
  // a místnost se krokuje vedle ní. Že ji nábytek opravdu otevře, hlídá
  // `tools/runworker.mjs`.
  m.pl = {deathFall: false, liftWait: 0, riding: 0, move: null,
          roomRide: null, search: null, dying: null, computer: null};
  const source = () => entropy;
  let room = null, roomDone = false, speaking = false;
  if (rec.control) {
    room = globalThis.controlRoom.start(m, source);
    if (room.done) { seen.controlRefused++; roomDone = true; } else { seen.controlOpen++; }
  } else {
    room = globalThis.codeRoom.start(m, source);
    seen.codeOpen++;
  }

  // ★ jeden snímek **za** místností se ještě srovnává: u řídicí, která
  // odmítne, je to jediný důkaz, že se opravdu nestalo nic
  // ★ Jeden snímek **za** místností se srovnává jen tam, kde se místnost
  // ani neotevřela: u řídicí, která odmítne, je to jediný důkaz, že se
  // opravdu nestalo nic. Jinde už záznam měří hru za ní, ne ji.
  let bad = 0, compared = 0, skipped = 0, skip = 0, why = '';
  let tail = roomDone ? 1 : 0;
  for (let f = 0; f + 1 < rec.frames.length; f++) {
    const board = m.mem[0x77], level = m.mem[0x74];
    const joy = stick[f] === undefined ? 0x7F : stick[f];
    // ★ Od `$AB23` je vektor IRQ `$838C`, a ta tiká **jen `$E0`** (§35) —
    // hodiny stojí, zvuk nedoznívá, posuvné registry robotů se nehýbou
    let out;
    if (speaking) {
      m.mem[0xE0] = (m.mem[0xE0] + 1) & 0xFF;            // `$00FC INC $E0`
      out = {};
    } else {
      out = player.frame(m, joy, 0);                     // jen obsluha přerušení
    }
    if (!roomDone) {
      const step = rec.control ? globalThis.controlRoom.frame(m, room)
                               : globalThis.codeRoom.frame(m, room, joy);
      if (step.speech !== undefined) { out.speech = step.speech; }
      if (step.gameOver) { out.gameOver = 1; }
      if (step.speaking) { speaking = true; }
      // ★ `overrun` řídicí místnosti se **nepřeskakuje**: rastrové přerušení
      // se sice po dobu `SEI` neudělá, ale zůstane **čekat** v latchi `$D019`
      // a `$BF6A CLI` ho pustí hned — takže se tik `$E0` neztratí (změřeno)
      if (step.done) { roomDone = true; }
    } else if (tail-- <= 0) {
      // ★ **Za místností už záznam není o ní.** `$A8B1 RTS` (a u řídicí
      // `$AB64 JMP $B77C`) vede jinam a harness tam položil vrchol smyčky
      // šachty, takže od té chvíle běží hra dál — a to měří jiná měřidla.
      why = 'místnost skončila';
      break;
    }
    if (m.mem[0x77] !== board) { seen.click++; }
    if (out.speech !== undefined) { seen.spoke++; }
    if (out.gameOver) { seen.board++; }
    if (m.mem[0x74] !== level) { seen.won++; }
    if (m.vic[0x15] & 0x01) { seen.tone++; }
    if (m.mem[0xC000] !== 0 && rec.control) { seen.picture = 1; }
    if (out.overrun) { skip = 2; }
    // ★ `$AB64 JMP $B77C` — od téhle chvíle je v záznamu **tabule se skóre**,
    // a tu měří `tools/matchend.mjs` (§33), ne tohle
    if (out.gameOver) { why = 'tabule se skóre'; break; }
    if (skip > 0) { skip--; skipped++; continue; }
    if (f === 0) {
      const sync = bytes(rec.frames[1].zp);
      for (const addr of RESYNC) { m.mem[addr] = sync[addr]; }
    }

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
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== wantZp[addr]) { say(`${label} ($${addr.toString(16)})`, m.mem[addr], wantZp[addr]); }
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
      if ((m.color[i] & 0x0F) !== (wantColor[i] & 0x0F)) {
        say(`barva $${(0xD800 + i).toString(16)}`, m.color[i] & 0x0F, wantColor[i] & 0x0F);
      }
    }
    for (const [block, base, label, mask] of BLOCKS) {
      if (!want[block]) { continue; }
      const wantBlock = bytes(want[block]);
      for (let i = 0; i < wantBlock.length; i++) {
        checks++;
        if ((m.mem[base + i] & mask) !== (wantBlock[i] & mask)) {
          say(`${label} $${(base + i).toString(16)}`, m.mem[base + i] & mask, wantBlock[i] & mask);
        }
      }
    }
    if (bad && !verbose) { why = 'rozdíl'; break; }
  }
  if (m.cr && m.cr.gaveUp) { seen.gaveUp++; }
  console.log(`${name}: ${compared} snímků`
    + `${skipped ? ` (+${skipped} přeskočených na rozdělané práci)` : ''}`
    + `${why ? ' (' + why + ')' : ''}, ${bad} rozdílů`);
}

const cover = Object.keys(seen).filter((k) => seen[k] > 0);
console.log(`matchspecial: ${records} záznamů, ${frames} snímků, `
  + `${checks} kontrol, ${diffs} rozdílů`);
console.log(`  pokrytí: ${cover.length} z ${Object.keys(seen).length} — `
  + Object.keys(seen).map((k) => `${k} ${seen[k]}`).join(', '));
process.exit(diffs ? 1 : 0);
