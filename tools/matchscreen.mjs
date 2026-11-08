#!/usr/bin/env node
/**
 * matchscreen — obrazovka vykreslená knihovnou proti pixelům emulátoru.
 *
 * Akceptační měřidlo M1. Vezme `data/title.json` (obrazová paměť, Color RAM,
 * znaková sada a registry vytažené z originálu, `tools/mkscreen.py`), nechá
 * ji vykreslit **knihovnou svision** (`C64TextRAM` + `C64Charset`,
 * multicolor znakový režim) a porovná **pixel po pixelu** se snímkem
 * obrazovky z VICE.
 *
 * Porovnává se v **indexech barev**, ne v RGB: VICE i knihovna mají vlastní
 * paletu a ta se smí lišit odstínem, ne obsahem. Paleta VICE se pozná z jeho
 * vlastních `.vpl` souborů tím, že se každý pixel snímku namapuje beze zbytku.
 *
 *     ./tools/matchscreen.mjs [--data data/title.json] [--shot build/run/boot4.png]
 */
import '../app/svision/tools/nodeEnv.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { decodePNG } from '../app/svision/tools/retro/png.mjs';

const { C64TextRAM } = await import('../app/svision/js/platform/canvas2D/c64/c64TextRAM.js');
const { C64Charset } = await import('../app/svision/js/platform/canvas2D/c64/c64Charset.js');
const { C64Color } = await import('../app/svision/js/platform/canvas2D/c64/c64Color.js');
const { C64SpriteData } = await import('../app/svision/js/platform/canvas2D/c64/c64SpriteData.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i+1] : fallback;
};
const dataPath = opt('--data', 'data/title.json');
const shotPath = opt('--shot', 'build/run/title_pal.png');
const verbose = args.includes('--verbose');

const WIDTH = 320, HEIGHT = 200;
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

// ---------------------------------------------------------------- knihovna
// Obrazovka hry je dělená rastrovým přerušením: každý pruh má vlastní
// znakovou sadu a vlastní barvy pozadí (`sources/docs/disasm_notes.md` §6).
// Dokud to knihovna neumí jako data, sešije se to tady po pruzích — a tenhle
// nástroj je zároveň zadání pro tu funkci.
const rgba = new Uint8ClampedArray(WIDTH*HEIGHT*4);

// Obrazovka hry je dělená rastrovým přerušením: každý pruh má vlastní
// znakovou sadu a vlastní barvy pozadí (`sources/docs/disasm_notes.md` §6).
// **Kreslí to knihovna** přes `C64TextRAM.setSplits()` — tenhle nástroj jen
// převede naměřené rastrové řádky na pixelové (obraz začíná na rastru 51).
const FIRST_RASTER = 51;
const text = new C64TextRAM(Uint8Array.from(data.screen), Uint8Array.from(data.colorRAM));
text.setMulticolor(data.multicolor);
text.showCursor(false);

const charsetOf = (addr) => new C64Charset(Uint8Array.from(
  data.charsets ? data.charsets['$' + addr.toString(16).toUpperCase().padStart(4, '0')] : data.charset));

let baseFont;
if (data.splits && data.splits.length) {
  const splits = data.splits.map((split) => ({
    fromLine: Math.max(0, (split.fromRaster || 0) - FIRST_RASTER + (split.fromRaster ? 1 : 0)),
    font: charsetOf(split.charsetAddr),
    background: split.background0, background1: split.background1, background2: split.background2
  }));
  text.setSplits(splits);
  baseFont = splits[0].font;
} else {
  text.setBackground(data.colors.background0);
  text.setSharedColors(data.colors.background1, data.colors.background2);
  baseFont = charsetOf(data.charsetAddr || 0);
}
text.paint(rgba, baseFont, {cursor: false});

// ------------------------------------------------------------- sprajty
// Hardwarové sprajty kreslí `C64SpriteEntity`, ale ta potřebuje canvas.
// Tady se použije **týž dekodér** (`C64SpriteData.decode`) a pixely se
// položí nad obraz, jak to dělá čip: $D01B = 0, tedy sprajty nad pozadím.
const sprites = data.sprites || {};
const blocks = data.spriteBlocks || {};
const drawnSprites = [];
/**
 * Sprajty nad hotové pozadí, od sedmičky dolů — nižší číslo je vepředu.
 * @param {Uint8ClampedArray} target - Obraz, do kterého se kreslí.
 * @param {{x: number[], y: number[], msbX: number}} pos - Poloha sprajtů.
 */
function paintSprites(target, pos) {
for (let i = 7; i >= 0; i--) {
  if (!(sprites.enabled & (1 << i))) continue;
  const block = blocks['sprite' + i];
  if (!block) continue;
  const multicolor = !!(sprites.multicolor & (1 << i));
  const expandX = !!(sprites.expandX & (1 << i));
  const expandY = !!(sprites.expandY & (1 << i));
  const grid = C64SpriteData.decode(Uint8Array.from(block), {multicolor, expandX, expandY});
  const x0 = (pos.x[i] | (((pos.msbX >> i) & 1) << 8)) - 24;
  const y0 = pos.y[i] - 50;
  const own = data.colors.sprites[i];
  const palette = {'1': data.colors.spriteMulti0, '2': own, '3': data.colors.spriteMulti1};
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const key = grid[y][x];
      if (key === '.') continue;
      const px = x0+x, py = y0+y;
      if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;
      const color = C64Color.color(palette[key] === undefined ? own : palette[key]);
      const at = (py*WIDTH+px)*4;
      target[at] = parseInt(color.slice(1, 3), 16);
      target[at+1] = parseInt(color.slice(3, 5), 16);
      target[at+2] = parseInt(color.slice(5, 7), 16);
      target[at+3] = 255;
    }
  }
  if (target === rgba) { drawnSprites.push(i); }
}
}

const background = Uint8ClampedArray.from(rgba);
paintSprites(rgba, sprites);


const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
const libIndex = new Map(Array.from({length: 16}, (_, i) => [C64Color.color(i).toLowerCase(), i]));
/**
 * Obraz na indexy barev knihovny.
 * @param {Uint8ClampedArray} px - RGBA obraz.
 * @returns {Uint8Array} Index barvy na každém pixelu.
 */
function indices(px) {
  const out = new Uint8Array(WIDTH*HEIGHT);
  for (let i = 0; i < WIDTH*HEIGHT; i++) {
    const key = hex(px[i*4], px[i*4+1], px[i*4+2]);
    const idx = libIndex.get(key);
    if (idx === undefined) { console.error(`pixel ${i}: barva ${key} není v paletě knihovny`); process.exit(2); }
    out[i] = idx;
  }
  return out;
}
const ours = indices(rgba);
// ★ druhá varianta: sprajty o půl snímku později (`mkscreen.py`). Co se mezi
// dumpem paměti a snímkem pohnulo, sedí na tuhle — a pixel se počítá za
// rozdílný, jen když nesedí ani jedna.
let oursNext = null;
if (data.spritesNext) {
  const alt = Uint8ClampedArray.from(background);
  paintSprites(alt, data.spritesNext);
  oursNext = indices(alt);
}

// ------------------------------------------------------------------- VICE
const shot = decodePNG(readFileSync(shotPath));
const vplDir = '/usr/share/vice/C64';
const palettes = readdirSync(vplDir).filter(f => f.endsWith('.vpl')).map(f => {
  const rows = readFileSync(`${vplDir}/${f}`, 'utf8').split('\n')
    .map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
    .map(l => l.split(/\s+/).slice(0, 3).map(v => parseInt(v, 16)));
  return {name: f, colors: rows.slice(0, 16)};
}).filter(p => p.colors.length === 16 && p.colors.every(c => c.every(v => Number.isInteger(v))));

function toIndices(px, pal) {
  const map = new Map(pal.colors.map((c, i) => [hex(c[0], c[1], c[2]), i]));
  const out = new Uint8Array(px.width*px.height);
  for (let i = 0; i < out.length; i++) {
    const idx = map.get(hex(px.rgba[i*4], px.rgba[i*4+1], px.rgba[i*4+2]));
    if (idx === undefined) return null;
    out[i] = idx;
  }
  return out;
}

const libPal = {name: 'paleta knihovny (C64Color)',
                colors: Array.from({length: 16}, (_, i) => {
                  const h = C64Color.color(i).replace('#', '');
                  return [0, 2, 4].map(o => parseInt(h.slice(o, o+2), 16));
                })};
let chosen = null, shotIdx = null;
for (const pal of [libPal].concat(palettes)) {
  const got = toIndices(shot, pal);
  if (got) { chosen = pal; shotIdx = got; break; }
}
if (!shotIdx) { console.error('žádná paleta nesedí na snímek beze zbytku — pusť VICE s'
  + ' -VICIIextpal -VICIIpalette pepto-pal -VICIIfilter 0'); process.exit(2); }

// okno 320x200 uvnitř snímku: zkusí se posuny a vezme se nejlepší
let best = null;
for (let dy = 25; dy <= 45; dy++) {
  for (let dx = 24; dx <= 40; dx++) {
    if (dx+WIDTH > shot.width || dy+HEIGHT > shot.height) continue;
    let bad = 0;
    for (let y = 0; y < HEIGHT; y += 4) {
      for (let x = 0; x < WIDTH; x += 4) {
        if (shotIdx[(dy+y)*shot.width+dx+x] !== ours[y*WIDTH+x]) bad++;
      }
    }
    if (!best || bad < best.bad) best = {dx, dy, bad};
  }
}

// sprajty knihovna kreslí jinou entitou, takže se rozdíly uvnitř jejich
// obdélníků počítají zvlášť jako vysvětlené
const spriteBoxes = [];
for (let i = 0; i < 8; i++) {
  if (!(sprites.enabled & (1 << i))) continue;
  const x = (sprites.x[i] | ((sprites.msbX >> i & 1) << 8)) - 24;
  const y = sprites.y[i] - 50;
  const w = 24*((sprites.expandX >> i & 1) ? 2 : 1);
  const h = 21*((sprites.expandY >> i & 1) ? 2 : 1);
  spriteBoxes.push({i, x, y, w, h, bad: 0});
}
const inSprite = (x, y) => {
  const box = spriteBoxes.find((b) => x >= b.x && x < b.x+b.w && y >= b.y && y < b.y+b.h);
  if (box) { box.bad++; }
  return !!box;
};

let diff = 0, spriteDiff = 0, spriteMoved = 0;
const badCells = new Map();
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const a = ours[y*WIDTH+x], b = shotIdx[(best.dy+y)*shot.width+best.dx+x];
    if (a !== b) {
      if (oursNext && oursNext[y*WIDTH+x] === b) { spriteMoved++; continue; }
      if (inSprite(x, y)) { spriteDiff++; continue; }
      diff++;
      const cell = `${(x/8)|0},${(y/8)|0}`;
      badCells.set(cell, (badCells.get(cell) || 0) + 1);
    }
  }
}

console.log(`obraz:   ${dataPath} (${data.source})`);
console.log(`snímek:  ${shotPath} ${shot.width}x${shot.height}, paleta ${chosen.name}, okno +${best.dx}+${best.dy}`);
console.log(`režim:   ${data.multicolor ? 'multicolor' : 'hires'} znakový, pozadí ${data.colors.background0}/${data.colors.background1}/${data.colors.background2}`);
console.log(`pruhy:   ${(data.splits || []).map((s) => `od rastru ${s.fromRaster} sada $${(s.charsetAddr||0).toString(16)}`).join(', ') || 'jeden'} (kreslí C64TextRAM.setSplits)`);
console.log(`sprajty: ${spriteBoxes.length} zapnutých, vykreslených ${drawnSprites.length}`);
console.log(`\nkontrol: ${WIDTH*HEIGHT}   rozdílů mimo sprajty: ${diff}   uvnitř sprajtů: ${spriteDiff}`
  + (oursNext ? `   vysvětlených pohybem o půl snímku: ${spriteMoved}` : ''));
if (spriteDiff && verbose) {
  console.log('rozdíly v obdélnících sprajtů (sprajt → pixelů):');
  for (const b of spriteBoxes) {
    if (b.bad) { console.log(`  sprajt ${b.i} na ${b.x},${b.y}  ${b.bad}`); }
  }
}
if (diff && verbose) {
  const worst = [...badCells.entries()].sort((a, b) => b[1]-a[1]).slice(0, 12);
  console.log('nejhorší buňky (sloupec,řádek → chybných pixelů):');
  for (const [cell, n] of worst) console.log(`  ${cell}  ${n}`);
}
process.exit(diff ? 1 : 0);
