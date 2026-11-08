#!/usr/bin/env node
/**
 * renderroom — místnost do PNG, přesně tou cestou, kterou ji kreslí hra.
 *
 * Tohle není měřidlo, je to **pohled**: postaví místnost stejně jako worker
 * (`app/roomsLoader.js` nad `app/roomBuild.js`), nechá ji vykreslit
 * **knihovnou** (`C64TextRAM` + `C64Charset`, multicolor znakový režim)
 * a sprajty položí nad ni týmž dekodérem jako `tools/matchscreen.mjs`
 * (`C64SpriteData.decode`, `$D01B = 0`). Co z toho vypadne, je to, co má
 * ukázat `app/gameModel.js` v prohlížeči — takže když se obraz v prohlížeči
 * liší, není to v datech ani ve stavbě, ale v modelu nebo v rozvržení.
 *
 *     ./tools/renderroom.mjs                          # místnost 0, vstup zleva
 *     ./tools/renderroom.mjs --room 17 --side 1
 *     ./tools/renderroom.mjs --seed 1                 # nad vylosovanou pevností
 *     ./tools/renderroom.mjs --all -o build/rooms_png # všech 32
 *     ./tools/renderroom.mjs --play --frames 60       # **i s agentem**
 *     ./tools/renderroom.mjs --seed 1 --room 26 --play \
 *         --script 'idle:6,down:12'                    # **jízda výtahem**
 *     ./tools/renderroom.mjs --seed 1 --shaft          # **obrazovka šachty**
 *     ./tools/renderroom.mjs --seed 1 --start          # ★ **start hry**: agent
 *                                                      #   v kabině pod stropem
 *     ./tools/renderroom.mjs --seed 1 --start --intro  # ★ a **po dobu úvodní
 *                                                      #   řeči**: bez panelu
 *
 * ★ `--play` postaví místnost stejně jako zpráva `play` workeru, nechá
 * `app/player.js` odkrokovat zadaný počet snímků a agenta nakreslí ze stroje:
 * ukazatele, bloky, polohu **i barvy a příznaky** (`$D028`, `$D01C`). Tím jde
 * figurku zkontrolovat bez prohlížeče — ukázalo se to potřeba, když vyšla
 * černá a rozsypaná (§13).
 */
import '../app/svision/tools/nodeEnv.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { encodeRGBAPNG } from '../app/svision/tools/retro/png.mjs';

const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');
const { C64TextRAM } = await import('../app/svision/js/platform/canvas2D/c64/c64TextRAM.js');
const { C64Charset } = await import('../app/svision/js/platform/canvas2D/c64/c64Charset.js');
const { C64Color } = await import('../app/svision/js/platform/canvas2D/c64/c64Color.js');
const { C64SpriteData } = await import('../app/svision/js/platform/canvas2D/c64/c64SpriteData.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const outDir = opt('-o', 'build/rooms_png');
const scale = Number(opt('--scale', 2));
const seed = args.indexOf('--seed') >= 0 ? Number(opt('--seed', 1)) : null;
const all = args.includes('--all');
const start = args.includes('--start') || args.includes('--intro');
/**
 * ★ `--end` je **tabule se skóre** (M5, §33): konec hry se odehraje celý —
 * třes, rozpad, rámečky, nadpisy, skóre i síň slávy — a vykreslí se to, na
 * čem zůstane. Kdo chce vidět něco jiného než prázdnou hru, dá `--found
 * 24:07:09`; kdo chce dokončenou misi místo vypršelého času, `--hours 12`.
 */
const end = args.includes('--end');
const play = args.includes('--play') || args.includes('--shaft') || start || end;
const shaft = args.includes('--shaft') || start;
/**
 * ★ `--intro` je **start hry tak, jak vypadá po dobu úvodní řeči**: `$731C`
 * doběhl, ale `$72E5` ani `$B63B` ještě ne, protože `$BF51` čeká na
 * přehrávač (§22). Je to ten obraz, který má hráč před očima 6,4 vteřiny —
 * šachta shora dolů, bez panelu a bez mapy.
 */
const intro = args.includes('--intro');
const frames = Number(opt('--frames', 1));
const joystick = parseInt(opt('--joystick', '7f'), 16);
/**
 * ★ `--script` je `--joystick` pro víc než jednu páku: úseky `jméno:snímky`
 * ve tvaru, který používají záznamy (`tools/traceplayer.py`). Bez něj se na
 * **výtah v místnosti** (§25) mimo prohlížeč nepodíváš — ten potřebuje dojít
 * na sloupec plošin, pustit páku a teprve pak zabrat dolů.
 */
const STICKS = {idle: 0x7F, up: 0x7E, down: 0x7D, left: 0x7B, right: 0x77,
                fire: 0x6F, upfire: 0x6E, downfire: 0x6D};
const script = args.indexOf('--script') >= 0
  ? opt('--script', '').split(',').map((part) => {
      const [token, count] = part.split(':');
      const value = STICKS[token.trim()];
      if (value === undefined) { throw new Error(`neznámá páka ${token}`); }
      return [value, Number(count)];
    })
  : null;

const WIDTH = 320, HEIGHT = 200;

globalThis.self = globalThis;
// ★ kolize sprajtů počítá knihovna (`C64Collision`, R-043) a `plFrame` je
// volá; bez ní by se `--play` rozbilo na prvním snímku
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/roomBuild.js', import.meta.url).pathname);
const roomsLoader = loadClassicScript(new URL('../app/roomsLoader.js', import.meta.url).pathname);
let player = null;
if (play) {
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
loadClassicScript(new URL('../app/terminal.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/robots.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/orb.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/collision.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/death.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/endGame.js', import.meta.url).pathname);
  player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
}

/**
 * ★ Sada, jak ji má **stroj**, ne jak ji má disketa: písmena a číslice
 * v sadě šachty a kapesního počítače se kopírují z **Char ROM** (`$39AA`,
 * §14) a `data/charset_*.json` je vezou zvlášť v `charRom.parts`. Bez nich
 * jsou rámečky prázdné.
 * @param {Object} data - Rozparsovaný `charset_*.json`.
 * @returns {Uint8Array} 2 048 bajtů sady.
 */
function charsetBytes(data) {
  const out = Uint8Array.from(data.bytes);
  for (const part of (data.charRom && data.charRom.parts) || []) {
    const at = part.addr - data.addr;
    for (let i = 0; i < part.bytes.length; i++) { out[at + i] = part.bytes[i] & 0xFF; }
  }
  return out;
}

const rooms = JSON.parse(readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));
const charset = JSON.parse(readFileSync(new URL('../data/charset_room.json', import.meta.url), 'utf8'));
const sprites = JSON.parse(readFileSync(new URL('../data/sprites.json', import.meta.url), 'utf8'));
const byPointer = new Map(Object.values(sprites.blocks).map((b) => [b.pointer, b]));
const globalData = play
  ? JSON.parse(readFileSync(new URL('../data/global.json', import.meta.url), 'utf8'))
  : null;
const furnitureData = play
  ? JSON.parse(readFileSync(new URL('../data/furniture.json', import.meta.url), 'utf8'))
  : null;
const terminalData = play
  ? JSON.parse(readFileSync(new URL('../data/terminal.json', import.meta.url), 'utf8'))
  : null;
const shaftData = play
  ? JSON.parse(readFileSync(new URL('../data/shaft.json', import.meta.url), 'utf8'))
  : null;
const shaftCharsetAll = play
  ? JSON.parse(readFileSync(new URL('../data/charset_shaft.json', import.meta.url), 'utf8'))
  : null;
const shaftCharset = shaft
  ? JSON.parse(readFileSync(new URL('../data/charset_shaft.json', import.meta.url), 'utf8'))
  : null;
const computerCharset = shaft
  ? JSON.parse(readFileSync(new URL('../data/charset_computer.json', import.meta.url), 'utf8'))
  : null;
// ★ Obrazovka šachty je **dělená** (§6): nahoře sada šachty `$4800`, od
// rastru 170 sada kapesního počítače `$5800`, a s ní i jiné barvy pozadí.
// Čísla jsou změřená na běžící hře a vezou se v `data/elevator.json`.
/** ★ tabulky kapesního počítače, a s nimi **legenda mapy** (`$B563`, §34):
 * bez ní prohodí `$B644` do `$5F80` samé nuly a rámeček mapy v panelu zmizí */
const computerData = play
  ? JSON.parse(readFileSync(new URL('../data/computer.json', import.meta.url), 'utf8'))
  : null;
const puzzleData = play
  ? JSON.parse(readFileSync(new URL('../data/puzzle.json', import.meta.url), 'utf8'))
  : null;
const shaftSplits = shaft
  ? JSON.parse(readFileSync(new URL('../data/elevator.json', import.meta.url), 'utf8')).splits
  : null;

/**
 * Paměť pevnosti: buď statická (jak ji má disketa), nebo vylosovaná ze
 * semínka týmiž rutinami, jaké pouští worker.
 * @returns {Uint8Array|undefined} Paměť, nebo nic pro statickou pevnost.
 */
function fortressMemory() {
  if (seed === null) { return undefined; }
  const fortress = JSON.parse(readFileSync(new URL('../data/fortress.json', import.meta.url), 'utf8'));
  loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/fortressMap.js', import.meta.url).pathname);
  const mem = roomsLoader.memory(rooms);
  for (const segment of fortress.segments) {
    const raw = Buffer.from(segment.bytes, 'base64');
    mem.set(raw, segment.at);
  }
  let x = (seed | 0) || 0x1D872B41;
  const random = () => {
    x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
    return (x >>> 24) & 255;
  };
  // ★ `$38D2`-`$3906` — nultá stránka se maže **před** losováním: losování
  // mapy si do ní na konci uloží, kde stojí kabina (`$27`/`$28`), a z toho
  // se kreslí šachta. Po obráceném pořadí vyjde `$1E` na dno a výtah stojí.
  loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
  globalThis.player.resetZeroPage(mem);
  mem[0xEB] = random(); mem[0xEC] = random();
  globalThis.generateFortressMap(mem, random);
  globalThis.generateFortress(mem, random);
  return mem;
}

const memory = fortressMemory();

/**
 * Jeden sprajt do RGBA — tatáž cesta pro místnost i pro agenta.
 * @param {Uint8ClampedArray} rgba - Obraz.
 * @param {number[]|Uint8Array} block - 64 bajtů bloku.
 * @param {Object} how - `{multicolor, expandX, expandY, color, multi0, multi1, x, y}`.
 */
function blit(rgba, block, how) {
  const grid = C64SpriteData.decode(Uint8Array.from(block), how);
  const palette = {'1': how.multi0, '2': how.color, '3': how.multi1};
  const x0 = how.x - C64SpriteData.ORIGIN_X, y0 = how.y - C64SpriteData.ORIGIN_Y;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const key = grid[y][x];
      if (key === '.') { continue; }
      const px = x0+x, py = y0+y;
      if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) { continue; }
      const color = C64Color.color(palette[key] === undefined ? how.color : palette[key]);
      const at = (py*WIDTH+px)*4;
      rgba[at] = parseInt(color.slice(1, 3), 16);
      rgba[at+1] = parseInt(color.slice(3, 5), 16);
      rgba[at+2] = parseInt(color.slice(5, 7), 16);
      rgba[at+3] = 255;
    }
  }
}

/**
 * Jedna místnost do RGBA.
 * @param {number} room - 0-31.
 * @param {number} side - 0 zleva, 1 zprava.
 * @returns {{rgba: Uint8ClampedArray, built: Object, drawn: number}} Obraz a co v něm je.
 */
function render(room, side) {
  const mem = memory ? Uint8Array.from(memory) : undefined;
  const built = roomsLoader.buildRoom(rooms, room, side, mem);
  const rgba = new Uint8ClampedArray(WIDTH*HEIGHT*4);

  // ★ S `--play` se kreslí **to, co by viděl VIC**, ne to, co postavil
  // stavitel: stavitel staví do `$C100`, hra ukazuje `$4000` (§6) a od M3
  // do něj kreslí i běh hry — clona přechodu (§21) a **výtah v místnosti**
  // (§25). Kdo by nechal obrázek na `built.screen`, viděl by agenta sjíždět
  // a plošinu stát na místě (stalo se 2026-09-20).
  let machine = null;
  if (play && mem) {
    machine = {mem, color: Uint8Array.from(built.color), vic: new Uint8Array(0x2F)};
    machine.entropy = () => 0x42;
    player.seedMemory(mem, globalData, sprites, furnitureData, terminalData,
                      null, machine, computerData, puzzleData);
    globalThis.elevator.seedMemory(mem, shaftData);
    // ★ **znaková sada místnosti do paměti stroje** (`$5000`): na stroji tam
    // je z diskety, a prohledávání nábytku do ní zapisuje (§27). Bez toho by
    // okno kreslilo prázdnými glyfy do prázdné místnosti.
    const roomBytes = charsetBytes(charset);
    for (let i = 0; i < roomBytes.length; i++) { mem[0x5000 + i] = roomBytes[i]; }
    // ★ a **sada šachty** na `$4800`: na ni se přepíná bezpečnostní terminál
    // (§29), vlastní sadu žádnou nemá
    if (shaftCharsetAll) {
      const shaftBytes = charsetBytes(shaftCharsetAll);
      for (let i = 0; i < shaftBytes.length; i++) { mem[0x4800 + i] = shaftBytes[i]; }
    }
    // ★ `--start`: hra **začíná v šachtě** (`$3960`-`$3A12`), ne v místnosti
    if (start) { player.startShaft(machine, intro); }
    else { player.startRoom(machine, room, side); }
    if (script) {
      for (const [value, count] of script) {
        for (let f = 0; f < count; f++) { player.frame(machine, value, 1); }
      }
    } else {
      // ★ S `--intro` **hlavní smyčka neběží** (`$3A15` je až za `$3A12`),
      // takže se tiká jen obsluha přerušení — jinak by `$73E4` posunulo
      // značku kabiny dřív, než `$B6FE` postaví její blok, a sprajt 6 by
      // se kreslil obrazovkou místo obrázku (§22)
      for (let f = 0; f < frames; f++) { player.frame(machine, joystick, intro ? 0 : 1); }
    }
    if (shaft) { return renderShaft(machine); }
    // ★ **Konec hry** (§33): hodiny se posadí na šestou, `$43` dostane `$FF`
    // a `endGame.end` odehraje třes, rozpad i tabuli. Je to jediná cesta, jak
    // se na tabuli podívat, aniž by se hrálo sedm hodin.
    if (end) {
      const endData = JSON.parse(
        readFileSync(new URL('../data/end.json', import.meta.url), 'utf8'));
      const found = opt('--found', '0:0:0').split(':').map((x) => parseInt(x, 16));
      machine.mem[0xD6] = found[0] | 0;
      machine.mem[0xD7] = found[1] | 0;
      machine.mem[0xD8] = found[2] | 0;
      machine.mem[0xD4] = parseInt(opt('--hours', '06'), 16);
      machine.mem[0xD3] = parseInt(opt('--minutes', '00'), 16);
      machine.mem[0xD2] = parseInt(opt('--seconds', '00'), 16);
      globalThis.endGame.blankFame(machine);
      globalThis.endGame.end(machine, endData, () => 0x42,
                             opt('--name', 'agent').toLowerCase().split('')
                               .map((c) => 0x71 + (c.charCodeAt(0) - 97)));
      return renderBoard(machine);
    }
  }
  const shownScreen = machine
    ? Uint8Array.from(mem.subarray(player.SCREEN, player.SCREEN + 1000))
    : Uint8Array.from(built.screen);
  const shownColor = machine
    ? Uint8Array.from(machine.color.subarray(0, 1000), (v) => v & 0x0F)
    : Uint8Array.from(built.color);
  const text = new C64TextRAM(shownScreen, shownColor);
  // ★ A **barvy pozadí taky ze stroje**, když se hraje: bezpečnostní terminál
  // si je celé přenastaví (§29) a pak vrátí, takže z postavené místnosti by
  // vyšly ty její — a terminál by byl v barvách místnosti.
  text.setMulticolor(machine ? !!(machine.vic[0x16] & 0x10) : true);
  text.setBackground(machine ? machine.vic[0x21] & 0x0F : built.colors.background0);
  text.setSharedColors(
    machine ? machine.vic[0x22] & 0x0F : built.colors.background1,
    machine ? machine.vic[0x23] & 0x0F : built.colors.background2);
  text.showCursor(false);
  // ★ A **znaková sada taky ze stroje**, když se hraje: prohledávání nábytku
  // (§27) nekreslí okno jako obrázek, ono **přepisuje glyfy** `$00`-`$1F` na
  // `$5000`. Kdo by sázel sadu ze souboru, uvidí agenta stát a okno nikdy.
  // ★ A **kterou sadu**, říká `$D018`: `$05` je místnost (`$5000`), `$03`
  // šachta a terminál (`$4800`), `$07` kapesní počítač (`$5800`) — §6, §29.
  const setAt = machine ? 0x4000 + (((machine.vic[0x18] & 0x0E) >> 1) * 2048) : 0;
  const shownCharset = machine
    ? Uint8Array.from(mem.subarray(setAt, setAt + 2048))
    : charsetBytes(charset);
  text.paint(rgba, new C64Charset(shownCharset), {cursor: false});

  // ★ A totéž platí o sprajtech, co o obrazu: s `--play` se berou **ze
  // stroje**, ne ze stavitele. Od M4 se koule a roboti hýbou tím, že píšou
  // registry VIC (§24), takže kdo je nakreslí z `built`, uvidí je pořád tam,
  // kde je stavitel postavil — a sprajt, který hra zhasla, uvidí svítit.
  const regs = machine
    ? {enabled: machine.vic[0x15], multicolor: machine.vic[0x1C],
       expandX: machine.vic[0x1D], expandY: machine.vic[0x17],
       msbX: machine.vic[0x10],
       x: (i) => machine.vic[i*2], y: (i) => machine.vic[i*2 + 1],
       pointer: (i) => mem[0x43F8 + i], color: (i) => machine.vic[0x27 + i] & 0x0F}
    : {enabled: built.sprites.enabled, multicolor: built.sprites.multicolor,
       expandX: built.sprites.expandX, expandY: built.sprites.expandY,
       msbX: built.sprites.msbX,
       x: (i) => built.sprites.x[i], y: (i) => built.sprites.y[i],
       pointer: (i) => built.spritePointers[i], color: (i) => built.colors.sprites[i]};

  // sprajty od sedmičky dolů, tedy nižší číslo vepředu ($D01B = 0)
  let drawn = 0;
  for (let i = 7; i >= 0; i--) {
    if (i >= 1 && i <= 3 && machine) { continue; }   // agenta kreslí `--play` níž
    if (!(regs.enabled & (1 << i))) { continue; }
    const block = byPointer.get(regs.pointer(i));
    if (!block) { continue; }                       // agent: ukazatel plyne z jeho stavu (M3)
    drawn++;
    drawn++;
    blit(rgba, block.bytes, {
      multicolor: !!(regs.multicolor & (1 << i)),
      expandX: !!(regs.expandX & (1 << i)),
      expandY: !!(regs.expandY & (1 << i)),
      color: regs.color(i),
      multi0: built.colors.spriteMulti0, multi1: built.colors.spriteMulti1,
      x: regs.x(i) | (((regs.msbX >> i) & 1) << 8),
      y: regs.y(i)
    });
  }

  // ★ `--play`: agent se do místnosti postaví a odkrokuje se krokem
  // originálu; kreslí se přesně tím, co o sobě `player.view()` říká
  let agent = null;
  if (machine) {
    agent = player.view(machine);
    for (let i = 2; i >= 0; i--) {
      if (!(agent.enabled & (1 << (i + 1)))) { continue; }
      blit(rgba, agent.sprites.blocks[i], {
        multicolor: !!(agent.multicolor & (1 << (i + 1))),
        expandX: !!(agent.expandX & (1 << (i + 1))),
        expandY: !!(agent.expandY & (1 << (i + 1))),
        color: agent.sprites.color[i],
        multi0: agent.shared[0], multi1: agent.shared[1],
        x: agent.sprites.x[i], y: agent.sprites.y[i]
      });
    }
  }
  return {rgba, built, drawn, agent};
}

/**
 * ★ Obrazovka **šachty** z paměti stroje: postavil ji `app/shaftBuild.js`
 * (§22) a leží tam, kde ji nechal originál — znaky na `$4000`, barvy
 * v Color RAM, sada šachty `$4800`. Kreslí se stejnou cestou jako místnost,
 * jen jinou sadou.
 * @param {Object} machine - Stroj po dokončeném přechodu.
 * @returns {{rgba: Uint8ClampedArray, built: Object, drawn: number, agent: Object}} Obraz.
 */
/**
 * Tabule se skóre, jak ji ukazuje VIC: obrazovka `$4000`, barvy z `$D800`
 * a **sada šachty** (`$D018` = `$02`, §33), se kterou se tabule kreslí.
 * @param {Object} machine - Stroj po `endGame.end`.
 * @returns {Object} To, co `render` vrací.
 */
function renderBoard(machine) {
  const rgba = new Uint8ClampedArray(WIDTH*HEIGHT*4);
  const screen = Uint8Array.from(machine.mem.subarray(0x4000, 0x43E8));
  const colour = Uint8Array.from(machine.color.subarray(0, 1000), (c) => c & 0x0F);
  const text = new C64TextRAM(screen, colour);
  const set = new C64Charset(charsetBytes(shaftCharsetAll));
  text.setMulticolor(!!(machine.vic[0x16] & 0x10));
  text.setBackground(machine.vic[0x21] & 0x0F);
  text.setSharedColors(machine.vic[0x22] & 0x0F, machine.vic[0x23] & 0x0F);
  text.showCursor(false);
  text.paint(rgba, set, {cursor: false});
  // ★ sprajty na tabuli **nejsou** (`$B788 STA $D015` s nulou), takže se
  // nekreslí ani jeden — a kdyby se přesto objevily, je to vada
  return {rgba, built: {furniture: 0, robots: 0,
                        sprites: {enabled: machine.vic[0x15]}, codeRoom: false},
          drawn: 0, agent: null};
}

function renderShaft(machine) {
  const rgba = new Uint8ClampedArray(WIDTH*HEIGHT*4);
  const screen = Uint8Array.from(machine.mem.subarray(0x4000, 0x43E8));
  const colour = Uint8Array.from(machine.color.subarray(0, 1000), (c) => c & 0x0F);
  const text = new C64TextRAM(screen, colour);
  // ★ i tady sady **z Char ROM**, ne z diskety (§14) — bez toho je šachta
  // bez textu stejně jako byl terminál
  // ★ A okno sady počítače (`$5C50`-`$5FAF`) **ze stroje**, ne z diskety:
  // je v něm obrázek mapy pevnosti, který se losuje (`$B644`, §14) — na
  // disketě jsou ty glyfy prázdné a mapa v panelu by byla samý plný čtverec
  const computerBytes = charsetBytes(computerCharset);
  for (let i = 0; i < 6*0x90; i++) { computerBytes[0x450 + i] = machine.mem[0x5C50 + i]; }
  const sets = {18432: new C64Charset(charsetBytes(shaftCharset)),
                22528: new C64Charset(computerBytes)};
  // ★ **Pruhy dělá clona, a ta za úvodní řečí neběží**: ve vektoru je
  // `$838C`, obsluha, která jen zvedne `$E0` (`$391E` ≺ `$BF3A`), takže je
  // obrazovka celá jednou sadou a jednou barvou pozadí — a panel na ní
  // ještě není (§22)
  const split = (machine.mem[0xFFFE] | (machine.mem[0xFFFF] << 8)) !== 0x838C;
  text.setMulticolor(true);
  text.setBackground(split ? shaftSplits[0].background0 : machine.vic[0x21] & 0x0F);
  text.setSharedColors(split ? shaftSplits[0].background1 : machine.vic[0x22] & 0x0F,
                       split ? shaftSplits[0].background2 : machine.vic[0x23] & 0x0F);
  text.setSplits(split ? shaftSplits.map((s) => ({
    fromLine: Math.max(0, s.fromRaster - 50), font: sets[s.charsetAddr],
    background: s.background0, background1: s.background1,
    background2: s.background2
  })) : null);
  text.showCursor(false);
  text.paint(rgba, sets[split ? shaftSplits[0].charsetAddr : 18432], {cursor: false});
  const agent = player.view(machine);
  let drawn = 0;
  for (let i = 7; i >= 0; i--) {
    // ★ A **bloky, které na disketě nejsou**: značku kabiny na mapě staví
    // `$B6FE` za běhu do `$4D80` (blok `$36`), takže ji `data/sprites.json`
    // nemá a bere se ze stroje
    const ptr = machine.mem[0x43F8 + i];
    const known = byPointer.get(ptr);
    const bytes = known ? known.bytes
      : machine.mem.subarray(0x4000 + ptr*64, 0x4000 + ptr*64 + 64);
    if (!(agent.enabled & (1 << i))) { continue; }
    drawn++;
    blit(rgba, bytes, {
      multicolor: !!(machine.vic[0x1C] & (1 << i)),
      expandX: !!(machine.vic[0x1D] & (1 << i)),
      expandY: !!(machine.vic[0x17] & (1 << i)),
      color: machine.vic[0x27 + i] & 0x0F,
      multi0: machine.vic[0x25] & 0x0F, multi1: machine.vic[0x26] & 0x0F,
      x: machine.vic[i*2] | (((machine.vic[0x10] >> i) & 1) << 8),
      y: machine.vic[i*2 + 1]
    });
  }
  return {rgba, built: {furniture: 0, robots: 0, sprites: {enabled: agent.enabled},
                        codeRoom: false}, drawn, agent};
}

mkdirSync(outDir, {recursive: true});
const list = all ? Array.from({length: 32}, (_, i) => [i, Number(opt('--side', 0))])
                 : [[Number(opt('--room', 0)), Number(opt('--side', 0))]];
for (const [room, side] of list) {
  const {rgba, built, drawn, agent} = render(room, side);
  const name = end ? `${outDir}/end.png`
    : shaft ? `${outDir}/shaft.png`
    : `${outDir}/room${String(room).padStart(2, '0')}${side ? 'r' : 'l'}.png`;
  writeFileSync(name, encodeRGBAPNG(WIDTH, HEIGHT, rgba, scale));
  console.log(`${name}: ${built.furniture} kusů nábytku, ${built.robots} robotů, `
    + `${drawn} sprajtů vykreslených z ${built.sprites.enabled.toString(2)}`
    + `${built.codeRoom ? ', kódová místnost' : ''}`
    + `${seed === null ? '' : `, semínko ${seed}`}`
    + `${agent ? `, agent: stav $${agent.state.toString(16)}, barvy `
        + `${agent.sprites.color.join('/')}, ${agent.multicolor & 0x0E ? 'MULTICOLOR' : 'hires'}`
        : ''}`);
}
